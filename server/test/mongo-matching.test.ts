import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoRepository } from '../adapters/repository.ts';
import { AccountModel, HardwareModel, JobModel, JobStatus } from '../models/index.ts';
import { Matcher } from '../services/matcher.ts';

const uri = process.env.MONGODB_URI;
const image = `example/compute@sha256:${'a'.repeat(64)}`;
const epoch = 1_000_000;
const wallet = (id: number) => `0x${id.toString(16).padStart(40, '0')}`;

async function account(id: number) {
  return AccountModel.create({ walletIds: [wallet(id)] });
}

async function provider(id: number, price = 0.1) {
  const owner = await account(id);
  const hardware = await HardwareModel.create({ userRef: owner._id, address: wallet(id),
    cpuScore: 100.5, gpuScore: null, memoryScore: 200.25, price });
  owner.hardware = hardware._id;
  await owner.save();
  return { owner, hardware, wallet: wallet(id) };
}

async function job(owner: mongoose.Types.ObjectId, id: number, changes: Record<string, unknown> = {}) {
  return JobModel.create({ owner, onChainJobId: id, dockerImageDigest: image,
    maxPrice: '0.1', minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 3600,
    requirements: { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 20 },
    submittedAt: new Date('2026-10-19T00:00:00.000Z'), ...changes });
}

describe('MongoDB scheduler integration', { skip: !uri }, () => {
  before(async () => {
    await mongoose.connect(uri!, { dbName: `offbalance_matching_test_${randomUUID().replaceAll('-', '')}`,
      serverSelectionTimeoutMS: 10_000 });
    await Promise.all([AccountModel.init(), HardwareModel.init(), JobModel.init()]);
  });

  beforeEach(async () => {
    await Promise.all([AccountModel.deleteMany({}), HardwareModel.deleteMany({}), JobModel.deleteMany({})]);
  });

  after(async () => {
    try { await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  });

  test('repository maps hourly caps to exact aggregate budgets and filters buyer, busy, and expensive providers', async () => {
    const buyer = await provider(1, 0.01);
    const cheap = await provider(2, 0.05);
    const atCap = await provider(3, 0.1);
    await provider(4, 0.100000001);
    const busy = await provider(5, 0.01);
    await job(buyer.owner._id, 102, { providers: [busy.owner._id], status: JobStatus.COMMIT_PHASE });
    const pending = await job(buyer.owner._id, 101, { minNodesToRunOn: 2, minNodesToAgree: 2, timeWindow: 1 });
    const repository = new MongoRepository();
    const mapped = await repository.getJob('101');
    assert.ok(mapped);
    assert.equal(mapped.id, '101');
    assert.equal(mapped.owner, String(buyer.owner._id));
    assert.equal(mapped.k, 2);
    assert.equal(mapped.quorum, 2);
    assert.equal(mapped.window, 1);
    assert.equal(mapped.hourlyCeiling, '0.1');
    // ceil(0.1 ETH in wei / 3600 seconds), independently for each of two providers.
    assert.equal(mapped.maxPrice, '0.000055555555555556');
    assert.equal(mapped.createdAt, pending.createdAt.toISOString());
    assert.deepEqual(mapped.requirements, { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 20 });
    const candidates = await repository.listProviders(mapped);
    assert.deepEqual(candidates.map(p => p.accountId).sort(), [String(cheap.owner._id), String(atCap.owner._id)].sort());
    const cheapRecord = candidates.find(p => p.wallet === cheap.wallet);
    assert.equal(cheapRecord?.pricePerHour, '0.05');
    assert.deepEqual(cheapRecord?.machine, { cpuScore: 100.5, gpuScore: null, memoryScore: 200.25 });
    assert.equal(await repository.getJob('102'), null);
    assert.equal(await repository.getJob('1.5'), null);
    assert.equal(await repository.getJob('9007199254740992'), null);
  });

  test('small Decimal128 hourly caps retain exact decimal precision through repository and assignment', async () => {
    const buyer = await account(1);
    const first = await provider(2, 0.0000001);
    const second = await provider(3, 0.0000001);
    const pending = await job(buyer._id, 1, { maxPrice: '0.0000001', minNodesToRunOn: 2 });
    assert.match(pending.maxPrice?.toString() ?? '', /[eE]-7$/, 'fixture exercises Decimal128 scientific notation');
    const matcher = new Matcher(null, { now: () => epoch });
    const mapped = await matcher.repository.getJob('1');
    assert.equal(mapped?.hourlyCeiling, '0.0000001');
    assert.equal(mapped?.maxPrice, '0.0000002');
    await matcher.heartbeat(first.wallet);
    await matcher.heartbeat(second.wallet);
    const assigned = await JobModel.findById(pending._id);
    assert.equal(assigned?.providers.length, 2);
    assert.equal(Number(assigned?.runningPrice?.toString()), 0.0000001);
  });

  test('subwei provider prices fail validation and historical invalid records cannot block valid providers', async () => {
    const buyer = await account(1);
    const valid = await provider(2);
    const invalid = await provider(3);
    invalid.hardware.price = 1e-19;
    await assert.rejects(invalid.hardware.validate(), /price/);
    // Simulate older records persisted before the scheduler's ETH precision rules.
    await HardwareModel.collection.updateOne({ _id: invalid.hardware._id }, { $set: { price: 1e-19 } });
    const pending = await job(buyer._id, 1);
    const matcher = new Matcher(null, { now: () => epoch });
    const mapped = await matcher.repository.getJob('1');
    assert.ok(mapped);
    const candidates = await matcher.repository.listProviders(mapped);
    assert.deepEqual(candidates.map(p => p.wallet), [valid.wallet]);
    await matcher.ping();
    await matcher.heartbeat(valid.wallet);
    assert.deepEqual((await JobModel.findById(pending._id))?.providers.map(String), [String(valid.owner._id)]);
  });

  test('database metadata and benchmark refreshes cannot establish provider liveness', async () => {
    const buyer = await account(1);
    const machine = await provider(2);
    const pending = await job(buyer._id, 1);
    const matcher = new Matcher(null, { now: () => epoch });
    await matcher.ping();
    assert.equal(matcher.manager.pool.get(machine.wallet)?.lastHeartbeat, 0);
    assert.deepEqual(matcher.manager.pool.getAvailable(), []);
    assert.equal((await JobModel.findById(pending._id))?.providers.length, 0);
    await HardwareModel.updateOne({ _id: machine.hardware._id }, { cpuScore: 500, price: 0.09 });
    await matcher.ping();
    assert.equal(matcher.manager.pool.get(machine.wallet)?.lastHeartbeat, 0);
    assert.equal((await JobModel.findById(pending._id))?.providers.length, 0);
    assert.equal(await matcher.heartbeat(machine.wallet), true);
    const assigned = await JobModel.findById(pending._id);
    assert.deepEqual(assigned?.providers.map(String), [String(machine.owner._id)]);
    assert.equal(assigned?.runningPrice?.toString(), '0.09');
    assert.equal(matcher.manager.pool.get(machine.wallet)?.busyJobId, '1');
    assert.equal(await matcher.heartbeat(wallet(999)), false);
  });

  test('unlinking a wallet makes cached live capacity ineligible for new assignments', async () => {
    const buyer = await account(1);
    const machine = await provider(2);
    const matcher = new Matcher(null, { now: () => epoch });
    await matcher.heartbeat(machine.wallet);
    assert.equal(matcher.manager.pool.getAvailable().length, 1);
    await AccountModel.updateOne({ _id: machine.owner._id }, { $set: { walletIds: [wallet(99)] } });
    const pending = await job(buyer._id, 1);
    await matcher.ping();
    assert.deepEqual((await JobModel.findById(pending._id))?.providers, []);
  });

  test('explicit heartbeat expires by the injected clock and a fresh heartbeat resumes matching', async () => {
    let now = epoch;
    const buyer = await account(1);
    const machine = await provider(2);
    const matcher = new Matcher(null, { now: () => now, heartbeatTimeoutMs: 500 });
    await matcher.heartbeat(machine.wallet);
    assert.deepEqual(matcher.manager.pool.getAvailable().map(p => p.wallet), [machine.wallet]);
    now += 501;
    const pending = await job(buyer._id, 1);
    await matcher.ping();
    assert.deepEqual(matcher.manager.pool.getAvailable(), []);
    assert.equal((await JobModel.findById(pending._id))?.providers.length, 0);
    await matcher.heartbeat(machine.wallet);
    assert.deepEqual((await JobModel.findById(pending._id))?.providers.map(String), [String(machine.owner._id)]);
  });

  test('restart restores database reservations and cannot allocate a busy provider to a second job', async () => {
    const buyer = await account(1);
    const machine = await provider(2);
    const first = await job(buyer._id, 1);
    const original = new Matcher(null, { now: () => epoch });
    await original.heartbeat(machine.wallet);
    assert.equal((await JobModel.findById(first._id))?.providers.length, 1);
    const second = await job(buyer._id, 2);
    const restarted = new Matcher(null, { now: () => epoch + 1 });
    await restarted.heartbeat(machine.wallet);
    assert.equal(restarted.manager.pool.get(machine.wallet)?.busyJobId, '1');
    assert.deepEqual(restarted.manager.pool.getAvailable(), []);
    assert.equal((await JobModel.findById(second._id))?.providers.length, 0);
    assert.deepEqual(await restarted.manager.findMatchingScores('2'), []);
    assert.deepEqual((await AccountModel.findById(machine.owner._id))?.takenJobs.map(String), [String(first._id)]);
  });

  test('assignment lookup exposes manifests only to the assigned account and verifies wallet ownership', async () => {
    const buyer = await account(1);
    const selected = await provider(2);
    const stranger = await provider(3);
    await job(buyer._id, 1, { providers: [selected.owner._id], status: JobStatus.COMMIT_PHASE });
    const repository = new MongoRepository();
    const manifest = await repository.getAssignedJob(1, String(selected.owner._id));
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), { id: '1', dockerImage: image,
      requirements: { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 20 }, window: 3600 });
    assert.equal(await repository.getAssignedJob(1, String(stranger.owner._id)), null);
    assert.equal(await repository.getAssignedJob(1, 'malformed-account'), null);
    assert.equal(await repository.getAssignedJob('-1', String(selected.owner._id)), null);
    assert.deepEqual(JSON.parse(JSON.stringify(await repository.getActiveAssignment(String(selected.owner._id)))), JSON.parse(JSON.stringify(manifest)));
    assert.equal(await repository.getActiveAssignment(String(stranger.owner._id)), null);
    assert.equal((await repository.getProvider(selected.wallet.toUpperCase()))?.busyJobId, '1');
    await HardwareModel.updateOne({ _id: stranger.hardware._id }, { address: wallet(999) });
    assert.equal(await repository.getProvider(wallet(999)), null, 'hardware alone must not establish wallet ownership');
  });

  test('chain assignment failure rolls back durable and cached reservations and retries on the next ping', async () => {
    const buyer = await account(1);
    const first = await provider(2, 0.1);
    const second = await provider(3, 0.2);
    const pending = await job(buyer._id, 1, { maxPrice: '0.2', minNodesToRunOn: 2 });
    let fail = true;
    const calls: { id: number; wallets: string[] }[] = [];
    const matcher = new Matcher({ async assignProviders(id, wallets) {
      calls.push({ id, wallets });
      const persisted = await JobModel.findById(pending._id);
      assert.equal(persisted?.providers.length, 2, 'assignment must exist before chain broadcast');
      for (const machine of [first, second]) {
        const owner = await AccountModel.findById(machine.owner._id);
        assert.deepEqual(owner?.takenJobs.map(String), [String(pending._id)]);
      }
      if (fail) throw new Error('chain assignment unavailable');
    } }, { now: () => epoch });
    await matcher.heartbeat(first.wallet);
    await assert.rejects(matcher.heartbeat(second.wallet), /chain assignment unavailable/);
    const rolledBack = await JobModel.findById(pending._id);
    assert.deepEqual(rolledBack?.providers, []);
    assert.equal(rolledBack?.runningPrice?.toString(), '0');
    for (const machine of [first, second]) {
      assert.deepEqual((await AccountModel.findById(machine.owner._id))?.takenJobs, []);
      assert.equal(matcher.manager.pool.get(machine.wallet)?.busyJobId, null);
    }
    assert.equal(matcher.manager.pool.getAvailable().length, 2);
    assert.equal(matcher.manager.queue.peek()?.id, '1');
    fail = false;
    await matcher.ping();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { id: 1, wallets: [first.wallet, second.wallet] });
    const assigned = await JobModel.findById(pending._id);
    assert.deepEqual(assigned?.providers.map(String).sort(), [String(first.owner._id), String(second.owner._id)].sort());
    assert.equal(assigned?.runningPrice?.toString(), '0.2');
    for (const machine of [first, second]) {
      assert.deepEqual((await AccountModel.findById(machine.owner._id))?.takenJobs.map(String), [String(pending._id)]);
      assert.equal(matcher.manager.pool.get(machine.wallet)?.busyJobId, '1');
    }
    assert.equal(matcher.manager.queue.peek(), null);
  });
});
