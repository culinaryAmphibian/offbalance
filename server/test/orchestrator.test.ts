import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, type PhaseChain } from "../services/orchestrator.ts";
import type { ChainEvent, Deadlines } from "../services/chain.ts";

type Call = "startRevealPhase" | "endRevealPhase" | "endDeliveryPhase";
const event = (name: string, jobId = 7): ChainEvent => ({ name, args: { jobId: BigInt(jobId) }, blockNumber: 1n });
const quiet = { log() {}, warn() {}, error() {} };

function setup() {
	const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	const live = () => timers.filter(timer => !timer.cleared);
	const snapshots = new Map<number, Deadlines>();
	const state = { now: 1000n, readsFail: false, failures: [] as string[], calls: [] as [Call, number][],
		beforeWrite: null as (() => Promise<void>) | null };
	const snapshot = (status = 2, deadline = 1010n): Deadlines => ({ status, commitDeadline: deadline, revealDeadline: deadline, deliveryDeadline: deadline });
	snapshots.set(7, snapshot());
	const call = (name: Call, nextStatus: number) => async (id: number) => {
		state.calls.push([name, id]);
		await state.beforeWrite?.();
		if (state.failures.length) throw new Error(state.failures.shift());
		snapshots.set(id, snapshot(nextStatus, state.now + 15n));
	};
	const chain: PhaseChain = {
		startRevealPhase: call("startRevealPhase", 3), endRevealPhase: call("endRevealPhase", 5), endDeliveryPhase: call("endDeliveryPhase", 7),
		getDeadlines: async id => { if (state.readsFail) throw new Error("RPC down"); return snapshots.get(id)!; },
		chainTime: async () => state.now,
	};
	const options = { log: quiet, timers: {
		setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeout: (handle: unknown) => { (handle as typeof timers[number]).cleared = true; },
	} };
	const orchestrator = new Orchestrator(chain, options);
	const fire = (ms?: number) => {
		const timer = live().find(timer => ms === undefined || timer.ms === ms);
		assert.ok(timer, `No pending timer${ms === undefined ? '' : ` at ${ms} ms`}`);
		timer.cleared = true;
		timer.fn();
		return timer.ms;
	};
	return { orchestrator, chain, options, state, snapshots, snapshot, live, fire };
}

test("restart reconstructs each active phase from durable IDs without receiving another event", async () => {
	for (const [status, call] of [[2, "startRevealPhase"], [3, "endRevealPhase"], [5, "endDeliveryPhase"]] as const) {
		const f = setup();
		await f.orchestrator.recover([7]);
		await f.orchestrator.stop();
		f.snapshots.set(7, f.snapshot(status, 900n));
		const restarted = new Orchestrator(f.chain, f.options);
		await restarted.recover([7]);
		assert.deepEqual(f.state.calls, [[call, 7]]);
		await restarted.stop();
	}
});

test("events wake the actual contract phase rather than replaying an older phase", async () => {
	const f = setup();
	f.snapshots.set(7, f.snapshot(5));
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await f.orchestrator.idle();
	assert.equal(f.fire(), 11_000);
	f.state.now = 1011n;
	await f.orchestrator.idle();
	// The timer read still observed the old clock, so wake it again after chain time advances.
	f.orchestrator.onEvent(event("REVEAL_PHASE_START"));
	await f.orchestrator.idle();
	assert.deepEqual(f.state.calls, [["endDeliveryPhase", 7]]);
	await f.orchestrator.stop();
});

test("every timer rechecks chain time and caps long sleeps without timer overflow", async () => {
	const f = setup();
	f.snapshots.set(7, f.snapshot(2, 10n ** 30n));
	await f.orchestrator.recover([7]);
	assert.equal(f.fire(), 30_000);
	await f.orchestrator.idle();
	assert.equal(f.state.calls.length, 0);
	f.snapshots.set(7, f.snapshot(2, 1010n));
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await f.orchestrator.idle();
	assert.equal(f.fire(), 11_000);
	await f.orchestrator.idle();
	assert.equal(f.state.calls.length, 0);
	await f.orchestrator.stop();
});

test("missed transition events are recovered after a successful phase write", async () => {
	const f = setup();
	f.state.now = 2000n;
	await f.orchestrator.recover([7]);
	assert.deepEqual(f.state.calls, [["startRevealPhase", 7]]);
	assert.equal(f.fire(), 0);
	await f.orchestrator.idle();
	assert.equal(f.live()[0].ms, 16_000);
	f.state.now = 2016n;
	f.fire();
	await f.orchestrator.idle();
	assert.deepEqual(f.state.calls.at(-1), ["endRevealPhase", 7]);
	await f.orchestrator.stop();
});

test("terminal chain state cancels stale durable jobs and old phase events", async () => {
	for (const status of [6, 7, 8, 9]) {
		const f = setup();
		await f.orchestrator.recover([7]);
		f.snapshots.set(7, f.snapshot(status));
		f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
		await f.orchestrator.idle();
		assert.deepEqual(f.orchestrator.scheduled, []);
		assert.equal(f.live().length, 0);
		assert.equal(f.state.calls.length, 0);
	}
});

test("stale terminal events do not cancel a newer active chain phase", async () => {
	const f = setup();
	f.snapshots.set(7, f.snapshot(3));
	f.orchestrator.onEvent(event("CANCELED"));
	await f.orchestrator.idle();
	assert.deepEqual(f.orchestrator.scheduled, [7]);
	assert.equal(f.live().length, 1);
	await f.orchestrator.stop();
});

test("startup RPC failures retain work and retry until the current phase can be read", async () => {
	const f = setup();
	f.state.readsFail = true;
	await f.orchestrator.recover([7]);
	assert.equal(f.fire(), 1000);
	await f.orchestrator.idle();
	assert.equal(f.fire(), 2000);
	f.state.readsFail = false;
	await f.orchestrator.idle();
	f.fire();
	await f.orchestrator.idle();
	assert.equal(f.live()[0].ms, 11_000);
	await f.orchestrator.stop();
});

test("a failed or ambiguous transition re-reads state before retrying instead of resending blindly", async () => {
	const f = setup();
	f.state.now = 2000n;
	f.state.failures.push("receipt timed out");
	await f.orchestrator.recover([7]);
	f.snapshots.set(7, f.snapshot(5, 2100n)); // transaction mined; its response/event was lost
	assert.equal(f.fire(), 1000);
	await f.orchestrator.idle();
	assert.deepEqual(f.state.calls, [["startRevealPhase", 7]]);
	assert.equal(f.live()[0].ms, 30_000);
	await f.orchestrator.stop();
});

test("repeated events and discoveries never submit concurrently for one job", async () => {
	const f = setup();
	let unblock!: () => void;
	f.state.beforeWrite = () => new Promise(resolve => { unblock = resolve; });
	f.state.now = 2000n;
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	await new Promise(resolve => setImmediate(resolve));
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	f.orchestrator.onEvent(event("REVEAL_PHASE_START"));
	assert.equal(f.state.calls.length, 1);
	unblock();
	await f.orchestrator.idle();
	assert.equal(f.state.calls.length, 1);
	assert.equal(f.live().length, 1);
	await f.orchestrator.stop();
});

test("periodic discovery retries database errors and discovers work missing from event delivery", async () => {
	const f = setup();
	let attempts = 0;
	await f.orchestrator.start(async () => { if (++attempts === 1) throw new Error("database down"); return [7]; });
	assert.equal(f.fire(), 1000);
	await f.orchestrator.idle();
	assert.deepEqual(f.orchestrator.scheduled, [7]);
	assert.equal(attempts, 2);
	await f.orchestrator.stop();
	assert.equal(f.live().length, 0);
});

test("stop during an RPC read prevents late writes or timers", async () => {
	const f = setup();
	let unblock!: (value: Deadlines) => void;
	f.chain.getDeadlines = () => new Promise(resolve => { unblock = resolve; });
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	const stopped = f.orchestrator.stop();
	unblock(f.snapshot(2, 900n));
	await stopped;
	assert.equal(f.state.calls.length, 0);
	assert.equal(f.live().length, 0);
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	assert.deepEqual(f.orchestrator.scheduled, []);
});

test("a newer event invalidates an older in-flight RPC snapshot before any phase submission", async () => {
	const f = setup();
	let unblock!: (value: Deadlines) => void;
	let reads = 0;
	f.chain.getDeadlines = () => ++reads === 1 ? new Promise(resolve => { unblock = resolve; }) : Promise.resolve(f.snapshot(8));
	f.orchestrator.onEvent(event("COMMIT_PHASE_START"));
	f.orchestrator.onEvent(event("CANCELED"));
	unblock(f.snapshot(2, 900n));
	await f.orchestrator.idle();
	assert.equal(f.state.calls.length, 0);
	assert.deepEqual(f.orchestrator.scheduled, []);
});
