import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Interface } from "ethers";
import { MongoCheckpointStore, checkpointNamespace } from "../adapters/checkpoints.ts";
import { BlockchainMonitor } from "../blockchain-manager/index.ts";

const uri = process.env.MONGODB_URI;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;

test("Mongo checkpoint persistence isolates chain/contract namespaces, resumes, and retries failures", { skip: !uri }, async () => {
	const connection = await mongoose.createConnection(uri!, {
		dbName: `offbalance_checkpoints_test_${randomUUID().replaceAll("-", "")}`,
	}).asPromise();
	try {
		const namespace = checkpointNamespace(31337, "0xABCDEF");
		const store = new MongoCheckpointStore(namespace, connection);
		assert.equal(await store.load(), null);
		await store.save({ blockNumber: -1, blockHash: null });
		await store.save({ blockNumber: 3, blockHash: hash(4) });
		const resumed = new MongoCheckpointStore(namespace, connection);
		assert.deepEqual(await resumed.load(), { blockNumber: 3, blockHash: hash(4) });
		const otherChain = new MongoCheckpointStore(checkpointNamespace(1, "0xabcdef"), connection);
		const otherContract = new MongoCheckpointStore(checkpointNamespace(31337, "0x1234"), connection);
		assert.equal(await otherChain.load(), null);
		assert.equal(await otherContract.load(), null);
		await assert.rejects(store.save({ blockNumber: 4, blockHash: null }), /Invalid blockchain checkpoint/);
		assert.deepEqual(await store.load(), { blockNumber: 3, blockHash: hash(4) });

		// An actual DB-backed monitor advances only after callback and checkpoint persistence succeed.
		const provider = {
			getBlockNumber: () => 6,
			getBlock: (number: number) => ({ number, hash: hash(number + 1) }),
			getLogs: () => [],
		};
		const monitor = new BlockchainMonitor({
			provider, address: "0x1111111111111111111111111111111111111111",
			abi: ["event Observed(uint256 indexed jobId)"], chainId: 31337,
			checkpointStore: resumed, onEvent() {}, confirmations: 0,
		});
		const result = await monitor.pollOnce();
		assert.equal(result.fromBlock, 4);
		assert.deepEqual(await store.load(), { blockNumber: 6, blockHash: hash(7) });

		const abi = ["event Observed(uint256 indexed jobId)"];
		const encoded = new Interface(abi).encodeEventLog("Observed", [42n]);
		let fail = true;
		const seen: string[] = [];
		const retry = new BlockchainMonitor({
			provider: {
				...provider, getBlockNumber: () => 8,
				getLogs: () => [{ address: "0x1111111111111111111111111111111111111111",
					blockNumber: 7, blockHash: hash(8), transactionHash: hash(100),
					transactionIndex: 0, index: 0, ...encoded }],
			},
			address: "0x1111111111111111111111111111111111111111", abi, chainId: 31337,
			checkpointStore: resumed, confirmations: 0,
			onEvent(event) {
				seen.push(event.id);
				if (fail) { fail = false; throw new Error("Database event temporarily unavailable"); }
			},
		});
		await assert.rejects(retry.pollOnce(), /temporarily unavailable/);
		assert.deepEqual(await store.load(), { blockNumber: 6, blockHash: hash(7) });
		await retry.pollOnce();
		assert.equal(seen.length, 2);
		assert.equal(seen[0], seen[1]);
		assert.deepEqual(await store.load(), { blockNumber: 8, blockHash: hash(9) });

		// Corrupt stored state must never silently reset the cursor and replay financial effects.
		await connection.collection<{ _id: string; blockHash: string | null }>("blockchaincheckpoints").updateOne(
			{ _id: namespace },
			{ $set: { blockHash: "invalid" } },
		);
		await assert.rejects(store.load(), /Invalid blockchain checkpoint/);
	} finally {
		await connection.dropDatabase();
		await connection.close();
	}
});

test("chain event adapter preserves ABI names, bigint arguments, and deduplication IDs", async () => {
	const { chainEvent } = await import("../services/chain.ts");
	const abi = new Interface(["event PAID(uint256 indexed jobId, address indexed provider, uint256 amount)"]);
	const provider = "0x1111111111111111111111111111111111111111";
	const encoded = abi.encodeEventLog("PAID", [42n, provider, 5n]);
	const decoded = abi.parseLog(encoded)!;
	const event = chainEvent({
		id: "stable-event-id", chainId: "31337", address: provider,
		blockNumber: 7, blockHash: hash(8), transactionHash: hash(100),
		transactionIndex: 0, logIndex: 1, name: decoded.name,
		signature: decoded.signature, args: decoded.args,
	}, abi);
	assert.deepEqual(event, {
		id: "stable-event-id", name: "PAID", args: { jobId: 42n, provider, amount: 5n }, blockNumber: 7n,
	});
});
