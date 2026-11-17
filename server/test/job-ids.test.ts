// Contract events vs. database jobs, against MongoDB and the real HTTP routes.
//
// The server numbers jobs itself (nextSeq("jobId") in POST /jobs), and the contract numbers them
// too (nextJobId in submitJob, from 1). Events are matched to database jobs by that number
// alone, so the two counters must stay in step. The todo tests below show two ordinary buyer
// actions that put them out of step.
//
// Skipped without MONGODB_URI. Uses its own database, so both counters start at 1.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, AuthTokenModel, ChainEventModel, CounterModel, JobModel, JobStatus, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import type { Chain } from "../services/chain.ts";
import { handleChainEvent } from "../services/events.ts";
import { Matcher } from "../services/matcher.ts";

const uri = process.env.MONGODB_URI;
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
		return res.body.job.id as number;
	};
	// what the contract emits for the n-th submitJob it receives
	const submittedOnChain = (contractJobId: number, id = `log-${contractJobId}-${Math.random()}`) =>
		handleChainEvent({ id, name: "JOB_SUBMITTED", args: { jobId: BigInt(contractJobId) }, blockNumber: 1n }, matcher);
	const byName = (name: string) => JobModel.findOne({ name }).orFail();

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-jobids-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		const wallet = `0x${"1".repeat(40)}`;
		const account = await AccountModel.create({ walletIds: [wallet] });
		await AuthTokenModel.create({ tokenHash: hashToken("test-buyer"), account: account._id, wallet });
		// a chain, so saved jobs wait for JOB_SUBMITTED; the job routes only check that there is one
		server = createApp({ chain: {} as Chain, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
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
		const id = await saveJob("first");
		assert.equal(id, 1);
		await submittedOnChain(1);
		assert.ok((await byName("first")).submittedAt);
	});

	test("an event for a job the database doesn't have is ignored, and not retried", async () => {
		await saveJob("mine");
		await assert.doesNotReject(submittedOnChain(42, "log-unknown"));
		assert.equal((await byName("mine")).submittedAt, null);
		assert.ok(await ChainEventModel.exists({ _id: "log-unknown" }), "recorded as processed");
	});

	test("an event the server doesn't know is ignored without changing the job", async () => {
		const id = await saveJob("mine");
		await assert.doesNotReject(handleChainEvent({ id: "log-new", name: "SOME_FUTURE_EVENT", args: { jobId: BigInt(id) }, blockNumber: 1n }, matcher));
		assert.equal((await byName("mine")).status, JobStatus.PENDING);
	});

	test("a job canceled before it reached the chain doesn't shift later jobs' events",
		{ todo: "POST /jobs numbers jobs with nextSeq, but the contract numbers only the jobs submitted to it" },
		async () => {
			const canceled = await saveJob("canceled before submitting");
			assert.equal((await call("POST", `/jobs/${canceled}/cancel`)).status, 200);
			await saveJob("submitted");
			// the contract has seen one submitJob, so it calls this job 1; the database calls it 2
			await submittedOnChain(1);
			assert.ok((await byName("submitted")).submittedAt, "the submitted job is marked submitted");
			assert.equal((await byName("canceled before submitting")).submittedAt, null, "the canceled job is untouched");
		});

	test("jobs submitted in a different order than they were saved keep their own events",
		{ todo: "POST /jobs numbers jobs with nextSeq, but the contract numbers them in submission order" },
		async () => {
			await saveJob("saved first");
			await saveJob("saved second");
			// the buyer submits the second one first: on chain it's job 1
			await submittedOnChain(1);
			assert.ok((await byName("saved second")).submittedAt, "the job that was submitted is marked submitted");
			assert.equal((await byName("saved first")).submittedAt, null, "the job that wasn't is untouched");
		});
});
