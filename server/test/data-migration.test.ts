// An existing database from before the current schema (milestone3) still works:
//   - accounts whose reputation is the old +1/-1 counter (it can be negative)
//   - hardware with the old single scores (cpuScore/gpuScore/memoryScore) instead of a profile
//   - jobs with score-based requirements (minCpuScore, ...) and no payouts
// The documents are written raw, bypassing today's schema, as an old database would have them.
// Every route that reads them must answer without a server error, an old machine must never be
// matched, and once the provider re-benchmarks, the old job matches it like a new one.
//
// Skipped without MONGODB_URI.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AuthTokenModel, JobModel, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";
import { testProfile } from "./helpers/hardware.ts";

const uri = process.env.MONGODB_URI;
const PROVIDER = `0x${"a".repeat(40)}`;
const BUYER = `0x${"b".repeat(40)}`;
const DIGEST = `docker.io/library/alpine@sha256:${"c".repeat(64)}`;
const dec = (v: string) => mongoose.Types.Decimal128.fromString(v);

describe("a database from before the current schema", { skip: !uri && "set MONGODB_URI to run" }, () => {
	let server: Server;
	let base = "";
	let matcher: Matcher;
	const ids = { provider: new mongoose.Types.ObjectId(), buyer: new mongoose.Types.ObjectId(), hardware: new mongoose.Types.ObjectId() };

	const call = async (method: string, route: string, as: "provider" | "buyer", body?: unknown) => {
		const res = await fetch(base + route, { method, headers: { Authorization: `Bearer old-${as}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-migration-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		const db = mongoose.connection;
		// milestone3-shaped documents, written directly
		await db.collection("accounts").insertMany([
			{ _id: ids.provider, walletIds: [PROVIDER], reputation: -3, currentStake: dec("0"), totalEarned: dec("0.5"), totalSpent: dec("0"),
				processedChainEvents: [], submittedJobs: [], completedJobs: [], takenJobs: [], hardware: ids.hardware, createdAt: new Date("2026-10-01") },
			{ _id: ids.buyer, walletIds: [BUYER], reputation: 0, currentStake: dec("0"), totalEarned: dec("0"), totalSpent: dec("1"),
				processedChainEvents: [], submittedJobs: [], completedJobs: [], takenJobs: [], hardware: null, createdAt: new Date("2026-10-01") },
		]);
		await db.collection("hardwares").insertOne({ _id: ids.hardware, userRef: ids.provider, address: PROVIDER,
			cpuScore: 120, gpuScore: null, memoryScore: 80, price: 0.002, updatedAt: new Date("2026-10-01") });
		const oldJob = (onChainJobId: number, extra: Record<string, unknown>) => ({
			onChainJobId, owner: ids.buyer, providers: [], dockerImageDigest: DIGEST, command: [], env: [], inputUrl: null,
			maxPrice: dec("1"), runningPrice: dec("0"), minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60,
			requirements: { minCpuScore: 50, minGpuScore: 0, minMemoryScore: 40 }, cpuLimit: 1, memLimitMb: 512,
			results: [], createdAt: new Date("2026-10-02"), updatedAt: new Date("2026-10-02"), ...extra });
		await db.collection("jobs").insertMany([
			oldJob(1, { status: "PENDING", submittedAt: new Date("2026-10-02") }),
			oldJob(2, { status: "PAYOUT", submittedAt: new Date("2026-10-02"), providers: [ids.provider], settledAt: new Date("2026-10-03") }),
		]);
		await AuthTokenModel.create({ tokenHash: hashToken("old-provider"), account: ids.provider, wallet: PROVIDER });
		await AuthTokenModel.create({ tokenHash: hashToken("old-buyer"), account: ids.buyer, wallet: BUYER });
		matcher = new Matcher(null);
		server = createApp({ chain: null, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => server.once("listening", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	after(async () => {
		if (server) await new Promise(resolve => server.close(resolve));
		await matcher?.idle().catch(() => {});
		if (mongoose.connection.readyState === 1) {
			await mongoose.connection.dropDatabase();
			await disconnectDB();
		}
	});

	test("the dashboards load, with the old reputation counter as it was", async () => {
		const provider = await call("GET", "/account/me/dashboard", "provider");
		assert.equal(provider.status, 200, JSON.stringify(provider.body));
		assert.equal(provider.body.account.reputation, -3);
		assert.equal(provider.body.provider.totalEarned, "0.5");
		assert.equal(provider.body.provider.hardware.relative, null, "an old machine has no relative scores");
		const buyer = await call("GET", "/account/me/dashboard", "buyer");
		assert.equal(buyer.status, 200);
		assert.equal(buyer.body.buyer.totalSpent, "1");
	});

	test("an old machine is shown as needing a new benchmark, and can still be priced", async () => {
		const hardware = await call("GET", "/provider/hardware", "provider");
		assert.equal(hardware.status, 200, JSON.stringify(hardware.body));
		assert.equal(hardware.body.hardware.price, 0.002);
		assert.equal(hardware.body.suggestedPrice, null, "no suggestion without a hardware profile");
		const priced = await call("POST", "/provider/price", "provider", { price: 0.003 });
		assert.equal(priced.status, 200, JSON.stringify(priced.body));
	});

	test("old jobs list and open, with today's default requirements", async () => {
		const list = await call("GET", "/jobs", "buyer");
		assert.equal(list.status, 200);
		assert.deepEqual(list.body.jobs.map((j: { id: number }) => j.id).sort(), [1, 2]);
		for (const id of [1, 2]) {
			const job = await call("GET", `/jobs/${id}`, "buyer");
			assert.equal(job.status, 200, JSON.stringify(job.body));
			assert.equal(job.body.job.requirements.minVcpus, 1);
			assert.equal(job.body.job.requirements.gpu, "none");
		}
		const settled = (await call("GET", "/jobs/2", "buyer")).body.job;
		assert.equal(typeof settled.payment.status, "string", "a settled old job reports a payment state");
		assert.equal((await call("GET", "/jobs?role=provider", "provider")).status, 200);
	});

	test("an old machine is never matched, and heartbeats from it don't break matching", async () => {
		const heartbeat = await call("POST", "/provider/heartbeat", "provider");
		assert.ok([200, 409].includes(heartbeat.status), `heartbeat answered ${heartbeat.status}`);
		await matcher.ping();
		await matcher.idle();
		assert.deepEqual((await JobModel.findOne({ onChainJobId: 1 }).orFail()).providers, [], "the old machine was matched without a profile");
	});

	test("after a new benchmark, the old job matches the machine like a new one", async () => {
		const scores = await call("POST", "/scores", "provider", testProfile());
		assert.equal(scores.status, 201, JSON.stringify(scores.body));
		assert.ok(scores.body.hardware.relative, "relative scores once there's a profile");
		assert.equal(scores.body.hardware.price, 0.003, "the price survives the new benchmark");
		assert.equal((await call("POST", "/provider/heartbeat", "provider")).status, 200);
		await matcher.idle();
		const job = await JobModel.findOne({ onChainJobId: 1 }).orFail();
		assert.deepEqual(job.providers.map(String), [String(ids.provider)]);
	});
});
