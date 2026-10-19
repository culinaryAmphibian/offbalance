// Real frontend-facing HTTP contracts backed by an isolated MongoDB database.
// MONGODB_URI=mongodb://127.0.0.1:27017 node --test test/frontend-contract.test.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, JobModel } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";

const uri = process.env.MONGODB_URI;
const image = `docker.io/library/alpine@sha256:${"a".repeat(64)}`;
const wallets = {
	buyer: privateKeyToAccount(`0x${"1".repeat(64)}`),
	other: privateKeyToAccount(`0x${"2".repeat(64)}`),
};
type Identity = keyof typeof wallets;
const sessions: Partial<Record<Identity, { token: string; accountId: string }>> = {};
const matcher = new Matcher(null);
let server: Server;
let base = "";

async function call(method: string, route: string, { as, body, key }: {
	as?: Identity; body?: unknown; key?: string;
} = {}) {
	const response = await fetch(base + route, {
		method,
		headers: {
			...(as ? { Authorization: `Bearer ${sessions[as]!.token}` } : {}),
			...(body ? { "Content-Type": "application/json" } : {}),
			...(key !== undefined ? { "Idempotency-Key": key } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function signIn(identity: Identity) {
	const account = wallets[identity];
	const challenge = await call("GET", `/auth/nonce?wallet=${account.address}`);
	assert.equal(challenge.status, 200);
	assert.equal(challenge.body.wallet, account.address.toLowerCase());
	assert.match(challenge.body.message, new RegExp(`^Sign in to OffBalance\\n\\nWallet: ${account.address.toLowerCase()}\\nNonce: [a-f0-9]{32}$`));
	const response = await call("POST", "/auth", {
		body: { wallet: account.address, signature: await account.signMessage({ message: challenge.body.message }) },
	});
	assert.equal(response.status, 201, JSON.stringify(response.body));
	assert.equal(response.body.wallet, account.address.toLowerCase());
	assert.equal(typeof response.body.token, "string");
	assert.equal(typeof response.body.accountId, "string");
	assert.equal(response.body.expiresAt, undefined, "sessions do not advertise a nonexistent expiry");
	sessions[identity] = response.body;
}

const job = (changes: Record<string, unknown> = {}) => ({
	name: "Frontend test job",
	dockerImageDigest: image,
	maxPrice: "0.001",
	minNodesToRunOn: 1,
	minNodesToAgree: 1,
	timeWindow: 60,
	requirements: { minCpuScore: 0, minGpuScore: 0, minMemoryScore: 0 },
	...changes,
});

describe("frontend/server database contracts", { skip: !uri && "set MONGODB_URI to run" }, () => {
	before(async () => {
		const isolated = new URL(uri!);
		isolated.pathname = `/offbalance_frontend_contract_${randomUUID().replaceAll("-", "")}`;
		await connectDB(isolated.toString());
		server = createApp({ chain: null, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise<void>(resolve => server.once("listening", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	after(async () => {
		if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await matcher.idle();
		try { await mongoose.connection.dropDatabase(); }
		finally { await disconnectDB(); }
	});

	test("wallet login returns verified identity and local configuration reports no contract", async () => {
		await signIn("buyer");
		await signIn("other");
		const response = await call("GET", "/config");
		assert.equal(response.status, 200);
		assert.deepEqual(response.body, { executionMode: "local", chain: null });
	});

	test("unregistered provider is a normal empty profile, without fabricated liveness", async () => {
		const response = await call("GET", "/provider/hardware", { as: "buyer" });
		assert.equal(response.status, 200);
		assert.deepEqual(response.body, { hardware: null, suggestedPrice: null, online: false, lastSeen: null });
		assert.equal((await call("GET", "/provider/hardware")).status, 401);
	});

	test("provider pricing rejects lossy decimal conversion without changing the saved rate", async () => {
		const scored = await call("POST", "/scores", { as: "buyer", body: { cpu: 100, mem: 200 } });
		assert.equal(scored.status, 201, JSON.stringify(scored.body));
		const initial = await call("POST", "/provider/price", { as: "buyer", body: { price: "0.1" } });
		assert.equal(initial.status, 200, JSON.stringify(initial.body));
		assert.equal(initial.body.hardware.price, 0.1);
		const rounded = await call("POST", "/provider/price", { as: "buyer", body: { price: "0.123456789012345678" } });
		assert.equal(rounded.status, 400, JSON.stringify(rounded.body));
		assert.match(rounded.body.error, /precision|exact|represent/i);
		const unchanged = await call("GET", "/provider/hardware", { as: "buyer" });
		assert.equal(unchanged.body.hardware.price, 0.1);
		assert.equal(unchanged.body.online, false, "benchmark and price updates do not establish liveness");
		for (const price of ["0.000000000000000001", "1e-18"]) {
			const precise = await call("POST", "/provider/price", { as: "buyer", body: { price } });
			assert.equal(precise.status, 200, JSON.stringify(precise.body));
			assert.equal(precise.body.hardware.price, 1e-18);
		}
	});

	test("job names persist and the same submission key replays its original job", async () => {
		const payload = job({ name: "Saved from the website" });
		const first = await call("POST", "/jobs", { as: "buyer", key: "frontend-retry", body: payload });
		assert.equal(first.status, 201, JSON.stringify(first.body));
		assert.equal(first.body.job.name, payload.name);
		assert.equal(first.body.job.executionMode, "local");
		assert.equal(first.body.job.canSubmit, false);
		assert.equal(first.body.job.canViewResults, true);
		assert.equal(first.body.job.requestKey, undefined, "internal retry metadata stays server-side");
		const replay = await call("POST", "/jobs", { as: "buyer", key: "frontend-retry", body: payload });
		assert.equal(replay.status, 200, JSON.stringify(replay.body));
		assert.equal(replay.body.job.id, first.body.job.id);
		assert.equal(await JobModel.countDocuments({ owner: sessions.buyer!.accountId, requestKey: "frontend-retry" }), 1);
		const owner = await AccountModel.findById(sessions.buyer!.accountId);
		const persisted = await JobModel.findOne({ onChainJobId: first.body.job.id });
		assert.equal(owner!.submittedJobs.filter(id => id.equals(persisted!._id)).length, 1);
		assert.equal((await call("GET", `/jobs/${first.body.job.id}`, { as: "buyer" })).body.job.name, payload.name);
		assert.equal((await call("GET", `/jobs/${first.body.job.id}`, { as: "other" })).status, 403);
	});

	test("concurrent duplicate HTTP submissions create only one durable job and account reference", async () => {
		const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/jobs", {
			as: "buyer", key: "frontend-concurrent", body: job({ name: "Concurrent retry" }),
		})));
		assert.equal(results.filter(response => response.status === 201).length, 1, JSON.stringify(results));
		assert.ok(results.every(response => [200, 201].includes(response.status)), JSON.stringify(results));
		assert.equal(new Set(results.map(response => response.body.job.id)).size, 1);
		const saved = await JobModel.find({ owner: sessions.buyer!.accountId, requestKey: "frontend-concurrent" });
		assert.equal(saved.length, 1);
		const owner = await AccountModel.findById(sessions.buyer!.accountId);
		assert.equal(owner!.submittedJobs.filter(id => id.equals(saved[0]._id)).length, 1);
	});

	test("retry keys bind the payload regardless of JSON object property order", async () => {
		const payload = job({ env: { SECOND: "b", FIRST: "a" } });
		const first = await call("POST", "/jobs", { as: "buyer", key: "frontend-payload", body: payload });
		assert.equal(first.status, 201, JSON.stringify(first.body));
		const reordered = Object.fromEntries(Object.entries({ ...payload, env: { FIRST: "a", SECOND: "b" } }).reverse());
		const same = await call("POST", "/jobs", { as: "buyer", key: "frontend-payload", body: reordered });
		assert.equal(same.status, 200);
		assert.equal(same.body.job.id, first.body.job.id);
		const changed = await call("POST", "/jobs", { as: "buyer", key: "frontend-payload", body: { ...payload, maxPrice: "0.002" } });
		assert.equal(changed.status, 409);
		assert.match(changed.body.error, /different job details/);
		assert.equal(await JobModel.countDocuments({ owner: sessions.buyer!.accountId, requestKey: "frontend-payload" }), 1);
	});

	test("the same key belongs independently to each authenticated owner", async () => {
		const [buyer, other] = await Promise.all((Object.keys(wallets) as Identity[]).map(as => call("POST", "/jobs", {
			as, key: "shared-key", body: job({ name: `Owned by ${as}` }),
		})));
		assert.equal(buyer.status, 201, JSON.stringify(buyer.body));
		assert.equal(other.status, 201, JSON.stringify(other.body));
		assert.notEqual(buyer.body.job.id, other.body.job.id);
		assert.equal(await JobModel.countDocuments({ requestKey: "shared-key" }), 2);
		const listed = await call("GET", "/jobs?role=buyer", { as: "other" });
		assert.deepEqual(listed.body.jobs.map((entry: { id: number }) => entry.id), [other.body.job.id]);
		assert.equal((await call("GET", `/jobs/${buyer.body.job.id}/result`, { as: "other" })).status, 403);
		const ownResults = await call("GET", `/jobs/${other.body.job.id}/result`, { as: "other" });
		assert.deepEqual(ownResults.body, { status: "PENDING", results: [] });
	});

	test("dashboard totals and full job lists remain distinct beyond the 20 recent jobs", async () => {
		await JobModel.create(Array.from({ length: 25 }, (_, index) => ({
			...job({ name: `History fixture ${index}` }), owner: sessions.buyer!.accountId, onChainJobId: 10_000 + index,
		})));
		const total = await JobModel.countDocuments({ owner: sessions.buyer!.accountId });
		const dashboard = await call("GET", "/account/me/dashboard", { as: "buyer" });
		assert.equal(dashboard.status, 200);
		assert.equal(dashboard.body.buyer.activeJobs, total);
		assert.equal(dashboard.body.buyer.completedJobs, 0);
		assert.equal(dashboard.body.buyer.jobs.length, 20);
		const listed = await call("GET", "/jobs?role=buyer", { as: "buyer" });
		assert.equal(listed.body.jobs.length, total);
		assert.ok(listed.body.jobs.every((entry: { owner: string }) => entry.owner === sessions.buyer!.accountId));
		assert.deepEqual((await call("GET", "/jobs?role=provider", { as: "buyer" })).body.jobs, []);
		assert.equal(dashboard.body.account.currentStake, "0");
	});

	test("small persisted ETH caps are returned as exact wallet-compatible decimal strings", async () => {
		for (const maxPrice of ["0.0000001", "0.000000000000000001"]) {
			const created = await call("POST", "/jobs", { as: "buyer", body: job({ maxPrice }) });
			assert.equal(created.status, 201, JSON.stringify(created.body));
			assert.equal(created.body.job.maxPrice, maxPrice);
			const detail = await call("GET", `/jobs/${created.body.job.id}`, { as: "buyer" });
			assert.equal(detail.body.job.maxPrice, maxPrice);
		}
	});

	test("unsafe IDs and malformed retry keys fail before persisting a job", async () => {
		for (const id of ["-1", "1.5", "9007199254740992", "not-a-job"]) {
			assert.equal((await call("GET", `/jobs/${id}`, { as: "buyer" })).status, 400, id);
			assert.equal((await call("GET", `/jobs/${id}/result`, { as: "buyer" })).status, 400, id);
		}
		const before = await JobModel.countDocuments();
		for (const key of ["spaces are invalid", "x".repeat(129)]) {
			assert.equal((await call("POST", "/jobs", { as: "buyer", body: job(), key })).status, 400);
		}
		assert.equal(await JobModel.countDocuments(), before);
	});

	test("logout returns 204 and removes the bearer token from the real database", async () => {
		const response = await call("POST", "/auth/logout", { as: "other" });
		assert.equal(response.status, 204);
		assert.equal(response.body, null);
		assert.equal((await call("GET", "/account/me/dashboard", { as: "other" })).status, 401);
		assert.equal((await call("GET", "/account/me/dashboard", { as: "buyer" })).status, 200);
	});
});
