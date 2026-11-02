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

const CPU = { model: "AMD Ryzen 7 7700X", cores: 8, threads: 16, singleThreadMBps: 61, multiThreadMBps: 610 };
const MEMORY = { totalGb: 31.2, bandwidthGBps: 18.5 };

describe("Hardware", () => {
	test("GPUs are optional; a GPU's measurements may be missing when its benchmark failed", async () => {
		const hw = new HardwareModel({ userRef: new Types.ObjectId(), address: WALLET, cpu: CPU, memory: MEMORY });
		await hw.validate();
		assert.deepEqual(hw.gpus.toObject(), []);
		hw.gpus.push({ vendor: "nvidia", index: 0, model: "RTX 2070", vramGb: 8, error: "Docker can't use this GPU" });
		await hw.validate();
		assert.equal(hw.gpus[0].fp32Tflops, null);
	});

	test("requires owner, cpu and memory, and rejects unknown GPU vendors and zero threads", async () => {
		await assert.rejects(new HardwareModel({}).validate(), (e: Error) =>
			["userRef", "address", "cpu", "memory"].every((f) => e.message.includes(f)),
		);
		const base = { userRef: new Types.ObjectId(), address: WALLET, cpu: CPU, memory: MEMORY };
		await assert.rejects(new HardwareModel({ ...base, cpu: { ...CPU, threads: 0 } }).validate(), /threads/);
		await assert.rejects(new HardwareModel({ ...base, gpus: [{ vendor: "intel", index: 0, model: "Arc", vramGb: 8 }] }).validate(), /vendor/);
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
		assert.deepEqual({ ...job.requirements?.toObject() }, { minVcpus: 1, minMemoryGb: 1, gpu: "none", minGpuVramGb: 0 });
		assert.equal(job.cpuLimit, 1);
		assert.equal(job.memLimitMb, 1024);
		assert.ok(job.createdAt === undefined || job.createdAt instanceof Date);
	});

	test("container limits always follow the requirements", async () => {
		const job = validJob({ requirements: { minVcpus: 4, minMemoryGb: 7.5, gpu: "nvidia", minGpuVramGb: 8 }, cpuLimit: 64, memLimitMb: 1 });
		await job.validate();
		assert.equal(job.cpuLimit, 4);
		assert.equal(job.memLimitMb, 7680);
	});

	test("rejects fractional vCPUs, tiny memory and unknown GPU requirements", async () => {
		for (const requirements of [{ minVcpus: 1.5 }, { minVcpus: 0 }, { minMemoryGb: 0.1 }, { gpu: "intel" }, { minGpuVramGb: -1 }]) {
			await assert.rejects(validJob({ requirements }).validate(), undefined, JSON.stringify(requirements));
		}
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
