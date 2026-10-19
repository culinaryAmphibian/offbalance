import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../db.ts';
import {
  AccountModel, AuthTokenModel, CounterModel, HardwareModel, JobModel, TutorialModel,
  hashToken, nextSeq,
} from '../models/index.ts';
import { Matcher } from '../services/matcher.ts';

const mongodbUri = process.env.MONGODB_URI;
const execute = promisify(execFile);

describe('development seed', { skip: !mongodbUri && 'set MONGODB_URI to run' }, () => {
  let uri: string;

  async function seed(...args: string[]) {
    const env = { ...process.env, MONGODB_URI: uri };
    delete env.NODE_TEST_CONTEXT;
    await execute(process.execPath, ['seed.ts', ...args], {
      cwd: path.join(import.meta.dirname, '..'), env, timeout: 30_000,
    });
  }

  before(async () => {
    const isolated = new URL(mongodbUri!);
    isolated.pathname = `/offbalance-seed-${randomUUID()}`;
    uri = isolated.toString();
    await connectDB(uri);
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.syncIndexes();
  });
  after(async () => {
    try { await mongoose.connection.dropDatabase(); }
    finally { await disconnectDB(); }
  });

  test('default seed is idempotent and leaves all providers and job IDs free', async () => {
    await seed();
    await seed();
    assert.equal(await AccountModel.countDocuments(), 5);
    assert.equal(await AuthTokenModel.countDocuments(), 5);
    assert.equal(await TutorialModel.countDocuments(), 1);
    assert.equal(await JobModel.countDocuments(), 0);
    assert.equal(await CounterModel.countDocuments(), 0);
    for (const account of await AccountModel.find()) {
      assert.deepEqual(account.takenJobs, []);
      assert.deepEqual(account.submittedJobs, []);
    }
    assert.equal(await nextSeq('jobId'), 1, 'the first real job must receive ID 1');
  });

  test('default provider 1 can take the first real job after an eligible heartbeat', async () => {
    await seed();
    const token = await AuthTokenModel.findOne({ tokenHash: hashToken('dev') }).orFail();
    const buyer = await AuthTokenModel.findOne({ tokenHash: hashToken('dev-buyer') }).orFail();
    const provider = await AccountModel.findById(token.account).orFail();
    const hardware = await HardwareModel.create({
      userRef: provider._id, address: token.wallet,
      cpuScore: 500000, memoryScore: 8192, gpuScore: null, price: 0.01,
    });
    provider.hardware = hardware._id;
    await provider.save();
    const pending = await JobModel.create({
      owner: buyer.account, onChainJobId: await nextSeq('jobId'), submittedAt: new Date(),
      dockerImageDigest: `example/compute@sha256:${'a'.repeat(64)}`,
      maxPrice: '0.02', minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60,
      requirements: { minCpuScore: 400000, minMemoryScore: 4096 },
    });
    const matcher = new Matcher(null);
    await matcher.ping();
    assert.equal((await JobModel.findById(pending._id))?.providers.length, 0);
    assert.equal(await matcher.heartbeat(token.wallet), true);
    const assigned = await JobModel.findById(pending._id).orFail();
    assert.equal(assigned.onChainJobId, 1);
    assert.deepEqual(assigned.providers.map(String), [String(provider._id)]);
    assert.equal(matcher.manager.pool.get(token.wallet)?.busyJobId, '1');
  });

  test('explicit fixtures are idempotent and default seeding preserves existing jobs', async () => {
    await seed('--fixtures');
    await seed('--fixtures');
    await seed();
    assert.equal(await JobModel.countDocuments(), 1);
    const job = await JobModel.findOne({ onChainJobId: 1 }).orFail();
    const token = await AuthTokenModel.findOne({ tokenHash: hashToken('dev') }).orFail();
    assert.deepEqual(job.providers.map(String), [String(token.account)]);
    assert.deepEqual((await AccountModel.findById(token.account))?.takenJobs.map(String), [String(job._id)]);
    assert.equal(await nextSeq('jobId'), 2);
  });
});
