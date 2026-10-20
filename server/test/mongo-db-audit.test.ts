// Database invariants and race conditions not covered by the other Mongo suites.
//
//   MONGODB_URI=mongodb://127.0.0.1:27017 node --test test/mongo-db-audit.test.ts
//
// Uses (and drops) its own database. Skipped when MONGODB_URI isn't set.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../app.ts";
import {
	AccountModel, AuthNonceModel, AuthTokenModel, CounterModel, HardwareModel, JobModel, JobStatus,
	hashToken, nextSeq,
} from "../models/index.ts";
import { decimalString } from "../models/decimal.ts";
import { Builder } from "../services/builder.ts";
import { handleChainEvent } from "../services/events.ts";
import { Matcher } from "../services/matcher.ts";

const MONGODB_URI = process.env.MONGODB_URI;
const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);
const w = (c: string) => `0x${c.repeat(40)}`;

const jobFields = (overrides: Record<string, unknown> = {}) => ({
	dockerImageDigest: DIGEST, maxPrice: "5", minNodesToRunOn: 2, minNodesToAgree: 2, timeWindow: 60,
	...overrides,
});

// Starts the real app with a fake chain; returns an authenticated fetch helper.
async function startApp(chain: unknown, matcher = new Matcher(null)) {
	const server: Server = createApp({ chain: chain as never, matcher, builder: new Builder() }, { log: false })
		.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const { port } = server.address() as { port: number };
	const call = async (method: string, url: string, token: string, body?: unknown) => {
		const res = await fetch(`http://127.0.0.1:${port}${url}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};
	return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function provider(c: string) {
	const account = await AccountModel.create({ walletIds: [w(c)] });
	await AuthTokenModel.create({ account: account._id, wallet: w(c), tokenHash: hashToken(`tok-${c}`) });
	await HardwareModel.create({ userRef: account._id, address: w(c), cpuScore: 10, memoryScore: 10, price: 1 });
	return account;
}

describe("database audit", { skip: !MONGODB_URI && "set MONGODB_URI to run" }, () => {
	before(async () => {
		await mongoose.connect(MONGODB_URI!, { dbName: `offbalance_audit_${randomUUID().replaceAll("-", "")}` });
		await mongoose.syncIndexes();
	});
	beforeEach(async () => {
		await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
	});
	after(async () => {
		await mongoose.connection.dropDatabase();
		await mongoose.disconnect();
	});

	describe("indexes", () => {
		test("unique and TTL indexes exist after syncIndexes", async () => {
			const idx = async (m: mongoose.Model<any>) => (await m.collection.indexes()) as any[];
			const find = (list: any[], key: string) => list.find((i) => Object.keys(i.key).join() === key);
			assert.equal(find(await idx(AccountModel), "walletIds")?.unique, true);
			assert.equal(find(await idx(JobModel), "onChainJobId")?.unique, true);
			assert.equal(find(await idx(HardwareModel), "userRef")?.unique, true);
			assert.equal(find(await idx(AuthTokenModel), "tokenHash")?.unique, true);
			assert.equal(find(await idx(AuthNonceModel), "wallet")?.unique, true);
			assert.equal(find(await idx(AuthNonceModel), "createdAt")?.expireAfterSeconds, 300);
		});
	});

	describe("accounts", () => {
		test("two accounts can't share a wallet, in any letter case", async () => {
			await AccountModel.create({ walletIds: [w("a")] });
			await assert.rejects(AccountModel.create({ walletIds: [w("A")] }), { code: 11000 });
		});

		test("queries match wallets regardless of letter case", async () => {
			const a = await AccountModel.create({ walletIds: [w("b")] });
			assert.ok((await AccountModel.findOne({ walletIds: w("B") }))?._id.equals(a._id));
		});

		// latent: the routes check `includes` before pushing, but the schema doesn't enforce it
		test("one account can't list the same wallet twice", { todo: "schema allows duplicates within one account" }, async () => {
			await assert.rejects(AccountModel.create({ walletIds: [w("c"), w("C")] }));
		});

		test("concurrent link and unlink on one account keep both changes", async () => {
			// Both requests load the account (in requireAuth) before either saves.
			const account = await AccountModel.create({ walletIds: [w("d"), w("e")] });
			const [first, second] = await Promise.all([AccountModel.findById(account._id), AccountModel.findById(account._id)]);
			first!.walletIds.push(w("f")); // POST /account/:id/wallets
			second!.walletIds = second!.walletIds.filter((x: string) => x !== w("e")); // DELETE /account/:id/wallets/:wallet
			await first!.save();
			await second!.save().catch(() => {}); // a VersionError here would also be acceptable
			const { walletIds } = (await AccountModel.findById(account._id))!;
			assert.ok(walletIds.includes(w("f")), `linked wallet was lost: ${walletIds}`);
		});
	});

	describe("jobs", () => {
		// latent: no route updates a job's quorum yet; the update validator only sees k if it's in the same update
		test("quorum can't be raised above k by an update", { todo: "validator ignores the stored minNodesToRunOn" }, async () => {
			const owner = await AccountModel.create({ walletIds: [w("1")] });
			const job = await JobModel.create(jobFields({ owner: owner._id, onChainJobId: 1 }));
			await assert.rejects(JobModel.updateOne({ _id: job._id }, { $set: { minNodesToAgree: 5 } }, { runValidators: true }));
		});

		test("nextSeq hands out unique ids under concurrency", async () => {
			const ids = await Promise.all(Array.from({ length: 50 }, () => nextSeq("jobId")));
			assert.equal(new Set(ids).size, 50);
			assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
			assert.equal((await CounterModel.findById("jobId"))!.seq, 50);
		});

		test("a small runningPrice written as String(number) round-trips as plain decimal", async () => {
			const owner = await AccountModel.create({ walletIds: [w("2")] });
			const job = await JobModel.create(jobFields({ owner: owner._id, onChainJobId: 2, runningPrice: String(1e-7) }));
			const stored = (await JobModel.findById(job._id))!.runningPrice!;
			assert.equal(decimalString(stored), "0.0000001");
		});
	});

	describe("deliveries", () => {
		async function deliveryFixture() {
			const owner = await AccountModel.create({ walletIds: [w("9")] });
			const p1 = await provider("3");
			const p2 = await provider("4");
			await JobModel.create(jobFields({
				owner: owner._id, onChainJobId: 7, submittedAt: new Date(),
				providers: [p1._id, p2._id], status: JobStatus.AWAITING_DELIVERY,
			}));
			return { p1, p2 };
		}

		test("concurrent first deliveries from two providers are both recorded", async () => {
			await deliveryFixture();
			const app = await startApp(null);
			try {
				const [a, b] = await Promise.all([
					app.call("POST", "/provider/results/7", "tok-3", { hash: "h3", location: "s3://3" }),
					app.call("POST", "/provider/results/7", "tok-4", { hash: "h4", location: "s3://4" }),
				]);
				assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify([a.body, b.body]));
				assert.equal((await JobModel.findOne({ onChainJobId: 7 }))!.results.length, 2);
			} finally { await app.close(); }
		});

		test("a delivery verified on-chain stays verified when another provider delivers meanwhile", async () => {
			const { p1 } = await deliveryFixture();
			let releaseFirst!: () => void;
			const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
			let calls = 0;
			const chain = {
				canWrite: true,
				// provider 3's receipt is slow on-chain; provider 4's is instant
				verifyReceipt: async () => { if (calls++ === 0) await firstPending; },
			};
			const app = await startApp(chain);
			try {
				const first = app.call("POST", "/provider/results/7", "tok-3", { hash: "h3", location: "s3://3" });
				while (calls === 0) await new Promise((r) => setTimeout(r, 5));
				const second = await app.call("POST", "/provider/results/7", "tok-4", { hash: "h4", location: "s3://4" });
				assert.equal(second.status, 201);
				releaseFirst();
				assert.equal((await first).status, 201);
				const job = (await JobModel.findOne({ onChainJobId: 7 }))!;
				const r1 = job.results.find((r) => r.provider.equals(p1._id));
				assert.equal(r1?.receiptVerified, true, "verifyReceipt succeeded but the database says unverified");
			} finally { await app.close(); }
		});

		test("redelivery replaces an unverified result; verified results and finished jobs refuse it", async () => {
			const { p1 } = await deliveryFixture();
			const app = await startApp(null);
			try {
				assert.equal((await app.call("POST", "/provider/results/7", "tok-3", { hash: "old", location: "s3://old" })).status, 201);
				const again = await app.call("POST", "/provider/results/7", "tok-3", { hash: "new", location: "s3://new" });
				assert.equal(again.status, 201);
				assert.equal(again.body.results[0].hash, "new");
				const job = (await JobModel.findOne({ onChainJobId: 7 }))!;
				assert.equal(job.results.length, 1);

				await JobModel.updateOne({ _id: job._id, "results.provider": p1._id }, { $set: { "results.$.receiptVerified": true } });
				const verified = await app.call("POST", "/provider/results/7", "tok-3", { hash: "x", location: "s3://x" });
				assert.equal(verified.status, 409);
				assert.match(verified.body.error, /already verified/);

				await JobModel.updateOne({ _id: job._id }, { $set: { status: JobStatus.PAYOUT } });
				assert.equal((await app.call("POST", "/provider/results/7", "tok-4", { hash: "h", location: "l" })).status, 409);
			} finally { await app.close(); }
		});

		test("a delivery doesn't move a job back out of PAYOUT", async () => {
			await deliveryFixture();
			const matcher = new Matcher(null);
			// DELIVERED lands between the route loading the job and saving it
			const findOne = JobModel.findOne;
			let injected = false;
			(JobModel as any).findOne = function (this: unknown, ...args: unknown[]) {
				const query = (findOne as any).apply(this, args);
				if (injected) return query;
				injected = true;
				return query.exec().then(async (doc: unknown) => {
					await handleChainEvent({ name: "DELIVERED", args: { jobId: 7n }, blockNumber: 0n }, matcher);
					return doc;
				});
			};
			const app = await startApp(null, matcher);
			try {
				await app.call("POST", "/provider/results/7", "tok-3", { hash: "h3", location: "s3://3" });
			} finally {
				(JobModel as any).findOne = findOne;
				await app.close();
			}
			assert.equal((await JobModel.findOne({ onChainJobId: 7 }))!.status, JobStatus.PAYOUT);
		});
	});
});
