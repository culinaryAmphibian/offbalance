// Reconstruct timers from durable job IDs and the contract's current phase. Events only
// wake reconciliation: replayed events never select an old phase or undo a terminal job.
import type { ChainEvent, Deadlines } from "./chain.ts";
import { errorMessage } from "./chain.ts";

export type PhaseChain = {
	startRevealPhase(jobId: number): Promise<void>;
	endRevealPhase(jobId: number): Promise<void>;
	endDeliveryPhase(jobId: number): Promise<void>;
	getDeadlines(jobId: number): Promise<Deadlines>;
	chainTime(): Promise<bigint>;
};

type Step = { call: "startRevealPhase" | "endRevealPhase" | "endDeliveryPhase"; deadline: "commitDeadline" | "revealDeadline" | "deliveryDeadline" };
const STEPS: Record<number, Step> = {
	2: { call: "startRevealPhase", deadline: "commitDeadline" },
	3: { call: "endRevealPhase", deadline: "revealDeadline" },
	5: { call: "endDeliveryPhase", deadline: "deliveryDeadline" },
};
const WAKE_EVENTS = new Set(["JOB_SUBMITTED", "PROVIDER_SELECTED", "COMMIT_PHASE_START", "REVEAL_PHASE_START", "DELIVERY_PHASE_START", "NO_QUORUM", "DELIVERED", "CANCELED"]);
const TERMINAL = new Set([6, 7, 8, 9]);
const POLL_MS = 30_000;
type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
type Entry = { timer?: unknown; work?: Promise<void>; again: boolean; failures: number };
type Logger = Pick<Console, "log" | "warn" | "error">;

export class Orchestrator {
	private readonly chain: PhaseChain;
	private readonly timers: Timers;
	private readonly log: Logger;
	private readonly pending = new Map<number, Entry>();
	private readonly inflight = new Set<Promise<void>>();
	private discoveryTimer?: unknown;
	private started = false;
	private stopped = false;

	constructor(chain: PhaseChain, {
		timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) },
		log = console,
	}: { timers?: Timers; log?: Logger } = {}) {
		this.chain = chain;
		this.timers = timers;
		this.log = log;
	}

	/** Rediscover durable unfinished jobs on startup and while events/RPCs are unavailable. */
	async start(loadJobIds: () => Promise<number[]>): Promise<void> {
		if (this.started || this.stopped) throw new Error("Orchestrator cannot be started twice or after stop.");
		this.started = true;
		const discover = async (failures = 0): Promise<void> => {
			try {
				const ids = await loadJobIds();
				if (this.stopped) return;
				await this.recover(ids);
				failures = 0;
			} catch (error) {
				this.log.warn("Phase recovery discovery failed; retrying:", errorMessage(error));
				failures++;
			}
			if (!this.stopped) this.discoveryTimer = this.timers.setTimeout(() => {
				this.track(discover(failures));
			}, failures ? backoff(failures - 1) : POLL_MS);
		};
		await this.track(discover());
	}

	async recover(jobIds: Iterable<number>): Promise<void> {
		await Promise.all([...jobIds].map(jobId => this.wake(jobId)));
	}

	onEvent(event: ChainEvent): void {
		if (WAKE_EVENTS.has(event.name)) this.wake(Number(event.args.jobId));
	}

	get scheduled(): number[] { return [...this.pending.keys()]; }

	async idle(): Promise<void> {
		while (this.inflight.size) await Promise.allSettled([...this.inflight]);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.discoveryTimer !== undefined) this.timers.clearTimeout(this.discoveryTimer);
		for (const entry of this.pending.values()) this.cancelTimer(entry);
		this.pending.clear();
		await this.idle();
	}

	private track(work: Promise<void>): Promise<void> {
		const tracked = work.catch(error => this.log.error("Orchestrator:", errorMessage(error))).finally(() => this.inflight.delete(tracked));
		this.inflight.add(tracked);
		return tracked;
	}

	private cancelTimer(entry: Entry): void {
		if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
		delete entry.timer;
	}

	private wake(jobId: number): Promise<void> {
		if (this.stopped || !Number.isSafeInteger(jobId) || jobId < 0) return Promise.resolve();
		let entry = this.pending.get(jobId);
		if (!entry) {
			entry = { again: false, failures: 0 };
			this.pending.set(jobId, entry);
		}
		this.cancelTimer(entry);
		// Serialize reads and writes for this job. An event arriving during a transaction
		// requests a fresh read after it settles, never another concurrent submission.
		if (entry.work) { entry.again = true; return entry.work; }
		const current = entry;
		entry.work = this.track(this.reconcile(jobId, entry).finally(() => {
			delete current.work;
			if (current.again && this.pending.get(jobId) === current) {
				current.again = false;
				this.wake(jobId);
			}
		}));
		return entry.work;
	}

	private wait(jobId: number, entry: Entry, ms: number): void {
		if (this.stopped || this.pending.get(jobId) !== entry) return;
		this.cancelTimer(entry);
		entry.timer = this.timers.setTimeout(() => this.wake(jobId), ms);
	}

	private async reconcile(jobId: number, entry: Entry): Promise<void> {
		try {
			const [snapshot, now] = await Promise.all([this.chain.getDeadlines(jobId), this.chain.chainTime()]);
			if (this.stopped || this.pending.get(jobId) !== entry) return;
			if (entry.again) return; // a newer wakeup invalidated this read; finally() rereads
			if (!Number.isInteger(snapshot.status) || snapshot.status < 0 || snapshot.status > 9) throw new Error("Unknown contract phase.");
			if (TERMINAL.has(snapshot.status)) {
				this.pending.delete(jobId);
				return;
			}
			const step = STEPS[snapshot.status];
			if (!step) { this.wait(jobId, entry, POLL_MS); return; }
			const remaining = snapshot[step.deadline] - now + 1n;
			if (snapshot[step.deadline] <= 0n) throw new Error("Active contract phase has no deadline.");
			if (remaining > 0n) {
				entry.failures = 0;
				this.wait(jobId, entry, Number(remaining > 30n ? 30n : remaining) * 1000);
				return;
			}
			await this.chain[step.call](jobId);
			entry.failures = 0;
			this.log.log(`Job ${jobId}: ${step.call} done`);
			// Re-read even when the next event was missed or already checkpointed.
			this.wait(jobId, entry, 0);
		} catch (error) {
			this.log.warn(`Job ${jobId}: phase reconciliation failed; retrying (${errorMessage(error)})`);
			this.wait(jobId, entry, backoff(entry.failures++));
		}
	}
}

function backoff(failures: number): number {
	return Math.min(POLL_MS, 1000 * 2 ** Math.min(failures, 5));
}
