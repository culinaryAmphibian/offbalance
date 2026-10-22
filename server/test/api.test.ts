// End-to-end tests of the real server's routes against MongoDB, without a chain
// (contract events are fed to the event handler directly).
//
//   MONGODB_URI=mongodb://127.0.0.1:27017 node --test test/api.test.ts
//
// Each run uses (and drops) its own database. Skipped when MONGODB_URI isn't set.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import mongoose from "mongoose";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { handleChainEvent } from "../services/events.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";

const MONGODB_URI = process.env.MONGODB_URI;
const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);

const env = Object.fromEntries(
	readFileSync(path.join(import.meta.dirname, "..", "..", "dev.env"), "utf8")
		.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const wallets = {
	buyer: privateKeyToAccount(env.BUYER_PRIVATE_KEY),
	p1: privateKeyToAccount(env.PROVIDER_1_PRIVATE_KEY),
	p2: privateKeyToAccount(env.PROVIDER_2_PRIVATE_KEY),
	p3: privateKeyToAccount(env.PROVIDER_3_PRIVATE_KEY),
	p4: privateKeyToAccount(env.PROVIDER_4_PRIVATE_KEY),
};
type Who = keyof typeof wallets;

let server: Server;
let base = "";
const matcher = new Matcher(null);
const tokens: Partial<Record<Who, string>> = {};
const accountIds: Partial<Record<Who, string>> = {};

async function call(method: string, url: string, { as, body }: { as?: Who; body?: unknown } = {}) {
	const res = await fetch(base + url, {
		method,
		headers: {
			...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}),
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(who: Who) {
	const w = wallets[who];
	const { body: { message } } = await call("GET", `/auth/nonce?wallet=${w.address}`);
	const res = await call("POST", "/auth", { body: { wallet: w.address, signature: await w.signMessage({ message }) } });
	assert.equal(res.status, 201, JSON.stringify(res.body));
	tokens[who] = res.body.token;
	accountIds[who] = res.body.accountId;
}

const job = (overrides: Record<string, unknown> = {}) => ({
	dockerImageDigest: DIGEST,
	command: ["sh", "-c", "echo hi > /output/out.txt"],
	maxPrice: "5",
	minNodesToRunOn: 2,
	minNodesToAgree: 2,
	timeWindow: 60,
	...overrides,
});

const event = (name: string, args: Record<string, unknown>) =>
	handleChainEvent({ name, args, blockNumber: 0n }, matcher);

describe("server API", { skip: !MONGODB_URI && "set MONGODB_URI to run" }, () => {
	before(async () => {
		const uri = new URL(MONGODB_URI!);
		uri.pathname = `/offbalance-test-${process.pid}-${Date.now()}`;
		await connectDB(uri.toString());
		server = createApp({ chain: null, matcher, builder: new Builder() }, { log: false }).listen(0);
		await new Promise((r) => server.once("listening", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	after(async () => {
		server?.close();
		await mongoose.connection.dropDatabase();
		await disconnectDB();
	});

	describe("auth", () => {
		test("sign in with a wallet creates the account once", async () => {
			await signIn("buyer");
			const first = accountIds.buyer;
			await signIn("buyer");
			assert.equal(accountIds.buyer, first);
		});

		test("rejects a signature from another wallet, and the nonce is single-use", async () => {
			const { body: { message } } = await call("GET", `/auth/nonce?wallet=${wallets.p1.address}`);
			const forged = await wallets.p2.signMessage({ message });
			assert.equal((await call("POST", "/auth", { body: { wallet: wallets.p1.address, signature: forged } })).status, 401);
			const real = await wallets.p1.signMessage({ message });
			assert.equal((await call("POST", "/auth", { body: { wallet: wallets.p1.address, signature: real } })).status, 401);
		});

		test("rejects bad tokens", async () => {
			const res = await fetch(`${base}/jobs`, { headers: { Authorization: "Bearer nope" } });
			assert.equal(res.status, 401);
		});
	});

	describe("job lifecycle", () => {
		let jobId: number;
		let waitingJobId: number;

		before(async () => {
			for (const who of ["p1", "p2", "p3", "p4"] as const) await signIn(who);
		});

		test("providers report scores and set prices", async () => {
			for (const [who, cpu, price] of [["p1", 100, 1], ["p2", 200, 2], ["p3", 300, 9]] as const) {
				const res = await fetch(`${base}/scores`, {
					method: "POST",
					headers: { Authorization: `Bearer ${tokens[who]}` },
					body: new URLSearchParams({ cpu: String(cpu), mem: "50" }),
				});
				assert.equal(res.status, 201);
				assert.equal((await call("POST", "/provider/price", { as: who, body: { price } })).status, 200);
				assert.equal((await call("POST", "/provider/heartbeat", { as: who })).status, 200);
			}
			const { body } = await call("GET", "/provider/hardware", { as: "p1" });
			assert.equal(body.hardware.address, wallets.p1.address.toLowerCase());
			assert.equal(body.hardware.gpuScore, null);
			assert.equal(body.suggestedPrice, 5.5); // no machine within 25% of p1's cpu, so the median of the others (2, 9)
		});

		test("rejects invalid jobs", async () => {
			const res = await call("POST", "/jobs", { as: "buyer", body: job({ minNodesToAgree: 3 }) });
			assert.equal(res.status, 400);
			assert.match(res.body.error, /minNodesToAgree/);
		});

		test("a job is matched to the cheapest k providers within budget", async () => {
			const res = await call("POST", "/jobs", { as: "buyer", body: job() });
			assert.equal(res.status, 201, JSON.stringify(res.body));
			jobId = res.body.job.id;
			await matcher.ping();

			const { body } = await call("GET", `/jobs/${jobId}`, { as: "buyer" });
			assert.deepEqual(body.job.providers.sort(), [accountIds.p1, accountIds.p2].sort());
			assert.equal(body.job.runningPrice, "2");
			assert.equal(body.job.status, "PENDING");
		});

		test("only assigned providers get the manifest", async () => {
			const ok = await call("GET", `/jobManifest/${jobId}`, { as: "p1" });
			assert.equal(ok.status, 200);
			assert.equal(ok.body.manifest.image, DIGEST);
			assert.deepEqual(ok.body.manifest.command, ["sh", "-c", "echo hi > /output/out.txt"]);
			assert.equal(ok.body.manifest.timeout_s, 60);
			assert.equal((await call("GET", `/jobManifest/${jobId}`, { as: "p3" })).status, 403);
			assert.equal((await call("GET", `/jobManifest/99999`, { as: "p1" })).status, 404);
		});

		test("busy providers aren't matched again; the job waits", async () => {
			// p3 is idle but over budget; p1/p2 are busy
			const res = await call("POST", "/jobs", { as: "buyer", body: job({ minNodesToRunOn: 1, minNodesToAgree: 1 }) });
			waitingJobId = res.body.job.id;
			await matcher.ping();
			const { body } = await call("GET", `/jobs/${waitingJobId}`, { as: "buyer" });
			assert.deepEqual(body.job.providers, []);
		});

		test("contract events move the status; providers deliver results", async () => {
			await event("COMMIT_PHASE_START", { jobId: BigInt(jobId), deadline: 60n });
			assert.equal((await call("GET", `/jobs/${jobId}`, { as: "p1" })).body.job.status, "COMMIT_PHASE");

			// no deliveries before the delivery phase
			assert.equal((await call("POST", `/provider/results/${jobId}`, { as: "p1", body: { hash: "0xab", location: "s3://x" } })).status, 409);

			await event("DELIVERY_PHASE_START", { jobId: BigInt(jobId) });
			const delivered = await call("POST", `/provider/results/${jobId}`, { as: "p1", body: { hash: "0xab", location: "s3://bucket/1" } });
			assert.equal(delivered.status, 201);
			assert.equal((await call("POST", `/provider/results/${jobId}`, { as: "p3", body: { hash: "0xab", location: "s3://x" } })).status, 403);

			const result = await call("GET", `/jobs/${jobId}/result`, { as: "buyer" });
			assert.equal(result.body.status, "DELIVERY_RECEIPT_VALIDATION");
			assert.equal(result.body.results.length, 1);
			assert.equal(result.body.results[0].location, "s3://bucket/1");
			assert.equal((await call("GET", `/jobs/${jobId}/result`, { as: "p1" })).status, 403);
		});

		test("payout frees the providers and the waiting job gets matched", async () => {
			await event("PAID", { jobId: BigInt(jobId), provider: wallets.p1.address, amount: 2_000_000_000_000_000_000n });
			await event("SLASHED", { jobId: BigInt(jobId), provider: wallets.p2.address, amount: 100_000_000_000_000n });
			await event("DELIVERED", { jobId: BigInt(jobId) });

			const waiting = await call("GET", `/jobs/${waitingJobId}`, { as: "buyer" });
			assert.deepEqual(waiting.body.job.providers, [accountIds.p1]);

			const p1 = await call("GET", "/account/me/dashboard", { as: "p1" });
			assert.equal(p1.body.provider.totalEarned, "2");
			assert.equal(p1.body.account.reputation, 1);
			assert.equal(p1.body.provider.completedJobs, 1);
			assert.equal(p1.body.provider.activeJobs, 1);
			assert.equal(p1.body.provider.hardware.price, 1);

			const buyer = await call("GET", `/account/${accountIds.buyer}/dashboard`, { as: "buyer" });
			assert.equal(buyer.body.buyer.totalSpent, "2");
			assert.equal(buyer.body.buyer.completedJobs, 1);
			assert.equal(buyer.body.buyer.jobs.length, 2);
			assert.equal(buyer.body.marketplace.providers, 3);
			assert.equal(buyer.body.marketplace.medianPrice, 2);

			assert.equal((await call("GET", `/account/${accountIds.p1}/dashboard`, { as: "buyer" })).status, 403);
		});

		test("provider view lists assigned jobs", async () => {
			const { body } = await call("GET", "/jobs?role=provider", { as: "p1" });
			assert.deepEqual(body.jobs.map((j: { id: number }) => j.id).sort(), [jobId, waitingJobId].sort());
		});

		test("cancel only while unassigned", async () => {
			assert.equal((await call("POST", `/jobs/${waitingJobId}/cancel`, { as: "buyer" })).status, 409);
			const res = await call("POST", "/jobs", { as: "buyer", body: job({ maxPrice: "0.1" }) });
			const id = res.body.job.id;
			assert.equal((await call("POST", `/jobs/${id}/cancel`, { as: "p1" })).status, 403);
			const canceled = await call("POST", `/jobs/${id}/cancel`, { as: "buyer" });
			assert.equal(canceled.body.job.status, "CANCELED");
		});
	});

	describe("account management", () => {
		test("link and unlink a wallet", async () => {
			const w = wallets.p4;
			// p4 already has an account, so linking it to the buyer conflicts
			let { body: { message } } = await call("GET", `/auth/nonce?wallet=${w.address}`);
			let res = await call("POST", "/account/me/wallets", { as: "buyer", body: { wallet: w.address, signature: await w.signMessage({ message }) } });
			assert.equal(res.status, 409);

			assert.equal((await call("DELETE", "/account/me", { as: "p4" })).status, 204);
			({ body: { message } } = await call("GET", `/auth/nonce?wallet=${w.address}`));
			res = await call("POST", "/account/me/wallets", { as: "buyer", body: { wallet: w.address, signature: await w.signMessage({ message }) } });
			assert.equal(res.status, 200);
			assert.equal(res.body.account.walletIds.length, 2);

			res = await call("DELETE", `/account/me/wallets/${w.address}`, { as: "buyer" });
			assert.deepEqual(res.body.account.walletIds, [wallets.buyer.address.toLowerCase()]);
			assert.equal((await call("DELETE", `/account/me/wallets/${wallets.buyer.address}`, { as: "buyer" })).status, 409);
		});

		test("can't delete an account with unfinished jobs", async () => {
			assert.equal((await call("DELETE", "/account/me", { as: "p1" })).status, 409);
		});
	});
});
