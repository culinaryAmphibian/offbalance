import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AccountModel, JobModel, JobStatus } from "../models/index.ts";
import { unfinishedPhaseJobIds } from "../services/phase-recovery.ts";
import { Orchestrator, type PhaseChain } from "../services/orchestrator.ts";
import type { Deadlines } from "../services/chain.ts";

const uri = process.env.MONGODB_URI;

test("Mongo unfinished jobs restore phase work after restart, including stale phases and missed events", { skip: !uri }, async () => {
	await mongoose.connect(uri!, { dbName: `offbalance_phase_recovery_${randomUUID().replaceAll("-", "")}` });
	const orchestrators: Orchestrator[] = [];
	try {
		await mongoose.syncIndexes();
		const owner = await AccountModel.create({ walletIds: [`0x${"1".repeat(40)}`] });
		const makeJob = (id: number, status: string, submitted = true, providers: mongoose.Types.ObjectId[] = []) => JobModel.create({
			onChainJobId: id, owner: owner._id, status, providers, submittedAt: submitted ? new Date() : null,
			dockerImageDigest: `example/job@sha256:${"a".repeat(64)}`, maxPrice: "1", minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60,
		});
		await makeJob(1, JobStatus.COMMIT_PHASE);
		await makeJob(2, JobStatus.REVEAL_PHASE);
		await makeJob(3, JobStatus.PENDING, false, [owner._id]);
		await makeJob(4, JobStatus.AWAITING_DELIVERY);
		await makeJob(5, JobStatus.PAYOUT);
		await makeJob(6, JobStatus.PENDING, false);
		assert.deepEqual((await unfinishedPhaseJobIds()).sort(), [1, 2, 3, 4]);

		const snapshots = new Map<number, Deadlines>([1, 2, 3, 4].map(id => [id, {
			status: id === 4 ? 7 : 2, commitDeadline: 1100n, revealDeadline: 1100n, deliveryDeadline: 1100n,
		}]));
		let now = 1000n;
		const calls: [string, number][] = [];
		const call = (name: string) => async (id: number) => { calls.push([name, id]); snapshots.get(id)!.status = 7; };
		const chain: PhaseChain = { getDeadlines: async id => snapshots.get(id)!, chainTime: async () => now,
			startRevealPhase: call("reveal"), endRevealPhase: call("delivery"), endDeliveryPhase: call("payout") };
		const timers = new Set<unknown>();
		const options = { log: { log() {}, warn() {}, error() {} }, timers: {
			setTimeout(fn: () => void, _ms: number) { const handle = { fn }; timers.add(handle); return handle; },
			clearTimeout(handle: unknown) { timers.delete(handle); },
		} };
		const first = new Orchestrator(chain, options);
		orchestrators.push(first);
		await first.start(unfinishedPhaseJobIds);
		assert.deepEqual(first.scheduled.sort(), [1, 2, 3]);
		await first.stop();
		assert.equal(timers.size, 0);
		assert.equal(calls.length, 0);

		// The new process receives no historical events, even though phases changed offline.
		now = 1200n;
		snapshots.get(2)!.status = 3;
		snapshots.get(3)!.status = 5;
		const restarted = new Orchestrator(chain, options);
		orchestrators.push(restarted);
		await restarted.start(unfinishedPhaseJobIds);
		assert.deepEqual(calls.sort((a, b) => a[1] - b[1]), [["reveal", 1], ["delivery", 2], ["payout", 3]]);
		assert.equal(calls.some(([, id]) => id === 4), false);
		// Recovery never synthesizes payment events to mutate financial history.
		assert.equal((await JobModel.findOne({ onChainJobId: 4 }))!.status, JobStatus.AWAITING_DELIVERY);
	} finally {
		await Promise.all(orchestrators.map(orchestrator => orchestrator.stop()));
		await mongoose.connection.dropDatabase();
		await mongoose.disconnect();
	}
});
