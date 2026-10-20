// Schema validation for the Mongo models. Uses doc.validate(), so no database is needed.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { AccountModel, HardwareModel, JobModel, JobStatus, TutorialModel } from "../models/index.ts";

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);

function validJob(overrides: Record<string, unknown> = {}) {
	return new JobModel({
		onChainJobId: 1,
		owner: new Types.ObjectId(),
		dockerImageDigest: DIGEST,
		maxPrice: "1.5",
		minNodesToRunOn: 3,
		minNodesToAgree: 2,
		timeWindow: 600,
		...overrides,
	});
}

describe("Account", () => {
	test("defaults and lowercases wallets", async () => {
		const acct = new AccountModel({ walletIds: [WALLET] });
		await acct.validate();
		assert.deepEqual(acct.walletIds, [WALLET.toLowerCase()]);
		assert.equal(acct.totalSpent?.toString(), "0");
		assert.equal(acct.reputation, 0);
		assert.equal(acct.hardware, null);
	});

	test("needs at least one wallet", async () => {
		await assert.rejects(new AccountModel({}).validate(), /walletIds/);
	});

	test("rejects malformed wallets and negative balances", async () => {
		await assert.rejects(new AccountModel({ walletIds: ["0x123"] }).validate(), /walletIds/);
		await assert.rejects(
			new AccountModel({ walletIds: [WALLET], currentStake: "-1" }).validate(),
			/currentStake/,
		);
	});
});

describe("Hardware", () => {
	test("gpuScore is optional", async () => {
		const hw = new HardwareModel({ userRef: new Types.ObjectId(), address: WALLET, cpuScore: 100, memoryScore: 50 });
		await hw.validate();
		assert.equal(hw.gpuScore, null);
	});

	test("requires owner and cpu/memory scores", async () => {
		await assert.rejects(new HardwareModel({}).validate(), (e: Error) =>
			["userRef", "address", "cpuScore", "memoryScore"].every((f) => e.message.includes(f)),
		);
	});
});

describe("Job", () => {
	test("defaults", async () => {
		const job = validJob();
		await job.validate();
		assert.equal(job.status, JobStatus.PENDING);
		assert.equal(job.submittedAt, null);
		assert.deepEqual(job.results.toObject(), []);
		assert.deepEqual(job.command.toObject(), []);
		assert.equal(job.requirements?.minCpuScore, 0);
		assert.ok(job.createdAt === undefined || job.createdAt instanceof Date);
	});

	test("rejects unknown status", async () => {
		await assert.rejects(validJob({ status: "PICKED_UP" }).validate(), /status/);
	});

	test("image must be pinned by digest", async () => {
		await assert.rejects(validJob({ dockerImageDigest: "alpine:3.20" }).validate(), /dockerImageDigest/);
	});

	test("quorum can't exceed k", async () => {
		await assert.rejects(validJob({ minNodesToRunOn: 2, minNodesToAgree: 3 }).validate(), /minNodesToAgree/);
	});

	test("results need provider, hash, deliveryTime and location", async () => {
		await assert.rejects(validJob({ results: [{ hash: "0xabc" }] }).validate(), /results\.0\.(provider|deliveryTime|location)/);
		await validJob({
			results: [{ provider: new Types.ObjectId(), hash: "0xabc", deliveryTime: new Date(), location: "s3://b/k" }],
		}).validate();
	});

	test("requires an on-chain id", async () => {
		await assert.rejects(validJob({ onChainJobId: undefined }).validate(), /onChainJobId/);
	});
});

describe("Tutorial", () => {
	test("requires text", async () => {
		await assert.rejects(new TutorialModel({}).validate(), /text/);
		await new TutorialModel({ text: "hi" }).validate();
	});
});
