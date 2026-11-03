import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { pack } from 'tar-stream';
import { keccak256 } from 'viem';
import { createApp } from '../app.ts';
import { connectDB, disconnectDB } from '../db.ts';
import { AccountModel, AuthTokenModel, JobModel, JobStatus, hashToken } from '../models/index.ts';
import { Builder } from '../services/builder.ts';
import { Matcher } from '../services/matcher.ts';
import type { Chain } from '../services/chain.ts';
import { inspectArchive } from '../storage/archive.ts';
import { StorageError, type ResultStore } from '../storage/results.ts';

const uri = process.env.MONGODB_URI;
const objects = new Map<string, Buffer>();
let writes = 0, deletes = 0, failPut = false, failGet = false;
const store: ResultStore = {
	async put(key, bytes) { writes++; if (failPut) throw new StorageError('sanitized', 502); objects.set(key, Buffer.from(bytes)); },
	async get(key) { if (failGet) throw new StorageError('sanitized', 502); const bytes = objects.get(key); if (!bytes) throw new StorageError('missing', 404); return { body: Readable.from([bytes]), size: bytes.length }; },
	async delete(key) { deletes++; objects.delete(key); },
};
const users = ['buyer', 'provider', 'other'] as const;
type User = typeof users[number];
const accounts: Partial<Record<User, mongoose.Types.ObjectId>> = {};
const wallets = Object.fromEntries(users.map((name, i) => [name, `0x${String(i + 1).padStart(40, '0')}`]));
let local = '', chained = '', server: Server, chainServer: Server, nextId = 9000;
let bytes: Buffer, hash: string;
let supportsDeliveryReceipts = true, canWrite = true;
let agreed = true, revealed = true, chainDelivered = false, wrongChainHash = false, receiptCalls = 0, receiptFails = false;
const chain = {
	get canWrite() { return canWrite; },
	get supportsDeliveryReceipts() { return supportsDeliveryReceipts; },
	async getProviderDeliveryState() { return { outputHash: wrongChainHash ? `0x${'0'.repeat(64)}` : keccak256(`0x${hash}`), revealed, agreed, delivered: chainDelivered }; },
	async verifyReceipt() { receiptCalls++; if (receiptFails) throw new Error('not mined'); chainDelivered = true; },
} as unknown as Chain;

async function listen(chain: Chain | null): Promise<{ server: Server; url: string }> {
	const server = createApp({ chain, matcher: new Matcher(null), builder: new Builder(), results: store }, { log: false }).listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function job() {
	return JobModel.create({ onChainJobId: nextId++, owner: accounts.buyer, providers: [accounts.provider],
		dockerImageDigest: 'docker.io/library/alpine@sha256:' + 'a'.repeat(64), maxPrice: '1',
		minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60, status: JobStatus.AWAITING_DELIVERY });
}
function upload(id: number, { as = 'provider' as User | null, url = local, data = bytes, digest = hash, type = 'application/x-tar' } = {}) {
	return fetch(`${url}/provider/results/${id}`, { method: 'POST', headers: {
		...(as ? { Authorization: `Bearer test-${as}` } : {}), 'Content-Type': type, 'X-Result-Hash': digest,
	}, body: data });
}
function download(id: number, as: User = 'buyer') {
	return fetch(`${local}/jobs/${id}/result`, { headers: { Authorization: `Bearer test-${as}` } });
}

describe('verified result delivery routes', { skip: !uri && 'set MONGODB_URI to run' }, () => {
	before(async () => {
		const parsed = new URL(uri!); parsed.pathname = `/offbalance-result-test-${process.pid}-${Date.now()}`;
		await connectDB(parsed.toString());
		for (const user of users) {
			const account = await AccountModel.create({ walletIds: [wallets[user]] }); accounts[user] = account._id;
			await AuthTokenModel.create({ tokenHash: hashToken(`test-${user}`), account: account._id, wallet: wallets[user] });
		}
		({ server, url: local } = await listen(null));
		({ server: chainServer, url: chained } = await listen(chain));
		const tar = pack(); tar.entry({ name: 'result.txt' }, 'actual result\n'); tar.finalize();
		const chunks: Buffer[] = []; for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
		bytes = Buffer.concat(chunks); hash = (await inspectArchive(bytes)).hash;
	});
	beforeEach(() => {
		objects.clear(); writes = deletes = receiptCalls = 0; failPut = failGet = receiptFails = wrongChainHash = chainDelivered = false;
		agreed = revealed = supportsDeliveryReceipts = canWrite = true;
	});
	after(async () => {
		await Promise.all([server, chainServer].filter(Boolean).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
		await mongoose.connection.dropDatabase(); await disconnectDB();
	});

	test('unauthenticated, unassigned and out-of-phase requests cannot store objects', async () => {
		const j = await job();
		assert.equal((await upload(j.onChainJobId, { as: null })).status, 401);
		assert.equal((await upload(j.onChainJobId, { as: 'other' })).status, 403);
		await JobModel.updateOne({ _id: j._id }, { $set: { status: JobStatus.COMMIT_PHASE } });
		assert.equal((await upload(j.onChainJobId)).status, 409); assert.equal(writes, 0);
	});

	test('rejects metadata-only delivery, wrong hashes, malformed archives and oversized bodies', async () => {
		const j = await job();
		assert.equal((await upload(j.onChainJobId, { type: 'application/json', data: Buffer.from('{"hash":"x","location":"https://evil"}') })).status, 415);
		assert.equal((await upload(j.onChainJobId, { digest: '0'.repeat(64) })).status, 422);
		assert.equal((await upload(j.onChainJobId, { data: Buffer.from('not a tar') })).status, 400);
		assert.equal((await upload(j.onChainJobId, { data: Buffer.alloc(25 * 1024 * 1024 + 1) })).status, 413);
		assert.equal(writes, 0);
	});

	test('local delivery verifies bytes while preserving hardware requirements and derived Docker limits', async () => {
		const j = await job();
		j.requirements = { minVcpus: 4, minMemoryGb: 8, gpu: 'nvidia', minGpuVramGb: 6 };
		await j.save();
		const response = await upload(j.onChainJobId); assert.equal(response.status, 201);
		const result = await response.json(); assert.equal(result.receiptPending, false);
		assert.equal(result.results[0].contentVerified, true); assert.equal(result.results[0].receiptVerified, false);
		assert.equal(result.results[0].location, undefined);
		const saved = await JobModel.findById(j._id); assert.equal(saved!.status, JobStatus.DELIVERY_RECEIPT_VALIDATION);
		const detail = await fetch(`${local}/jobs/${j.onChainJobId}`, { headers: { Authorization: 'Bearer test-buyer' } });
		const info = await detail.json(); assert.equal(info.job.result.available, true); assert.equal(info.job.result.hash, hash);
		assert.deepEqual(info.job.requirements, { minVcpus: 4, minMemoryGb: 8, gpu: 'nvidia', minGpuVramGb: 6 });
		assert.equal(info.job.cpuLimit, 4); assert.equal(info.job.memLimitMb, 8192);
		assert.equal(JSON.stringify(info).includes('jobs/'), false);
	});

	test('owner downloads exact archive bytes; providers and other buyers cannot download', async () => {
		const j = await job(); await upload(j.onChainJobId);
		assert.equal((await download(j.onChainJobId, 'provider')).status, 403);
		assert.equal((await download(j.onChainJobId, 'other')).status, 403);
		const response = await download(j.onChainJobId); assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'application/x-tar');
		assert.match(response.headers.get('content-disposition')!, /\.tar/);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
	});

	test('identical retries keep one object and one result; changed archives conflict', async () => {
		const j = await job(); await upload(j.onChainJobId);
		assert.equal((await upload(j.onChainJobId)).status, 200); assert.equal(writes, 1); assert.equal(objects.size, 1);
		const tar = pack(); tar.entry({ name: 'result.txt' }, 'different output'); tar.finalize();
		const chunks: Buffer[] = []; for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
		const alternate = Buffer.concat(chunks);
		assert.equal((await upload(j.onChainJobId, { data: alternate, digest: (await inspectArchive(alternate)).hash })).status, 409);
		assert.equal((await JobModel.findById(j._id))!.results.length, 1);
	});

	test('concurrent deliveries publish one immutable result and discard the losing object', async () => {
		const j = await job();
		const responses = await Promise.all([upload(j.onChainJobId), upload(j.onChainJobId)]);
		assert.equal(responses.filter(r => r.status === 201).length, 1);
		assert.ok(responses.every(r => [200, 201, 409].includes(r.status)));
		assert.equal((await JobModel.findById(j._id))!.results.length, 1);
		assert.equal(objects.size, 1);
	});

	test('expired and legacy unverified objects are not downloadable', async () => {
		const j = await job(); assert.equal((await download(j.onChainJobId)).status, 404);
		await upload(j.onChainJobId);
		await JobModel.updateOne({ _id: j._id }, { $set: { 'results.0.retainedUntil': new Date(0) } });
		assert.equal((await download(j.onChainJobId)).status, 404);
	});

	test('legacy metadata-only results are unavailable until actual bytes replace them', async () => {
		const j = await job();
		await JobModel.collection.updateOne({ _id: j._id }, { $push: { results: {
			provider: accounts.provider, hash: 'unverified', location: 'https://untrusted.invalid/result', deliveryTime: new Date(), receiptVerified: false,
		} } });
		assert.equal((await download(j.onChainJobId)).status, 404);
		assert.equal((await upload(j.onChainJobId)).status, 201);
		assert.equal((await JobModel.findById(j._id))!.results.length, 1);
		assert.equal((await download(j.onChainJobId)).status, 200);
	});

	test('storage upload/read failures are sanitized and never acknowledge delivery', async () => {
		const j = await job(); failPut = true;
		assert.equal((await upload(j.onChainJobId)).status, 502);
		assert.equal((await JobModel.findById(j._id))!.results.length, 0); assert.equal(receiptCalls, 0);
		failPut = false; await upload(j.onChainJobId); failGet = true;
		assert.equal((await download(j.onChainJobId)).status, 503);
	});

	test('same-size stored corruption fails integrity before download headers', async () => {
		const j = await job(); await upload(j.onChainJobId);
		const [key, stored] = [...objects][0]; const corrupt = Buffer.from(stored); corrupt[512] ^= 1; objects.set(key, corrupt);
		const response = await download(j.onChainJobId); assert.equal(response.status, 502);
		assert.match((await response.json()).error, /integrity/);
	});

	test('chain delivery requires a revealed, agreed matching output before storage or receipt', async () => {
		const j = await job();
		for (const condition of ['agreed', 'revealed', 'hash']) {
			agreed = condition !== 'agreed'; revealed = condition !== 'revealed'; wrongChainHash = condition === 'hash';
			assert.equal((await upload(j.onChainJobId, { url: chained })).status, 422);
		}
		assert.equal(writes, 0); assert.equal(receiptCalls, 0);
	});

	test('milestone4 without a receipt ABI hook acknowledges verified bytes off chain without claiming a chain receipt', async () => {
		const j = await job(); supportsDeliveryReceipts = false; canWrite = false;
		agreed = false;
		assert.equal((await upload(j.onChainJobId, { url: chained })).status, 422);
		assert.equal(writes, 0);
		agreed = true;
		const response = await upload(j.onChainJobId, { url: chained });
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.receiptMode, 'offchain'); assert.equal(body.receiptPending, false);
		assert.equal(body.results[0].contentVerified, true); assert.equal(body.results[0].receiptVerified, false);
		assert.equal(body.results[0].receiptMode, 'offchain'); assert.equal(receiptCalls, 0);
		const saved = await JobModel.findById(j._id);
		assert.equal(saved!.results[0].receiptMode, 'offchain'); assert.equal(saved!.results[0].receiptVerified, false);
		const detail = await fetch(`${chained}/jobs/${j.onChainJobId}`, { headers: { Authorization: 'Bearer test-buyer' } });
		const info = await detail.json(); assert.equal(info.job.result.available, true); assert.equal(info.job.result.receiptMode, 'offchain');
		assert.equal((await upload(j.onChainJobId, { url: chained })).status, 200);
		assert.equal(writes, 1); assert.equal(objects.size, 1); assert.equal(receiptCalls, 0);
	});

	test('receipt failures return pending; retry reuses bytes and finishes receipt exactly once', async () => {
		const j = await job(); receiptFails = true;
		const pending = await upload(j.onChainJobId, { url: chained }); assert.equal(pending.status, 202);
		assert.equal((await pending.json()).receiptPending, true); assert.equal(writes, 1);
		receiptFails = false;
		const done = await upload(j.onChainJobId, { url: chained }); assert.equal(done.status, 200);
		assert.equal((await done.json()).results[0].receiptVerified, true); assert.equal(writes, 1); assert.equal(receiptCalls, 2);
		assert.equal((await upload(j.onChainJobId, { url: chained })).status, 200); assert.equal(receiptCalls, 2);
	});

	test('a previously verified receipt is rechecked and stale metadata cannot complete a pending retry', async () => {
		const j = await job();
		const first = await upload(j.onChainJobId, { url: chained });
		assert.equal(first.status, 201); assert.equal((await first.json()).results[0].receiptVerified, true);
		assert.equal(writes, 1); assert.equal(receiptCalls, 1);
		chainDelivered = false; receiptFails = true;
		const pending = await upload(j.onChainJobId, { url: chained });
		assert.equal(pending.status, 202);
		const response = await pending.json();
		assert.equal(response.receiptPending, true); assert.equal(response.results[0].receiptVerified, false);
		assert.equal((await JobModel.findById(j._id))!.results[0].receiptVerified, false);
		assert.equal(writes, 1); assert.equal(objects.size, 1); assert.equal(receiptCalls, 2);
		receiptFails = false;
		const recovered = await upload(j.onChainJobId, { url: chained });
		assert.equal(recovered.status, 200); assert.equal((await recovered.json()).results[0].receiptVerified, true);
		assert.equal(writes, 1); assert.equal(receiptCalls, 3);
	});

	test('phase changes during storage remove the unreferenced object and skip receipt', async () => {
		const j = await job(); const original = store.put;
		store.put = async (key, data) => { await original(key, data); await JobModel.updateOne({ _id: j._id }, { $set: { status: JobStatus.PAYOUT } }); };
		try { assert.equal((await upload(j.onChainJobId, { url: chained })).status, 409); }
		finally { store.put = original; }
		assert.equal(objects.size, 0); assert.equal(deletes, 1); assert.equal(receiptCalls, 0);
	});
});
