// Races between the buyer and the matcher, against MongoDB and the real HTTP routes: a buyer
// cancelling a job at the moment the matcher assigns providers to it. Both sides use atomic
// "only if still pending with no providers" updates; this checks that under real concurrency a job
// ends up either canceled with nobody assigned, or assigned and not canceled, never both, and that
// a lost race never leaves a provider reserved for a job it isn't on.
//
// Skipped without MONGODB_URI.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { createApp } from "../app.ts";
import { connectDB, disconnectDB } from "../db.ts";
import { AccountModel, AuthTokenModel, HardwareModel, JobModel, JobStatus, hashToken } from "../models/index.ts";
import { Builder } from "../services/builder.ts";
import { Matcher } from "../services/matcher.ts";
import { hardwareFields } from "./helpers/hardware.ts";

const uri = process.env.MONGODB_URI;
const DIGEST = "docker.io/library/alpine@sha256:" + "a".repeat(64);
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("buyer and matcher races", { skip: !uri && "set MONGODB_URI to run" }, () => {
	let server: Server;
	let base = "";
	let matcher: Matcher;
	let buyer: mongoose.Types.ObjectId;
	const providerWallets = [wallet(11), wallet(12)];
	let nextId = 500;

	const cancel = (id: number) => fetch(`${base}/jobs/${id}/cancel`, { method: "POST", headers: { Authorization: "Bearer test-buyer" } });
	const pendingJob = () => JobModel.create({
		onChainJobId: nextId++, owner: buyer, dockerImageDigest: DIGEST, maxPrice: "1",
		minNodesToRunOn: 2, minNodesToAgree: 2, timeWindow: 60, submittedAt: new Date(),
	});
	const reservedFor = (id: number) => providerWallets.filter(w => matcher.manager.pool.get(w)?.busyJobId === String(id));

	// finish a matched job so its providers are free for the next one (what DELIVERED does)
	async function finish(id: number) {
		await JobModel.updateOne({ onChainJobId: id }, { status: JobStatus.PAYOUT });
		matcher.release(id);
	}

	before(async () => {
		const parsed = new URL(uri!);
		parsed.pathname = `/offbalance-concurrency-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		const owner = await AccountModel.create({ walletIds: [wallet(1)] });
		buyer = owner._id;
		await AuthTokenModel.create({ tokenHash: hashToken("test-buyer"), account: buyer, wallet: wallet(1) });
		for (const w of providerWallets) {
			const account = await AccountModel.create({ walletIds: [w] });
			const hardware = await HardwareModel.create({ userRef: account._id, address: w, ...hardwareFields(), price: 0.01 });
			account.hardware = hardware._id;
			await account.save();
		}
		matcher = new Matcher(null);
		server = createApp({ chain: null, matcher, builder: new Builder() }, { log: false }).listen(0, "127.0.0.1");
		await new Promise(resolve => server.once("listening", resolve));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	beforeEach(async () => {
		for (const w of providerWallets) assert.ok(await matcher.heartbeat(w), "provider is online");
		await matcher.idle();
	});
	after(async () => {
		if (server) await new Promise(resolve => server.close(resolve));
		await matcher?.idle().catch(() => {});
		// Always disconnect, even if MongoDB went away mid-test: an open client's heartbeat timer keeps the process alive.
		if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
		await disconnectDB().catch(() => {});
	});

	test("cancel before matching: the job is canceled and nobody is reserved", async () => {
		const job = await pendingJob();
		assert.equal((await cancel(job.onChainJobId)).status, 200);
		await matcher.ping();
		const saved = await JobModel.findById(job._id).orFail();
		assert.equal(saved.status, JobStatus.CANCELED);
		assert.equal(saved.providers.length, 0);
		assert.deepEqual(reservedFor(job.onChainJobId), []);
	});

	test("matching before cancel: the job keeps its providers and the cancel is refused", async () => {
		const job = await pendingJob();
		await matcher.ping();
		assert.equal((await JobModel.findById(job._id).orFail()).providers.length, 2);
		assert.equal((await cancel(job.onChainJobId)).status, 409);
		const saved = await JobModel.findById(job._id).orFail();
		assert.equal(saved.status, JobStatus.PENDING);
		assert.equal(saved.providers.length, 2);
		await finish(job.onChainJobId);
	});

	test("a cancel racing the matcher ends in exactly one outcome, every time", async () => {
		const outcomes = { canceled: 0, matched: 0, lostClaims: 0 };
		for (let round = 0; round < 40; round++) {
			const job = await pendingJob();
			// stagger the cancel by 0-57 ms so the two requests overlap at different points
			const delayed = new Promise(resolve => setTimeout(resolve, (round % 20) * 3)).then(() => cancel(job.onChainJobId));
			// When the cancel lands between the matcher choosing providers and saving the claim, the
			// claim is refused and ping() rejects (server code logs it as "Matching failed"). That's
			// the matcher losing the race correctly; the checks below still apply.
			const matching = matcher.ping().catch((error: Error) => {
				assert.match(error.message, /is no longer waiting/);
				outcomes.lostClaims++;
			});
			const [response] = await Promise.all([delayed, matching]);
			await matcher.idle().catch(() => {});
			const saved = await JobModel.findById(job._id).orFail();
			const why = `round ${round}: status ${saved.status}, ${saved.providers.length} providers, cancel ${response.status}`;
			if (saved.status === JobStatus.CANCELED) {
				outcomes.canceled++;
				assert.equal(response.status, 200, why);
				assert.equal(saved.providers.length, 0, `${why}: a canceled job has providers`);
				assert.deepEqual(reservedFor(job.onChainJobId), [], `${why}: providers still reserved for a canceled job`);
			} else {
				outcomes.matched++;
				assert.equal(saved.status, JobStatus.PENDING, why);
				assert.equal(response.status, 409, `${why}: the cancel claimed success but the job wasn't canceled`);
				assert.equal(saved.providers.length, 2, why);
				await finish(job.onChainJobId);
			}
			// whoever won, the providers are free again for the next round
			await matcher.ping();
			await matcher.idle();
			assert.deepEqual(providerWallets.filter(w => matcher.manager.pool.get(w)?.busyJobId), [], `${why}: a provider stayed busy`);
		}
		assert.equal(outcomes.canceled + outcomes.matched, 40, JSON.stringify(outcomes));
		// both sides must have won some rounds, or this didn't test a race
		assert.ok(outcomes.canceled > 0 && outcomes.matched > 0, `outcomes: ${JSON.stringify(outcomes)}`);
	});
});
