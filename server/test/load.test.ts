// Load: the scheduler and the heartbeat path with many providers.
//   1. in memory: 2,000 providers and 500 queued jobs, one matching pass
//   2. against MongoDB and HTTP: 200 providers send their first heartbeat at the same moment while
//      40 jobs wait. Every heartbeat triggers a matching pass, so this checks that a burst finishes
//      in reasonable time and still never double-books a provider.
// The time limits are generous (CI machines vary); the printed timings are the useful numbers.
//
// Part 2 is skipped without MONGODB_URI.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { JobQueue } from "../matching/JobQueue.ts";
import { MatchingEngine } from "../matching/MatchingEngine.ts";
import { ProviderPoolCache } from "../matching/ProviderPoolCache.ts";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, AuthTokenModel, HardwareModel, JobModel, JobStatus, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";
import { hardwareFields } from "./helpers/hardware.ts";

const uri = process.env.MONGODB_URI;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("one matching pass over 2,000 providers and 500 jobs is fast and never double-books", async () => {
	const NOW = 1_000_000;
	const pool = new ProviderPoolCache({ now: () => NOW });
	for (let i = 0; i < 2000; i++) {
		pool.add({ wallet: wallet(i + 1), accountId: `a${i}`, registered: true, pricePerHour: (0.001 + (i % 50) / 10_000).toFixed(4), // toFixed: no float noise
			machine: { vcpus: [2, 4, 8, 16][i % 4], memoryGb: [4, 8, 16, 32][i % 4], gpus: [] }, lastHeartbeat: NOW, busyJobId: null, lastAssignedAt: 0 });
	}
	const queue = new JobQueue();
	const matched: string[][] = [];
	const engine = new MatchingEngine({ queue, pool, now: () => NOW, onMatched: async (_job, providers) => { matched.push(providers.map(p => p.wallet)); } });
	for (let j = 0; j < 500; j++) {
		queue.add({ id: `job-${j}`, owner: "buyer", k: 1 + (j % 3), quorum: 1, window: 600, maxPrice: "1",
			requirements: { minVcpus: [1, 2, 4, 8][j % 4], minMemoryGb: 2, gpu: "none", minGpuVramGb: 0 },
			createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, j)).toISOString() });
	}
	const started = performance.now();
	await engine.matchNext();
	const ms = performance.now() - started;
	console.log(`# in-memory matching: ${matched.length} jobs matched from 2,000 providers in ${ms.toFixed(0)} ms`);
	const all = matched.flat();
	assert.equal(new Set(all).size, all.length, "a provider was booked twice");
	assert.equal(matched.length, 500, "there's capacity for every job");
	// About 8 s on a laptop: every job re-sorts every provider, recomputing scores in the
	// comparator, on the event loop (TESTING_PLAN.md, load observations). The limit only guards
	// against it getting much worse.
	assert.ok(ms < 30_000, `matching took ${ms.toFixed(0)} ms`);
});

describe("a burst of heartbeats against MongoDB", { skip: !uri && "set MONGODB_URI to run" }, () => {
	const PROVIDERS = 200;
	const JOBS = 40;
	let server: Server;
	let base = "";
	let matcher: Matcher;

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-load-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		const buyer = await AccountModel.create({ walletIds: [wallet(1)] });
		const accounts = await AccountModel.insertMany(Array.from({ length: PROVIDERS }, (_, i) => ({ walletIds: [wallet(1000 + i)] })));
		const hardware = await HardwareModel.insertMany(accounts.map((a, i) => ({ userRef: a._id, address: wallet(1000 + i), ...hardwareFields(), price: Number((0.001 + (i % 20) / 10_000).toFixed(4)) })));
		await AccountModel.bulkWrite(accounts.map((a, i) => ({ updateOne: { filter: { _id: a._id }, update: { hardware: hardware[i]._id } } })));
		await AuthTokenModel.insertMany(accounts.map((a, i) => ({ tokenHash: hashToken(`p-${i}`), account: a._id, wallet: wallet(1000 + i) })));
		await JobModel.insertMany(Array.from({ length: JOBS }, (_, j) => ({
			onChainJobId: j + 1, owner: buyer._id, dockerImageDigest: `docker.io/library/alpine@sha256:${"a".repeat(64)}`,
			maxPrice: "1", minNodesToRunOn: 1 + (j % 3), minNodesToAgree: 1 + Math.floor((1 + (j % 3)) / 2), timeWindow: 600, submittedAt: new Date(),
		})));
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

	test(`${PROVIDERS} simultaneous heartbeats all succeed, and every waiting job is matched once`, async () => {
		const started = performance.now();
		const responses = await Promise.all(Array.from({ length: PROVIDERS }, (_, i) =>
			fetch(`${base}/provider/heartbeat`, { method: "POST", headers: { Authorization: `Bearer p-${i}` } })));
		const answered = performance.now() - started;
		await matcher.idle();
		const settled = performance.now() - started;
		console.log(`# ${PROVIDERS} heartbeats answered in ${answered.toFixed(0)} ms; matching settled after ${settled.toFixed(0)} ms`);
		assert.deepEqual([...new Set(responses.map(r => r.status))], [200]);

		const jobs = await JobModel.find({ status: JobStatus.PENDING });
		for (const job of jobs) assert.equal(job.providers.length, job.minNodesToRunOn, `job ${job.onChainJobId} got ${job.providers.length} providers`);
		const booked = jobs.flatMap(job => job.providers.map(String));
		assert.equal(new Set(booked).size, booked.length, "a provider is on two jobs");
		assert.ok(settled < 60_000, `the burst took ${settled.toFixed(0)} ms to settle`);
	});
});
