// The real server's error paths and less-travelled routes, against MongoDB and real wallet
// signatures: app-level handling (404, malformed JSON, body limits, CORS, /config), wallet
// sign-in edge cases, linking/unlinking wallets, deleting an account, job visibility and
// cancellation, result downloads, provider pricing/heartbeat/tutorial, and /contract_address.
//
// Skipped without MONGODB_URI.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import mongoose from "mongoose";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hardwareFields } from "./helpers/hardware.ts";

const uri = process.env.MONGODB_URI;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const deploymentFile = path.join(mkdtempSync(path.join(tmpdir(), "offbalance-edges-")), "localhost.json");
writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address: CONTRACT, abi: [{ type: "function", name: "x", inputs: [], outputs: [] }] }));
process.env.DEPLOYMENT_FILE = deploymentFile; // config reads it at import time

const { createApp } = await import("../app.ts");
const { connectDB, disconnectDB } = await import("../db.ts");
const { AccountModel, AuthTokenModel, HardwareModel, JobModel, JobStatus, TutorialModel } = await import("../models/index.ts");
const { Builder } = await import("../services/builder.ts");
const { Matcher } = await import("../services/matcher.ts");
const { StorageError } = await import("../storage/results.ts");
type Chain = import("../services/chain.ts").Chain;
type ResultStore = import("../storage/results.ts").ResultStore;

const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);
const users = ["buyer", "provider", "other", "loner"] as const;
type User = typeof users[number];
const keys = Object.fromEntries(users.map(u => [u, privateKeyToAccount(generatePrivateKey())])) as Record<User, PrivateKeyAccount>;
const tokens: Partial<Record<User, string>> = {};
const accountIds: Partial<Record<User, string>> = {};

// result storage whose reads can be made to misreport their size
let storedSizeOffset = 0;
const objects = new Map<string, Buffer>();
const store: ResultStore = {
	async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
	async get(key) {
		const bytes = objects.get(key);
		if (!bytes) throw new StorageError("missing", 404);
		return { body: Readable.from([bytes]), size: bytes.length + storedSizeOffset };
	},
	async delete(key) { objects.delete(key); },
};

describe("server API edge cases", { skip: !uri && "set MONGODB_URI to run" }, () => {
	const servers: Server[] = [];
	let base = "", chained = "", noStorage = "";
	let nextJobId = 70_000;

	async function listen(chain: Chain | null, results: ResultStore | null) {
		const server = createApp({ chain, matcher: new Matcher(null), builder: new Builder(), results }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => server.once("listening", resolve));
		servers.push(server);
		return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}

	async function call(method: string, url: string, { as, body, at = base, headers = {} }: { as?: User; body?: unknown; at?: string; headers?: Record<string, string> } = {}) {
		const res = await fetch(at + url, {
			method,
			headers: {
				...(as ? { Authorization: `Bearer ${tokens[as]}` } : {}),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...headers,
			},
			body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		});
		const text = await res.text();
		let parsed: any = null;
		try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
		return { status: res.status, body: parsed, headers: res.headers };
	}

	async function signedNonce(wallet: PrivateKeyAccount) {
		const { body: { message } } = await call("GET", `/auth/nonce?wallet=${wallet.address}`);
		return wallet.signMessage({ message });
	}

	async function signIn(who: User) {
		const res = await call("POST", "/auth", { body: { wallet: keys[who].address, signature: await signedNonce(keys[who]) } });
		assert.equal(res.status, 201, JSON.stringify(res.body));
		tokens[who] = res.body.token;
		accountIds[who] = res.body.accountId;
	}

	const createJob = (overrides: Record<string, unknown> = {}) => JobModel.create({
		onChainJobId: nextJobId++, owner: accountIds.buyer, dockerImageDigest: DIGEST,
		maxPrice: "1", minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60, ...overrides,
	});

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-edges-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		base = await listen(null, store);
		// the job routes only check whether there's a chain, so a stand-in is enough
		chained = await listen({ supportsDeliveryReceipts: false } as unknown as Chain, store);
		noStorage = await listen(null, null);
		for (const who of users) await signIn(who);
	});

	after(async () => {
		await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
		rmSync(path.dirname(deploymentFile), { recursive: true, force: true });
		// Always disconnect, even if MongoDB went away mid-test: an open client's heartbeat timer keeps the process alive.
		if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
		await disconnectDB().catch(() => {});
	});

	describe("app", () => {
		test("unknown routes are a JSON 404 naming the route", async () => {
			const res = await call("GET", "/nope");
			assert.equal(res.status, 404);
			assert.equal(res.body.error, "no route for GET /nope");
		});

		test("malformed JSON is a 400, and a body over 1 MB is a 413", async () => {
			const malformed = await call("POST", "/jobs", { as: "buyer", body: "{not json" });
			assert.equal(malformed.status, 400);
			assert.equal(malformed.body.error, "malformed JSON body");
			const huge = await call("POST", "/jobs", { as: "buyer", body: JSON.stringify({ name: "x".repeat(1024 * 1024 + 1) }) });
			assert.equal(huge.status, 413);
		});

		test("CORS: allowed origins get the headers and a 204 preflight; others get none", async () => {
			const preflight = await call("OPTIONS", "/jobs", { headers: { Origin: "http://localhost:5173" } });
			assert.equal(preflight.status, 204);
			assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
			assert.match(preflight.headers.get("access-control-allow-headers")!, /Authorization/);
			assert.match(preflight.headers.get("access-control-allow-headers")!, /Idempotency-Key/);
			const foreign = await call("GET", "/config", { headers: { Origin: "https://evil.example" } });
			assert.equal(foreign.headers.get("access-control-allow-origin"), null);
		});

		test("/config reports local mode and no contract when there's no chain", async () => {
			assert.deepEqual((await call("GET", "/config")).body, { executionMode: "local", chain: null });
		});
	});

	describe("wallet sign-in", () => {
		test("a nonce needs a real address", async () => {
			for (const wallet of ["", "0x123", "not-an-address"]) {
				assert.equal((await call("GET", `/auth/nonce?wallet=${wallet}`)).status, 400, wallet);
			}
		});

		test("a malformed or missing signature is a 401, not a server error", async () => {
			for (const signature of ["0x1234", "nonsense", 42, undefined]) {
				await signedNonce(keys.other); // a fresh nonce each time
				const res = await call("POST", "/auth", { body: { wallet: keys.other.address, signature } });
				assert.equal(res.status, 401, String(signature));
			}
		});

		test("signing in without asking for a nonce first fails", async () => {
			const signature = await keys.other.signMessage({ message: "anything" });
			assert.equal((await call("POST", "/auth", { body: { wallet: keys.other.address, signature } })).status, 401);
		});

		test("logout revokes only that token", async () => {
			const first = tokens.other;
			await signIn("other");
			const second = tokens.other;
			tokens.other = first;
			assert.equal((await call("POST", "/auth/logout", { as: "other" })).status, 204);
			assert.equal((await call("GET", "/jobs", { as: "other" })).status, 401);
			tokens.other = second;
			assert.equal((await call("GET", "/jobs", { as: "other" })).status, 200);
		});
	});

	describe("linking and unlinking wallets", () => {
		test("links a second wallet with its signature; the same wallet links once", async () => {
			const extra = privateKeyToAccount(generatePrivateKey());
			const link = async () => call("POST", "/account/me/wallets", { as: "other",
				body: { wallet: extra.address, signature: await signedNonce(extra) } });
			const res = await link();
			assert.equal(res.status, 200, JSON.stringify(res.body));
			assert.deepEqual(res.body.account.walletIds, [keys.other.address.toLowerCase(), extra.address.toLowerCase()]);
			assert.equal((await link()).body.account.walletIds.length, 2);
		});

		test("rejects a bad signature, and a wallet that belongs to another account", async () => {
			const extra = privateKeyToAccount(generatePrivateKey());
			await signedNonce(extra);
			const forged = await keys.other.signMessage({ message: "not the nonce" });
			assert.equal((await call("POST", "/account/me/wallets", { as: "other", body: { wallet: extra.address, signature: forged } })).status, 401);
			// the buyer's wallet is already the buyer's account
			const taken = await call("POST", "/account/me/wallets", { as: "other",
				body: { wallet: keys.buyer.address, signature: await signedNonce(keys.buyer) } });
			assert.equal(taken.status, 409);
		});

		test("unlinking: unknown wallet 404, only wallet 409; unlinking revokes that wallet's tokens", async () => {
			assert.equal((await call("DELETE", `/account/me/wallets/0x${"9".repeat(40)}`, { as: "loner" })).status, 404);
			const only = await call("DELETE", `/account/me/wallets/${keys.loner.address}`, { as: "loner" });
			assert.equal(only.status, 409);
			assert.match(only.body.error, /only wallet/);

			const extra = privateKeyToAccount(generatePrivateKey());
			await call("POST", "/account/me/wallets", { as: "loner", body: { wallet: extra.address, signature: await signedNonce(extra) } });
			const extraToken = (await call("POST", "/auth", { body: { wallet: extra.address, signature: await signedNonce(extra) } })).body.token;
			const viaExtra = { Authorization: `Bearer ${extraToken}` };
			assert.equal((await fetch(`${base}/jobs`, { headers: viaExtra })).status, 200);
			// unlinking is case-insensitive
			const res = await call("DELETE", `/account/me/wallets/${extra.address.toUpperCase().replace("0X", "0x")}`, { as: "loner" });
			assert.equal(res.status, 200);
			assert.equal((await fetch(`${base}/jobs`, { headers: viaExtra })).status, 401);
			assert.equal((await call("GET", "/jobs", { as: "loner" })).status, 200, "the other wallet's token still works");
		});
	});

	describe("deleting an account", () => {
		test("refuses while the account has unfinished jobs, then deletes everything", async () => {
			const job = await createJob({ owner: accountIds.loner, status: JobStatus.COMMIT_PHASE });
			const refused = await call("DELETE", "/account/me", { as: "loner" });
			assert.equal(refused.status, 409);
			assert.match(refused.body.error, /1 unfinished job/);

			await JobModel.updateOne({ _id: job._id }, { status: JobStatus.PAYOUT });
			await HardwareModel.create({ userRef: accountIds.loner, address: keys.loner.address.toLowerCase(), ...hardwareFields() });
			assert.equal((await call("DELETE", "/account/me", { as: "loner" })).status, 204);
			assert.equal(await AccountModel.findById(accountIds.loner), null);
			assert.equal(await HardwareModel.findOne({ userRef: accountIds.loner }), null);
			assert.equal(await AuthTokenModel.countDocuments({ account: accountIds.loner }), 0);
			assert.equal((await call("GET", "/jobs", { as: "loner" })).status, 401);
		});

		test("another account's id is not mine to delete", async () => {
			assert.equal((await call("DELETE", `/account/${accountIds.buyer}`, { as: "other" })).status, 403);
			assert.ok(await AccountModel.findById(accountIds.buyer));
		});
	});

	describe("job visibility", () => {
		test("bad and unknown job ids", async () => {
			assert.equal((await call("GET", "/jobs/abc", { as: "buyer" })).status, 400);
			assert.equal((await call("GET", "/jobs/-1", { as: "buyer" })).status, 400);
			assert.equal((await call("GET", "/jobs/999999999", { as: "buyer" })).status, 404);
		});

		test("the buyer and the job's providers can see it; nobody else can", async () => {
			const job = await createJob({ providers: [accountIds.provider] });
			assert.equal((await call("GET", `/jobs/${job.onChainJobId}`, { as: "buyer" })).status, 200);
			const asProvider = await call("GET", `/jobs/${job.onChainJobId}`, { as: "provider" });
			assert.equal(asProvider.status, 200);
			assert.equal(asProvider.body.job.canViewResults, false);
			assert.equal(asProvider.body.job.canCancel, false);
			assert.equal(asProvider.body.job.submitWallet, undefined, "only the owner sees the submission wallet");
			assert.equal((await call("GET", `/jobs/${job.onChainJobId}`, { as: "other" })).status, 403);
			const providerList = await call("GET", "/jobs?role=provider", { as: "provider" });
			assert.ok(providerList.body.jobs.some((j: { id: number }) => j.id === job.onChainJobId));
			const buyerList = await call("GET", "/jobs?role=buyer", { as: "provider" });
			assert.ok(!buyerList.body.jobs.some((j: { id: number }) => j.id === job.onChainJobId));
		});
	});

	describe("cancelling a job", () => {
		test("without a chain: the buyer cancels a pending job, once", async () => {
			const job = await createJob();
			assert.equal((await call("POST", `/jobs/${job.onChainJobId}/cancel`, { as: "other" })).status, 403);
			const res = await call("POST", `/jobs/${job.onChainJobId}/cancel`, { as: "buyer" });
			assert.equal(res.status, 200);
			assert.equal(res.body.job.status, JobStatus.CANCELED);
			const saved = await JobModel.findById(job._id).orFail();
			assert.ok(saved.settledAt, "settled right away without a chain");
			assert.ok((await AccountModel.findById(accountIds.buyer).orFail()).completedJobs.some(id => id.equals(job._id)));
			assert.equal((await call("POST", `/jobs/${job.onChainJobId}/cancel`, { as: "buyer" })).status, 409);
		});

		test("a job with providers assigned can't be canceled", async () => {
			const job = await createJob({ providers: [accountIds.provider] });
			const res = await call("POST", `/jobs/${job.onChainJobId}/cancel`, { as: "buyer" });
			assert.equal(res.status, 409);
			assert.match(res.body.error, /providers assigned/);
		});

		test("with a chain: a job not yet on-chain is canceled here, an on-chain one only from the wallet", async () => {
			const offChain = await createJob();
			const res = await call("POST", `/jobs/${offChain.onChainJobId}/cancel`, { as: "buyer", at: chained });
			assert.equal(res.status, 200);
			assert.equal((await JobModel.findById(offChain._id).orFail()).settledAt, null, "the chain settles it, not the server");

			const onChain = await createJob({ submittedAt: new Date() });
			const refused = await call("POST", `/jobs/${onChain.onChainJobId}/cancel`, { as: "buyer", at: chained });
			assert.equal(refused.status, 409);
			assert.equal(refused.body.error, `job is on-chain; call cancelJob(${onChain.onChainJobId}) from your wallet`);
			assert.equal((await JobModel.findById(onChain._id).orFail()).status, JobStatus.PENDING);
		});
	});

	describe("result downloads", () => {
		const verified = async () => {
			const bytes = Buffer.from("archive bytes");
			const location = `jobs/edge/${Date.now()}-${Math.random()}.tar`;
			objects.set(location, bytes);
			const { createHash } = await import("node:crypto");
			return createJob({ status: JobStatus.PAYOUT, results: [{
				provider: accountIds.provider, hash: "a".repeat(64), location, deliveryTime: new Date(),
				contentVerified: true, receiptMode: "local", archiveHash: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length, retainedUntil: new Date(Date.now() + 86_400_000),
			}] });
		};

		test("no verified result is a 404", async () => {
			const job = await createJob();
			assert.equal((await call("GET", `/jobs/${job.onChainJobId}/result`, { as: "buyer" })).status, 404);
		});

		test("disabled result storage is a 503", async () => {
			const job = await verified();
			const res = await call("GET", `/jobs/${job.onChainJobId}/result`, { as: "buyer", at: noStorage });
			assert.equal(res.status, 503);
			assert.equal(res.body.error, "result storage is disabled");
		});

		test("a stored object whose size doesn't match the verified result is a 502, before any bytes", async () => {
			const job = await verified();
			storedSizeOffset = 1;
			try {
				const res = await call("GET", `/jobs/${job.onChainJobId}/result`, { as: "buyer" });
				assert.equal(res.status, 502);
				assert.equal(res.body.error, "stored result size does not match the verified artifact");
			} finally { storedSizeOffset = 0; }
			assert.equal((await call("GET", `/jobs/${job.onChainJobId}/result`, { as: "buyer" })).status, 200);
		});
	});

	describe("provider routes", () => {
		test("the tutorial is a 404 until one exists, then the newest one", async () => {
			assert.equal((await call("GET", "/provider/tutorial")).status, 404);
			await TutorialModel.create({ text: "old" });
			await new Promise(resolve => setTimeout(resolve, 5));
			await TutorialModel.create({ text: "Run the client." });
			const res = await call("GET", "/provider/tutorial");
			assert.equal(res.status, 200);
			assert.equal(res.body.text, "Run the client.");
		});

		test("pricing and heartbeats need a benchmarked machine first", async () => {
			const price = await call("POST", "/provider/price", { as: "other", body: { price: 1 } });
			assert.equal(price.status, 404);
			assert.match(price.body.error, /run the provider client/);
			assert.equal((await call("POST", "/provider/heartbeat", { as: "other" })).status, 409);
			const hw = await call("GET", "/provider/hardware", { as: "other" });
			assert.deepEqual(hw.body, { hardware: null, suggestedPrice: null, online: false, lastSeen: null });
		});

		test("rejects prices that aren't non-negative ETH amounts", async () => {
			for (const price of ["abc", -1, null, true, "1e400", "0.0000000000000000001"]) {
				assert.equal((await call("POST", "/provider/price", { as: "provider", body: { price } })).status, 400, String(price));
			}
		});

		test("result uploads: disabled storage 503, missing hash header 400", async () => {
			const job = await createJob({ providers: [accountIds.provider], status: JobStatus.AWAITING_DELIVERY });
			const upload = (at: string, headers: Record<string, string>) => fetch(`${at}/provider/results/${job.onChainJobId}`, {
				method: "POST", headers: { Authorization: `Bearer ${tokens.provider}`, "Content-Type": "application/x-tar", ...headers },
				body: Buffer.alloc(1024),
			});
			assert.equal((await upload(noStorage, { "X-Result-Hash": "a".repeat(64) })).status, 503);
			assert.equal((await upload(base, {})).status, 400);
			assert.equal((await upload(base, { "X-Result-Hash": "not-hex" })).status, 400);
		});
	});

	describe("client routes on the real server", () => {
		test("/contract_address returns the deployment, and 503 when it can't be read", async () => {
			const res = await call("GET", "/contract_address", { as: "provider" });
			assert.equal(res.status, 200);
			assert.equal(res.body.address, CONTRACT);
			assert.equal(res.body.chainId, 31337);
			assert.equal(res.body.abi.length, 1);
			writeFileSync(deploymentFile, "{ not json");
			try {
				const broken = await call("GET", "/contract_address", { as: "provider" });
				assert.equal(broken.status, 503);
				assert.match(broken.body.error, /deployment file/);
			} finally {
				writeFileSync(deploymentFile, JSON.stringify({ chainId: 31337, address: CONTRACT, abi: [] }));
			}
		});

		test("/jobManifest rejects ids that aren't non-negative integers", async () => {
			for (const id of ["abc", "-1", "1.5"]) {
				assert.equal((await call("GET", `/jobManifest/${id}`, { as: "provider" })).status, 400, id);
			}
		});
	});
});
