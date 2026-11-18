// Contract events vs. database jobs, against MongoDB and the real HTTP routes.
//
// A saved quote binds the browser ID to the ID assigned by the contract.
//
// Skipped without MONGODB_URI. Uses its own database, so both counters start at 1.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { parseEther } from "viem";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, AuthTokenModel, ChainEventModel, CounterModel, JobModel, JobStatus, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import type { Chain } from "../services/chain.ts";
import { handleChainEvent } from "../services/events.ts";
import { Matcher } from "../services/matcher.ts";

const uri = process.env.MONGODB_URI;
const BUYER = `0x${"1".repeat(40)}`;
const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);

describe("contract events and database jobs", { skip: !uri && "set MONGODB_URI to run" }, () => {
	let server: Server;
	let base = "";
	const matcher = new Matcher(null);

	const call = async (method: string, url: string, body?: unknown) => {
		const res = await fetch(base + url, {
			method,
			headers: { Authorization: "Bearer test-buyer", ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		return { status: res.status, body: await res.json() };
	};
	const saveJob = async (name: string) => {
		const res = await call("POST", "/jobs", { name, dockerImageDigest: DIGEST, command: ["true"], maxPrice: "1",
			minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60 });
		assert.equal(res.status, 201, JSON.stringify(res.body));
		return res.body.job as { id: number; quoteId: string; totalEscrow: string };
	};
	const submittedOnChain = (contractJobId: number, quote: { quoteId: string; totalEscrow: string },
		overrides: Record<string, unknown> = {}, id = `log-${contractJobId}`) =>
		handleChainEvent({ id, name: "QUOTED_JOB_SUBMITTED", args: {
			jobId: BigInt(contractJobId), quoteId: quote.quoteId, buyer: BUYER,
			price: parseEther(quote.totalEscrow), maxHourlyRate: parseEther("1"),
			k: 1n, quorum: 1n, executionTime: 60n, dockerName: DIGEST, ...overrides,
		}, blockNumber: 1n }, matcher);
	const byName = (name: string) => JobModel.findOne({ name }).orFail();

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-jobids-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		const account = await AccountModel.create({ walletIds: [BUYER] });
		await AuthTokenModel.create({ tokenHash: hashToken("test-buyer"), account: account._id, wallet: BUYER });
		// a chain, so saved jobs wait for JOB_SUBMITTED; the job routes only check that there is one
		server = createApp({ chain: { supportsQuotedPricing: true } as Chain, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => server.once("listening", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	// each test starts like a fresh chain and a fresh database
	beforeEach(async () => {
		await Promise.all([JobModel.deleteMany({}), CounterModel.deleteMany({}), ChainEventModel.deleteMany({})]);
	});
	after(async () => {
		if (server) await new Promise(resolve => server.close(resolve));
		if (mongoose.connection.readyState === 1) {
			await mongoose.connection.dropDatabase();
			await disconnectDB();
		}
	});

	test("in the simple case the numbers line up: the first job saved is the contract's job 1", async () => {
		const job = await saveJob("first");
		assert.equal(job.id, 1);
		await submittedOnChain(1, job);
		assert.ok((await byName("first")).submittedAt);
	});

	test("an event for a job the database doesn't have is ignored, and not retried", async () => {
		const job = await saveJob("mine");
		await assert.doesNotReject(submittedOnChain(42, job, { quoteId: "unknown" }, "log-unknown"));
		assert.equal((await byName("mine")).submittedAt, null);
		assert.ok(await ChainEventModel.exists({ _id: "log-unknown" }), "recorded as processed");
	});

	test("an event the server doesn't know is ignored without changing the job", async () => {
		const { id } = await saveJob("mine");
		await assert.doesNotReject(handleChainEvent({ id: "log-new", name: "SOME_FUTURE_EVENT", args: { jobId: BigInt(id) }, blockNumber: 1n }, matcher));
		assert.equal((await byName("mine")).status, JobStatus.PENDING);
	});

	test("a job canceled before submission does not shift later events", async () => {
		const { id: canceled } = await saveJob("canceled before submitting");
		assert.equal((await call("POST", `/jobs/${canceled}/cancel`)).status, 200);
		const submitted = await saveJob("submitted");
		await submittedOnChain(1, submitted);
		const tracked = await byName("submitted");
		assert.ok(tracked.submittedAt);
		assert.equal(tracked.contractJobId, 1);
		assert.equal(tracked.onChainJobId, 2);
		assert.equal((await byName("canceled before submitting")).submittedAt, null);
	});

	test("jobs submitted out of save order keep their own events", async () => {
		await saveJob("saved first");
		const second = await saveJob("saved second");
		await submittedOnChain(1, second);
		assert.ok((await byName("saved second")).submittedAt);
		assert.equal((await byName("saved first")).submittedAt, null);
		await handleChainEvent({ name: "CANCELED", args: { jobId: 1n }, blockNumber: 2n }, matcher);
		assert.equal((await byName("saved second")).status, JobStatus.CANCELED);
		assert.equal((await byName("saved first")).status, JobStatus.PENDING);
	});

	test("wrong-wallet and mismatched funding cannot start work", async () => {
		const job = await saveJob("quote mismatch");
		await submittedOnChain(1, job, { buyer: `0x${"2".repeat(40)}` });
		assert.equal((await byName("quote mismatch")).submittedAt, null);

		await submittedOnChain(2, job, { price: 1n });
		const funded = await byName("quote mismatch");
		assert.equal(funded.contractJobId, 2);
		assert.match(funded.fundingError!, /differs from the saved quote/);
		assert.equal(await matcher.repository.getJob(String(job.id)), null);
		const detail = await call("GET", `/jobs/${job.id}`);
		assert.equal(detail.body.job.canCancel, true);
		assert.equal(detail.body.job.onChainJobId, 2);
	});
});
