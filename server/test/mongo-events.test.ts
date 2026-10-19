import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Interface } from "ethers";
import { AccountModel, ChainEventModel, JobModel, JobStatus } from "../models/index.ts";
import { handleChainEvent } from "../services/events.ts";
import { chainEvent, type ChainEvent } from "../services/chain.ts";
import { Matcher } from "../services/matcher.ts";
import { BlockchainMonitor } from "../blockchain-manager/index.ts";
import { MongoCheckpointStore } from "../adapters/checkpoints.ts";

const uri = process.env.MONGODB_URI;
const wallet = () => `0x${randomBytes(20).toString("hex")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
let nextJobId = 100;

async function fixture(selfProvider = false) {
	const owner = await AccountModel.create({ walletIds: [wallet()] });
	const provider = selfProvider ? owner : await AccountModel.create({ walletIds: [wallet()] });
	const job = await JobModel.create({
		onChainJobId: nextJobId++, owner: owner._id, providers: [provider._id],
		status: JobStatus.AWAITING_DELIVERY,
		dockerImageDigest: `example/job@sha256:${"a".repeat(64)}`,
		maxPrice: "3", runningPrice: "2.75", minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60,
	});
	const matcher = new Matcher(null);
	matcher.manager.pool.register({ wallet: provider.walletIds[0], accountId: String(provider._id),
		registered: true, pricePerHour: "2.75", machine: { cpuScore: 1, gpuScore: null, memoryScore: 1 },
		busyJobId: String(job.onChainJobId), lastHeartbeat: Date.now() });
	const event = (name: string, id = `${job.onChainJobId}:${name}`): ChainEvent & { id: string } => ({
		id, name, blockNumber: 1n,
		args: { jobId: BigInt(job.onChainJobId), provider: provider.walletIds[0] },
	});
	return { owner, provider, job, matcher, event };
}

async function account(id: mongoose.Types.ObjectId) {
	const result = await AccountModel.findById(id).orFail();
	return { earned: result.totalEarned?.toString(), spent: result.totalSpent?.toString(),
		reputation: result.reputation, completed: result.completedJobs.map(String), processed: result.processedChainEvents };
}

test("Mongo chain event effects survive replay and partial failures", { skip: !uri }, async t => {
	await mongoose.connect(uri!, { dbName: `offbalance_events_test_${randomUUID().replaceAll("-", "")}` });
	try {
		await mongoose.syncIndexes();

		await t.test("PAID and SLASHED replay only apply financial and reputation effects once", async () => {
			const f = await fixture();
			await handleChainEvent(f.event("PAID"), f.matcher);
			await handleChainEvent(f.event("PAID"), f.matcher);
			assert.equal((await account(f.provider._id)).earned, "2.75");
			assert.equal((await account(f.provider._id)).reputation, 1);
			assert.equal((await account(f.owner._id)).spent, "2.75");
			await handleChainEvent(f.event("SLASHED"), f.matcher);
			await handleChainEvent(f.event("SLASHED"), f.matcher);
			assert.equal((await account(f.provider._id)).reputation, 0);
			assert.equal(await ChainEventModel.countDocuments({ _id: { $in: [f.event("PAID").id, f.event("SLASHED").id] } }), 2);
		});

		await t.test("a failed buyer update leaves no processed receipt and retry never credits provider twice", async () => {
			const f = await fixture();
			const original = AccountModel.updateOne;
			let failed = false;
			AccountModel.updateOne = function (this: typeof AccountModel, ...args: Parameters<typeof AccountModel.updateOne>) {
				const filter = args[0] as { _id?: unknown };
				if (!failed && String(filter._id) === String(f.owner._id)) {
					failed = true;
					throw new Error("Injected buyer account write failure");
				}
				return Reflect.apply(original, this, args);
			} as typeof AccountModel.updateOne;
			try {
				await assert.rejects(handleChainEvent(f.event("PAID"), f.matcher), /Injected buyer/);
			} finally { AccountModel.updateOne = original; }
			assert.equal(failed, true);
			assert.equal((await account(f.provider._id)).earned, "2.75");
			assert.equal((await account(f.owner._id)).spent, "0");
			assert.equal(await ChainEventModel.exists({ _id: f.event("PAID").id }), null);
			await handleChainEvent(f.event("PAID"), f.matcher);
			assert.equal((await account(f.provider._id)).earned, "2.75");
			assert.equal((await account(f.provider._id)).reputation, 1);
			assert.equal((await account(f.owner._id)).spent, "2.75");
			assert.ok(await ChainEventModel.exists({ _id: f.event("PAID").id }));
		});

		await t.test("DELIVERED replay preserves completed jobs and a provider's subsequent reservation", async () => {
			const f = await fixture();
			await handleChainEvent(f.event("DELIVERED"), f.matcher);
			assert.equal((await JobModel.findById(f.job._id).orFail()).status, JobStatus.PAYOUT);
			assert.deepEqual((await account(f.owner._id)).completed, [String(f.job._id)]);
			assert.equal(f.matcher.manager.pool.get(f.provider.walletIds[0])?.busyJobId, null);
			assert.equal(f.matcher.manager.pool.markBusy(f.provider.walletIds[0], "next-job"), true);
			await handleChainEvent(f.event("DELIVERED"), f.matcher);
			// A distinct delivery log still must never release the provider's newer assignment.
			await handleChainEvent(f.event("DELIVERED", `${f.job.onChainJobId}:second-delivery`), f.matcher);
			assert.deepEqual((await account(f.owner._id)).completed, [String(f.job._id)]);
			assert.equal(f.matcher.manager.pool.get(f.provider.walletIds[0])?.busyJobId, "next-job");
		});

		await t.test("one account acting as buyer and provider records both sides of PAID exactly once", async () => {
			const f = await fixture(true);
			await handleChainEvent(f.event("PAID"), f.matcher);
			await handleChainEvent(f.event("PAID"), f.matcher);
			const result = await account(f.owner._id);
			assert.equal(result.earned, "2.75");
			assert.equal(result.spent, "2.75");
			assert.equal(result.reputation, 1);
		});

		await t.test("monitor decoding, event effects, and persisted checkpoint replay end to end", async () => {
			const f = await fixture();
			const abi = ["event PAID(uint256 indexed jobId, address provider)",
				"event SLASHED(uint256 indexed jobId, address provider)", "event DELIVERED(uint256 indexed jobId)"];
			const iface = new Interface(abi);
			const address = "0x1111111111111111111111111111111111111111";
			const logs = ["PAID", "SLASHED", "DELIVERED"].map((name, index) => ({
				address, blockNumber: 1, blockHash: hash(2), transactionHash: hash(100 + index),
				transactionIndex: index, index: 0,
				...iface.encodeEventLog(name, name === "DELIVERED" ? [f.job.onChainJobId] : [f.job.onChainJobId, f.provider.walletIds[0]]),
			}));
			const store = new MongoCheckpointStore(`monitor-test:${f.job.onChainJobId}`);
			const save = store.save.bind(store);
			let fail = true;
			store.save = async checkpoint => {
				if (fail) { fail = false; throw new Error("Injected checkpoint failure"); }
				await save(checkpoint);
			};
			const seen: string[] = [];
			const monitor = new BlockchainMonitor({
				provider: { getBlockNumber: () => 2, getBlock: number => ({ number, hash: hash(number + 1) }), getLogs: () => logs },
				address, abi, chainId: 31337, confirmations: 0, checkpointStore: store,
				onEvent: async event => { seen.push(event.id); await handleChainEvent(chainEvent(event, iface), f.matcher); },
			});
			await assert.rejects(monitor.pollOnce(), /Injected checkpoint/);
			assert.equal(await store.load(), null);
			assert.equal(await ChainEventModel.countDocuments({ _id: { $in: seen } }), 3);
			assert.equal((await monitor.pollOnce()).processed, 3);
			assert.deepEqual(seen.slice(0, 3), seen.slice(3));
			assert.deepEqual(await store.load(), { blockNumber: 2, blockHash: hash(3) });
			assert.equal((await account(f.provider._id)).earned, "2.75");
			assert.equal((await account(f.provider._id)).reputation, 0);
			assert.equal((await account(f.owner._id)).spent, "2.75");
			assert.deepEqual((await account(f.owner._id)).completed, [String(f.job._id)]);
			await monitor.stop();
		});
	} finally {
		await mongoose.connection.dropDatabase();
		await mongoose.disconnect();
	}
});
