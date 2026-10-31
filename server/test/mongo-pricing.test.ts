import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { parseEther } from 'viem';
import { AccountModel, AuthTokenModel, ChainEventModel, HardwareModel, JobModel, hashToken } from '../models/index.ts';
import { bookedChargeWei, createPricingQuote, MAX_UINT256 } from '../pricing.ts';
import { Matcher } from '../services/matcher.ts';
import { handleChainEvent } from '../services/events.ts';
import { serializeJob } from '../routes/serialize.ts';
import { createApp } from '../app.ts';
import { Builder } from '../services/builder.ts';
import type { Chain, ChainEvent } from '../services/chain.ts';

const uri = process.env.MONGODB_URI;
const image = `example/work@sha256:${'a'.repeat(64)}`;
const address = (n: number) => `0x${String(n).padStart(40, '0')}`;
const event = (name: string, args: Record<string, unknown>): ChainEvent => ({ id: `${name}:${randomUUID()}`, name, args, blockNumber: 1n });
let seq = 0;
async function fixture(changes: Record<string, unknown> = {}) {
  const owner = await AccountModel.create({ walletIds: [address(1)] });
  const fields = { owner: owner._id, onChainJobId: ++seq, buyerWallet: address(1), dockerImageDigest: image,
    maxPrice: '0.3', timeWindow: 61, minNodesToRunOn: 2, minNodesToAgree: 1, ...changes };
  const job = await JobModel.create({ ...fields, pricing: createPricingQuote(fields) });
  const writes: unknown[] = [];
  const overrides: Record<string, unknown> = {};
  const chain = {
    getJobTerms: async () => ({ creator: address(1), maxHourlyRate: BigInt(job.pricing!.maxHourlyRateWei!),
      k: BigInt(job.minNodesToRunOn), quorum: BigInt(job.minNodesToAgree), executionTime: BigInt(job.timeWindow),
      dockerImage: image, escrow: BigInt(job.pricing!.totalEscrowWei!), ...overrides }),
    assignProviders: async (...args: unknown[]) => { writes.push(args); },
  } as unknown as Chain;
  const matcher = new Matcher(chain);
  return { owner, job, chain, matcher, writes, overrides };
}

before(async () => { if (uri) { await mongoose.connect(uri, { dbName: `offbalance_pricing_${randomUUID().replaceAll('-', '')}` }); await mongoose.syncIndexes(); } });
beforeEach(async () => { if (uri) await Promise.all([AccountModel.deleteMany({}), AuthTokenModel.deleteMany({}), HardwareModel.deleteMany({}), JobModel.deleteMany({}), ChainEventModel.deleteMany({})]); });
after(async () => { if (uri) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });

test('booked-window quotes round per provider in wei, reject overflow, and preserve positive subwei charges', () => {
  const quote = createPricingQuote({ maxPrice: '0.000000000000000001', timeWindow: 1, minNodesToRunOn: 3 });
  assert.equal(quote.perProviderMaxChargeWei, '1'); assert.equal(quote.totalEscrowWei, '3');
  assert.equal(bookedChargeWei(MAX_UINT256, 3600), MAX_UINT256);
  assert.throws(() => createPricingQuote({ maxPrice: `${MAX_UINT256 / 10n ** 18n}.${String(MAX_UINT256 % 10n ** 18n).padStart(18, '0')}`, timeWindow: 3600, minNodesToRunOn: 2 }), /uint256/);
  const exactMax = createPricingQuote({ maxPrice: `${MAX_UINT256 / 10n ** 18n}.${String(MAX_UINT256 % 10n ** 18n).padStart(18, '0')}`, timeWindow: 3600, minNodesToRunOn: 1 });
  assert.equal(exactMax.totalEscrowWei, String(MAX_UINT256));
});

test('API pins its authenticated buyer and exact immutable quote, ignoring client-supplied quotes', { skip: !uri }, async () => {
  const owner = await AccountModel.create({ walletIds: [address(1), address(9)] });
  await AuthTokenModel.create({ tokenHash: hashToken('buyer'), account: owner._id, wallet: address(1) });
  await AuthTokenModel.create({ tokenHash: hashToken('other-wallet'), account: owner._id, wallet: address(9) });
  const server = createApp({ chain: null, matcher: new Matcher(null), builder: new Builder() }, { log: false }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${base}/jobs`, { method: 'POST', headers: { Authorization: 'Bearer buyer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dockerImageDigest: image, maxPrice: '0.123456789012345678', timeWindow: 61, minNodesToRunOn: 3, minNodesToAgree: 2,
        buyerWallet: address(9), pricing: { totalEscrowWei: '1' } }) });
    assert.equal(response.status, 201);
    const { job } = await response.json();
    assert.equal(job.buyerWallet, address(1)); assert.equal(job.submitWallet, address(1));
    assert.equal(job.pricing.totalEscrowWei, String(((123456789012345678n * 61n + 3599n) / 3600n) * 3n));
    const read = await fetch(`${base}/jobs/${job.id}`, { headers: { Authorization: 'Bearer other-wallet' } });
    assert.equal((await read.json()).job.submitWallet, address(1));
    const priced = await fetch(`${base}/provider/price`, { method: 'POST', headers: { Authorization: 'Bearer buyer', 'Content-Type': 'application/json' }, body: JSON.stringify({ price: '0.123456789012345678' }) });
    assert.equal(priced.status, 404); // validation accepted the exact decimal before checking registration
    const zero = await fetch(`${base}/provider/price`, { method: 'POST', headers: { Authorization: 'Bearer buyer', 'Content-Type': 'application/json' }, body: JSON.stringify({ price: '0' }) });
    assert.equal(zero.status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('nonhour multi-provider assignment persists individual exact rates and booked charges', { skip: !uri }, async () => {
  const f = await fixture();
  for (const [id, rate] of [[2, '0.1'], [3, '0.2']] as const) {
    const account = await AccountModel.create({ walletIds: [address(id)] });
    await HardwareModel.create({ userRef: account._id, address: address(id), cpuScore: 100, memoryScore: 100, price: rate });
  }
  await handleChainEvent(event('JOB_SUBMITTED', { jobId: BigInt(f.job.onChainJobId) }), f.matcher);
  await f.matcher.heartbeat(address(2)); await f.matcher.heartbeat(address(3));
  const job = (await JobModel.findById(f.job._id))!;
  assert.deepEqual(f.writes, [[job.onChainJobId, [address(2), address(3)], [parseEther('0.1'), parseEther('0.2')]]]);
  assert.deepEqual(job.assignedRates.map(rate => rate.hourlyRate), ['0.1', '0.2']);
  const charges = [parseEther('0.1'), parseEther('0.2')].map(rate => (rate * 61n + 3599n) / 3600n);
  assert.deepEqual(job.assignedRates.map(rate => rate.chargeWei), charges.map(String));
  assert.equal(serializeJob(job).quotedTotalWei, String(charges[0] + charges[1]));
});

test('mismatched on-chain creator, price, provider counts, window, image or escrow never reaches matching or poisons the cursor', { skip: !uri }, async () => {
  const f = await fixture();
  for (const [key, value] of Object.entries({ creator: address(9), maxHourlyRate: 1n, k: 3n, quorum: 2n, executionTime: 3600n, dockerImage: 'other/image', escrow: 1n })) {
    f.overrides[key] = value;
    const submitted = event('JOB_SUBMITTED', { jobId: BigInt(f.job.onChainJobId) });
    await handleChainEvent(submitted, f.matcher);
    const job = (await JobModel.findById(f.job._id))!;
    assert.equal(job.submittedAt, null, key); assert.match(job.submissionValidationError!, /do not match/, key);
    assert.ok(await ChainEventModel.exists({ _id: submitted.id }));
    delete f.overrides[key];
  }
  assert.equal(f.writes.length, 0);
});

test('matcher rechecks funding terms after submission and refuses changed chain terms', { skip: !uri }, async () => {
  const f = await fixture({ minNodesToRunOn: 1 });
  await handleChainEvent(event('JOB_SUBMITTED', { jobId: BigInt(f.job.onChainJobId) }), f.matcher);
  f.overrides.escrow = 1n;
  const provider = await AccountModel.create({ walletIds: [address(2)] });
  await HardwareModel.create({ userRef: provider._id, address: address(2), cpuScore: 1, memoryScore: 1, price: '0.1' });
  await f.matcher.heartbeat(address(2));
  assert.equal(f.writes.length, 0);
  assert.match((await JobModel.findById(f.job._id))!.submissionValidationError!, /do not match/);
});

test('work, stake returns and slash bonuses remain distinct; authoritative settlement debits actual work exactly once', { skip: !uri }, async () => {
  const f = await fixture({ maxPrice: '1', timeWindow: 3600, minNodesToRunOn: 3 });
  const provider = await AccountModel.create({ walletIds: [address(2)] });
  await JobModel.updateOne({ _id: f.job._id }, { $set: { assignedRates: [{ provider: provider._id, wallet: address(2),
    hourlyRate: '0.2', hourlyRateWei: String(parseEther('0.2')), charge: '0.2', chargeWei: String(parseEther('0.2')) }] } });
  await AccountModel.updateOne({ _id: provider._id }, { $set: { walletIds: [address(8)] } });
  const relinked = await AccountModel.create({ walletIds: [address(2)] });
  const args = { jobId: BigInt(f.job.onChainJobId), provider: address(2) };
  for (const [name, amount] of [['PAID', '0.2'], ['SLASH_REWARD', '0.03'], ['STAKE_RETURNED', '0.1'], ['SLASHED', '0.04']] as const) {
    const receipt = event(name, { ...args, amount: parseEther(amount) });
    await Promise.all([handleChainEvent(receipt, f.matcher), handleChainEvent(receipt, f.matcher)]);
  }
  assert.equal((await AccountModel.findById(provider._id))!.totalEarned!.toString(), '0.23');
  assert.equal((await AccountModel.findById(relinked._id))!.totalEarned!.toString(), '0');
  assert.equal((await AccountModel.findById(f.owner._id))!.totalSpent!.toString(), '0');
  const settled = event('JOB_SETTLED', { jobId: args.jobId, buyer: address(1), escrow: parseEther('3'), workPaid: parseEther('0.2'), refund: parseEther('2.8'), slashedStake: parseEther('0.04') });
  await Promise.all([handleChainEvent(settled, f.matcher), handleChainEvent(settled, f.matcher)]);
  assert.equal((await AccountModel.findById(f.owner._id))!.totalSpent!.toString(), '0.2');
  const job = (await JobModel.findById(f.job._id))!;
  const serialized = serializeJob(job);
  assert.equal(serialized.settlement!.buyerRefundWei, String(parseEther('2.8')));
  assert.equal(serialized.settlement!.stakeReturnedWei, String(parseEther('0.1')));
  assert.equal(job.workPaid!.toString(), '0.2'); assert.equal(job.slashRewards!.toString(), '0.03');
  assert.equal(job.slashed!.toString(), '0.04');
  // Missing amounts never fall back to the display-only runningPrice.
  await assert.rejects(handleChainEvent(event('PAID', args), f.matcher), /explicit wei/);
});

test('a partial settlement write failure replays without double debit', { skip: !uri }, async () => {
  const f = await fixture({ maxPrice: '1', timeWindow: 3600, minNodesToRunOn: 1 });
  const settled = event('JOB_SETTLED', { jobId: BigInt(f.job.onChainJobId), buyer: address(1), escrow: parseEther('1'), workPaid: parseEther('0.2'), refund: parseEther('0.8'), slashedStake: 0n });
  const original = JobModel.updateOne;
  let fail = true;
  JobModel.updateOne = ((filter, update, ...rest) => {
    if (fail && update && '$set' in update && (update.$set as { settlement?: unknown }).settlement) { fail = false; throw new Error('injected settlement write'); }
    return original.call(JobModel, filter, update, ...rest);
  }) as typeof JobModel.updateOne;
  try { await assert.rejects(handleChainEvent(settled, f.matcher), /injected/);
    assert.equal((await AccountModel.findById(f.owner._id))!.totalSpent!.toString(), '0.2'); }
  finally { JobModel.updateOne = original; }
  await handleChainEvent(settled, f.matcher);
  assert.equal((await AccountModel.findById(f.owner._id))!.totalSpent!.toString(), '0.2');
  assert.equal(serializeJob((await JobModel.findById(f.job._id))!).settlement!.buyerRefundWei, String(parseEther('0.8')));
});
