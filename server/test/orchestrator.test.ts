import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, type PhaseChain } from "../services/orchestrator.ts";
import type { ChainEvent, Deadlines } from "../services/chain.ts";

type Call = "startRevealPhase" | "endRevealPhase" | "endDeliveryPhase";

// Timers that only fire when the test says so.
function fakeTimers() {
	const pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
	return {
		pending,
		live: () => pending.filter(t => !t.cleared),
		timers: {
			setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; pending.push(t); return t; },
			clearTimeout: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
		},
		// fire the only live timer and return its delay
		fire(): number {
			const live = pending.filter(t => !t.cleared);
			assert.equal(live.length, 1, `expected one live timer, got ${live.length}`);
			live[0].cleared = true;
			live[0].fn();
			return live[0].ms;
		},
	};
}

// A chain whose clock and deadlines the test controls; calls can be made to fail.
function fakeChain() {
	const state = {
		now: 1000n,
		deadlines: { commitDeadline: 1010n, revealDeadline: 0n, deliveryDeadline: 0n } as Deadlines,
		calls: [] as [Call, number][],
		failures: [] as string[], // reasons the next calls revert with, in order
	};
	const call = (name: Call) => async (jobId: number) => {
		state.calls.push([name, jobId]);
		const reason = state.failures.shift();
		if (reason) throw Object.assign(new Error(reason), { shortMessage: `reverted: ${reason}` });
	};
	const chain: PhaseChain = {
		startRevealPhase: call("startRevealPhase"),
		endRevealPhase: call("endRevealPhase"),
		endDeliveryPhase: call("endDeliveryPhase"),
		getDeadlines: async () => state.deadlines,
		chainTime: async () => state.now,
	};
	return { chain, state };
}

const event = (name: string, jobId = 7): ChainEvent => ({ name, args: { jobId: BigInt(jobId) }, blockNumber: 1n });
const quiet = { log() {}, warn() {}, error() {} };

function setup() {
	const t = fakeTimers();
	const c = fakeChain();
	const orchestrator = new Orchestrator(c.chain, { timers: t.timers, log: quiet });
	return { ...t, ...c, orchestrator };
}

test("each phase event schedules its transition one second past the chain-time deadline", async () => {
	const { orchestrator, state, fire } = setup();
	const steps: [string, keyof Deadlines, Call][] = [
		["COMMIT_PHASE_START", "commitDeadline", "startRevealPhase"],
		["REVEAL_PHASE_START", "revealDeadline", "endRevealPhase"],
		["DELIVERY_PHASE_START", "deliveryDeadline", "endDeliveryPhase"],
	];
	for (const [name, deadline, call] of steps) {
		state.deadlines = { commitDeadline: 0n, revealDeadline: 0n, deliveryDeadline: 0n, [deadline]: state.now + 15n };
		orchestrator.onEvent(event(name));
		await orchestrator.idle();
		assert.equal(fire(), 16_000, name);
		await orchestrator.idle();
		assert.deepEqual(state.calls.at(-1), [call, 7]);
	}
	assert.equal(state.calls.length, 3);
	assert.deepEqual(orchestrator.scheduled, []);
});

test("a deadline already passed in chain time runs right away", async () => {
	const { orchestrator, state, fire } = setup();
	state.now = 5000n;
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await orchestrator.idle();
	assert.equal(fire(), 0);
});

test("job-ending events cancel the pending transition", async () => {
	for (const name of ["NO_QUORUM", "DELIVERED", "CANCELED"]) {
		const { orchestrator, state, live } = setup();
		orchestrator.onEvent(event("REVEAL_PHASE_START"));
		await orchestrator.idle();
		orchestrator.onEvent(event(name));
		assert.equal(live().length, 0, name);
		assert.deepEqual(orchestrator.scheduled, []);
		assert.equal(state.calls.length, 0);
	}
});

test("unrelated events and other jobs are left alone", async () => {
	const { orchestrator, live } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START", 1));
	orchestrator.onEvent(event("COMMIT_PHASE_START", 2));
	orchestrator.onEvent(event("PAID", 1));
	orchestrator.onEvent(event("NO_QUORUM", 2));
	await orchestrator.idle();
	assert.deepEqual(orchestrator.scheduled, [1]);
	assert.equal(live().length, 1);
});

test("a repeated event keeps a single timer for the job", async () => {
	const { orchestrator, live } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await orchestrator.idle();
	assert.equal(live().length, 1);
});

test("'not ended' reverts reschedule from fresh chain time", async () => {
	const { orchestrator, state, fire } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await orchestrator.idle();
	state.failures.push("Commit phase not ended");
	state.now = 1008n; // chain time lagged behind the wall clock
	fire();
	await orchestrator.idle();
	assert.equal(fire(), 3_000);
	await orchestrator.idle();
	assert.deepEqual(state.calls, [["startRevealPhase", 7], ["startRevealPhase", 7]]);
	assert.deepEqual(orchestrator.scheduled, []);
});

test("'Not in phase' reverts mean someone else advanced the job: no retry", async () => {
	const { orchestrator, state, fire, live } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await orchestrator.idle();
	state.failures.push("Not in commit phase");
	fire();
	await orchestrator.idle();
	assert.equal(live().length, 0);
	assert.deepEqual(orchestrator.scheduled, []);
	assert.equal(state.calls.length, 1);
});

test("other failures back off exponentially until the call succeeds", async () => {
	const { orchestrator, state, fire } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await orchestrator.idle();
	state.failures.push("fetch failed", "fetch failed", "fetch failed");
	const delays = [];
	for (let i = 0; i < 4; i++) {
		delays.push(fire());
		await orchestrator.idle();
	}
	assert.deepEqual(delays, [11_000, 1_000, 2_000, 4_000]);
	assert.equal(state.calls.length, 4);
	assert.deepEqual(orchestrator.scheduled, []);
});

test("stop() clears every pending transition and ignores later events", async () => {
	const { orchestrator, live } = setup();
	orchestrator.onEvent(event("COMMIT_PHASE_START", 1));
	orchestrator.onEvent(event("REVEAL_PHASE_START", 2));
	await orchestrator.idle();
	await orchestrator.stop();
	orchestrator.onEvent(event("COMMIT_PHASE_START", 3));
	await orchestrator.idle();
	assert.equal(live().length, 0);
	assert.deepEqual(orchestrator.scheduled, []);
});
