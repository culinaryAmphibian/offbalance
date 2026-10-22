// Drives each job through the contract's deadline-gated phases. The contract has no timers, so
// when a phase starts the server waits out its window (in chain time) and calls the transition:
//   COMMIT_PHASE_START   -> startRevealPhase  after commitDeadline
//   REVEAL_PHASE_START   -> endRevealPhase    after revealDeadline (consensus; NO_QUORUM ends here)
//   DELIVERY_PHASE_START -> endDeliveryPhase  after deliveryDeadline (payout)
// Each transition's own event schedules the next one. The functions are public, so if anyone
// else gets there first the call reverts with "Not in ... phase" and the job is left alone.
import type { ChainEvent, Deadlines } from "./chain.ts";
import { errorMessage } from "./chain.ts";

export type PhaseChain = {
	startRevealPhase(jobId: number): Promise<void>;
	endRevealPhase(jobId: number): Promise<void>;
	endDeliveryPhase(jobId: number): Promise<void>;
	getDeadlines(jobId: number): Promise<Deadlines>;
	chainTime(): Promise<bigint>;
};

type Step = { call: "startRevealPhase" | "endRevealPhase" | "endDeliveryPhase"; deadline: keyof Deadlines };

const STEPS: Record<string, Step> = {
	COMMIT_PHASE_START: { call: "startRevealPhase", deadline: "commitDeadline" },
	REVEAL_PHASE_START: { call: "endRevealPhase", deadline: "revealDeadline" },
	DELIVERY_PHASE_START: { call: "endDeliveryPhase", deadline: "deliveryDeadline" },
};

// the job is over; nothing left to drive
const FINAL_EVENTS = new Set(["NO_QUORUM", "DELIVERED", "CANCELED"]);

const MAX_BACKOFF_MS = 30_000;

type Timers = {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

type Logger = Pick<Console, "log" | "warn" | "error">;

export class Orchestrator {
	private readonly chain: PhaseChain;
	private readonly timers: Timers;
	private readonly log: Logger;
	// one pending step per job; the generation lets a newer event cancel older in-flight work
	private readonly pending = new Map<number, { generation: number; timer?: unknown }>();
	private readonly inflight = new Set<Promise<void>>();
	private generation = 0;
	private stopped = false;

	constructor(chain: PhaseChain, {
		timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) },
		log = console,
	}: { timers?: Timers; log?: Logger } = {}) {
		this.chain = chain;
		this.timers = timers;
		this.log = log;
	}

	onEvent(event: ChainEvent): void {
		if (this.stopped) return;
		const jobId = Number(event.args.jobId);
		if (!Number.isSafeInteger(jobId)) return;
		const step = STEPS[event.name];
		if (step) {
			const generation = this.claim(jobId);
			this.track(this.schedule(jobId, step, generation, 0));
		} else if (FINAL_EVENTS.has(event.name)) {
			this.clear(jobId);
		}
	}

	/** Pending job ids, for logging and tests. */
	get scheduled(): number[] {
		return [...this.pending.keys()];
	}

	/** Resolves once no chain call or scheduling is in progress (timers may still be waiting). */
	async idle(): Promise<void> {
		while (this.inflight.size) await Promise.allSettled([...this.inflight]);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const jobId of [...this.pending.keys()]) this.clear(jobId);
		await this.idle();
	}

	private claim(jobId: number): number {
		this.clear(jobId);
		const generation = ++this.generation;
		this.pending.set(jobId, { generation });
		return generation;
	}

	private clear(jobId: number): void {
		const entry = this.pending.get(jobId);
		if (entry?.timer !== undefined) this.timers.clearTimeout(entry.timer);
		this.pending.delete(jobId);
	}

	private current(jobId: number, generation: number): boolean {
		return !this.stopped && this.pending.get(jobId)?.generation === generation;
	}

	private track(work: Promise<void>): void {
		const tracked = work.catch(error => this.log.error("Orchestrator:", errorMessage(error))).finally(() => this.inflight.delete(tracked));
		this.inflight.add(tracked);
	}

	private wait(jobId: number, generation: number, ms: number, then: () => Promise<void>): void {
		const entry = this.pending.get(jobId);
		if (!entry || entry.generation !== generation) return;
		entry.timer = this.timers.setTimeout(() => {
			if (this.current(jobId, generation)) this.track(then());
		}, ms);
	}

	// Sleep until the step's deadline has passed in chain time, then run it.
	private async schedule(jobId: number, step: Step, generation: number, failures: number): Promise<void> {
		let ms: number;
		try {
			const [deadlines, now] = await Promise.all([this.chain.getDeadlines(jobId), this.chain.chainTime()]);
			// the contract requires block.timestamp > deadline, so aim one second past it
			ms = Math.max(0, Number(deadlines[step.deadline] - now + 1n)) * 1000;
		} catch (error) {
			this.log.warn(`Job ${jobId}: reading deadlines failed (${errorMessage(error)}); retrying`);
			this.wait(jobId, generation, backoff(failures), () => this.schedule(jobId, step, generation, failures + 1));
			return;
		}
		if (!this.current(jobId, generation)) return;
		this.log.log(`Job ${jobId}: ${step.call} in ${ms / 1000}s`);
		this.wait(jobId, generation, ms, () => this.run(jobId, step, generation, failures));
	}

	private async run(jobId: number, step: Step, generation: number, failures: number): Promise<void> {
		try {
			await this.chain[step.call](jobId);
			this.log.log(`Job ${jobId}: ${step.call} done`);
			// the event it emits schedules the next step; until then nothing is pending
			if (this.current(jobId, generation)) this.pending.delete(jobId);
		} catch (error) {
			const reason = errorMessage(error);
			if (/not ended/i.test(reason)) {
				// chain time hasn't passed the deadline yet; look again from fresh chain time
				await this.schedule(jobId, step, generation, failures);
			} else if (/Not in .* phase/i.test(reason)) {
				this.log.log(`Job ${jobId}: ${step.call} skipped, the job already moved on`);
				if (this.current(jobId, generation)) this.pending.delete(jobId);
			} else {
				this.log.warn(`Job ${jobId}: ${step.call} failed (${reason}); retrying`);
				this.wait(jobId, generation, backoff(failures), () => this.run(jobId, step, generation, failures + 1));
			}
		}
	}
}

function backoff(failures: number): number {
	return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures);
}
