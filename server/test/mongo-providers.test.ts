// MONGODB_URI=<disposable Mongo host> node --test test/mongo-providers.test.ts
// HTTPS transport is covered separately; these exercise the authenticated API.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createApp } from '../app.ts';
import { AccountModel, AuthTokenModel, HardwareModel, JobModel, JobStatus, hashToken } from '../models/index.ts';
import { Builder } from '../services/builder.ts';
import { Matcher } from '../services/matcher.ts';

const uri = process.env.MONGODB_URI;
const wallet = `0x${'1'.repeat(40)}`;
const buyerWallet = `0x${'2'.repeat(40)}`;
const image = `docker.io/library/alpine@sha256:${'a'.repeat(64)}`;
const token = 'provider-test-token';

before(async () => {
  if (!uri) return;
  await mongoose.connect(uri, { dbName: `offbalance_providers_${randomUUID().replaceAll('-', '')}` });
  await mongoose.syncIndexes();
});
beforeEach(async () => {
  if (!uri) return;
  await Promise.all([AccountModel.deleteMany({}), AuthTokenModel.deleteMany({}), HardwareModel.deleteMany({}), JobModel.deleteMany({})]);
});
after(async () => {
  if (!uri) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function fixture(t: test.TestContext, { assigned = true, submitted = true } = {}) {
  const provider = await AccountModel.create({ walletIds: [wallet] });
  const owner = await AccountModel.create({ walletIds: [buyerWallet] });
  await AuthTokenModel.create({ account: provider._id, wallet, tokenHash: hashToken(token) });
  await AuthTokenModel.create({ account: owner._id, wallet: buyerWallet, tokenHash: hashToken('buyer-token') });
  await HardwareModel.create({ userRef: provider._id, address: wallet, cpuScore: 5, memoryScore: 8, price: 1 });
  const job = await JobModel.create({ onChainJobId: 37, owner: owner._id, dockerImageDigest: image,
    maxPrice: '5', minNodesToRunOn: 1, minNodesToAgree: 1, timeWindow: 60,
    submittedAt: submitted ? new Date() : null, providers: assigned ? [provider._id] : [] });
  let now = 100_000;
  const matcher = new Matcher(null, { now: () => now });
  const server = createApp({ chain: null, matcher, builder: new Builder() }, { log: false }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const call = async (route: string, { method = 'GET', body, credential = token }: { method?: string; body?: unknown; credential?: string | null } = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { matcher, provider, job, call, advance: (ms: number) => { now += ms; } };
}

test('HTTP provider restores its Mongo assignment, accepts it idempotently and ignores claimed benchmark scores', { skip: !uri }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/provider/heartbeat', { method: 'POST', body: { cpuScore: 999999 } })).status, 200);
  assert.equal(f.matcher.manager.pool.get(wallet)?.machine?.cpuScore, 5);
  const assigned = await f.call('/provider/assignment');
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assignment.id, '37');
  assert.equal(assigned.body.assignment.dockerImage, image);
  const accepted = await f.call('/provider/jobs/37/accept', { method: 'POST' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.assignment, assigned.body.assignment);
  assert.deepEqual(await f.call('/provider/jobs/37/accept', { method: 'POST' }), accepted);
  f.matcher.manager.pool.remove(wallet); // coordinator cache lost during a restart
  assert.deepEqual(await f.call('/provider/assignment'), assigned);
  assert.equal((await f.call('/provider/heartbeat', { method: 'POST' })).status, 200);
  assert.equal(f.matcher.manager.pool.get(wallet)?.busyJobId, '37');
});

test('HTTP idle and failure acknowledgements never release unfinished on-chain assignments', { skip: !uri }, async t => {
  const f = await fixture(t);
  await f.call('/provider/heartbeat', { method: 'POST' });
  for (const action of ['idle', 'error']) {
    const result = await f.call(`/provider/jobs/37/${action}`, { method: 'POST', body: { message: 'container stopped' } });
    assert.equal(result.status, 200);
    assert.equal(f.matcher.manager.pool.get(wallet)?.busyJobId, '37');
    assert.deepEqual((await JobModel.findById(f.job._id))?.providers.map(String), [String(f.provider._id)]);
    assert.equal((await JobModel.findById(f.job._id))?.status, JobStatus.PENDING);
  }
  assert.equal((await f.call('/provider/jobs/37/error', { method: 'POST', body: { message: '' } })).status, 400);
});

test('HTTP matching makes a new assignment available through polling and the client manifest endpoint', { skip: !uri }, async t => {
  const f = await fixture(t, { assigned: false });
  assert.equal((await f.call('/provider/assignment')).body.assignment, null);
  assert.equal((await f.call('/provider/heartbeat', { method: 'POST' })).status, 200);
  assert.equal((await f.call('/provider/assignment')).body.assignment.id, '37');
  const manifest = await f.call('/jobManifest/37');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.manifest.image, image);
  assert.deepEqual((await JobModel.findById(f.job._id))?.providers.map(String), [String(f.provider._id)]);
});

test('HTTP provider heartbeat expiry removes available capacity and reconnect restores it', { skip: !uri }, async t => {
  const f = await fixture(t, { assigned: false, submitted: false });
  await f.call('/provider/heartbeat', { method: 'POST' });
  assert.equal(f.matcher.manager.pool.getAvailable().length, 1);
  f.advance(30_001);
  assert.equal(f.matcher.manager.pool.getAvailable().length, 0);
  await f.call('/provider/heartbeat', { method: 'POST' });
  assert.equal(f.matcher.manager.pool.getAvailable().length, 1);
  assert.equal((await f.call('/provider/assignment')).body.assignment, null);
});

test('HTTP provider control checks bearer credentials on every request, including revocation', { skip: !uri }, async t => {
  const f = await fixture(t);
  for (const credential of [null, 'invalid']) {
    assert.equal((await f.call('/provider/assignment', { credential })).status, 401);
    assert.equal((await f.call('/provider/heartbeat', { method: 'POST', credential })).status, 401);
    assert.equal((await f.call('/provider/jobs/37/accept', { method: 'POST', credential })).status, 401);
  }
  await f.call('/provider/heartbeat', { method: 'POST' });
  await AuthTokenModel.deleteOne({ tokenHash: hashToken(token) });
  assert.equal((await f.call('/provider/assignment')).status, 401);
  assert.equal((await f.call('/provider/heartbeat', { method: 'POST' })).status, 401);
  assert.equal(f.matcher.manager.pool.get(wallet)?.busyJobId, '37');
});

test('HTTP provider credentials cease to work after wallet unlinking', { skip: !uri }, async t => {
  const f = await fixture(t);
  await AccountModel.updateOne({ _id: f.provider._id }, { $set: { walletIds: [`0x${'3'.repeat(40)}`] } });
  assert.equal((await f.call('/provider/assignment')).status, 401);
  assert.equal((await f.call('/provider/heartbeat', { method: 'POST' })).status, 401);
  assert.equal((await f.call('/provider/jobs/37/accept', { method: 'POST' })).status, 401);
});

test('HTTP provider control enforces job ownership and validates job identifiers', { skip: !uri }, async t => {
  const f = await fixture(t);
  for (const action of ['accept', 'idle', 'error']) {
    assert.equal((await f.call(`/provider/jobs/37/${action}`, { method: 'POST', body: { message: 'nope' }, credential: 'buyer-token' })).status, 403);
    for (const id of ['wrong', '-1', '9007199254740993']) {
      assert.equal((await f.call(`/provider/jobs/${id}/${action}`, { method: 'POST' })).status, 400);
    }
    assert.equal((await f.call(`/provider/jobs/999/${action}`, { method: 'POST' })).status, 404);
  }
  assert.equal((await f.call('/provider/assignment', { credential: 'buyer-token' })).body.assignment, null);
});
