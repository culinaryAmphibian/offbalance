import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../matching/JobQueue.ts';
import { ProviderPoolCache } from '../matching/ProviderPoolCache.ts';
import { MatchingEngine, parseEthAmount, formatEthAmount, quoteProviders } from '../matching/MatchingEngine.ts';

const epoch = 1_000_000;
const provider = (wallet, changes = {}) => ({ wallet, accountId: `account-${wallet}`, registered: true,
  pricePerHour: '1', machine: { cpuScore: 100, gpuScore: 100, memoryScore: 100 },
  lastHeartbeat: epoch, busyJobId: null, lastAssignedAt: 0, ...changes });
const job = (id, changes = {}) => ({ id, owner: 'buyer', k: 1, quorum: 1, window: 3600,
  maxPrice: '100', requirements: { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 0 },
  createdAt: '2026-10-18T00:00:00.000Z', ...changes });
const setup = (options = {}) => {
  const queue = new JobQueue();
  const pool = new ProviderPoolCache({ now: () => epoch });
  const engine = new MatchingEngine({ queue, pool, ...options });
  return { queue, pool, engine };
};

test('FIFO queue deduplicates ids, sorts timestamp/id, and isolates caller mutation', () => {
  const queue = new JobQueue();
  const later = job('later', { createdAt: '2026-10-19T00:00:00.000Z' });
  queue.add(later); queue.add(job('b')); queue.add(job('a')); queue.add(job('a', { k: 99 }));
  later.id = 'mutated';
  assert.deepEqual(queue.getPending().map(value => value.id), ['a', 'b', 'later']);
  assert.equal(queue.peek().k, 1);
  queue.peek().requirements.minCpuScore = 9000;
  assert.equal(queue.peek().requirements.minCpuScore, 10);
  assert.equal(queue.remove('a'), true);
});

test('availability requires registration, heartbeat, machine scores, positive known price and idle', () => {
  const { pool } = setup();
  pool.add(provider('ready'));
  pool.add(provider('stale', { lastHeartbeat: epoch - 30_001 }));
  pool.add(provider('future', { lastHeartbeat: epoch + 1 }));
  pool.add(provider('busy', { busyJobId: 'another-job' }));
  pool.add(provider('unregistered', { registered: false }));
  pool.add(provider('missing-price', { pricePerHour: undefined }));
  pool.add(provider('free', { pricePerHour: '0.0000' }));
  pool.add(provider('invalid-price', { pricePerHour: '1e-2' }));
  pool.add(provider('unmeasured', { machine: { cpuScore: 100 } }));
  pool.add(provider('missing-account', { accountId: undefined }));
  assert.deepEqual(pool.getAvailable().map(value => value.wallet), ['ready']);
  pool.heartbeat('stale');
  assert.equal(pool.getAvailable().length, 2);
});

test('TTL expiry removes availability without clearing busy reservations; reconnect preserves busy', () => {
  let now = epoch;
  const pool = new ProviderPoolCache({ now: () => now });
  pool.register(provider('A'));
  assert.equal(pool.reserve(['a'], 'job'), true);
  now += 40_000;
  assert.equal(pool.getAvailable().length, 0);
  pool.heartbeat('a');
  pool.register(provider('a', { busyJobId: null, lastHeartbeat: now }));
  assert.equal(pool.get('A').busyJobId, 'job');
  assert.equal(pool.getAvailable().length, 0);
  assert.equal(pool.release('job'), 1);
  assert.equal(pool.getAvailable().length, 1);
});

test('reservations are atomic, reject duplicate wallets, and prevent double allocation', () => {
  const { pool } = setup();
  pool.register(provider('a')); pool.register(provider('b'));
  assert.equal(pool.reserve(['a', 'missing'], 'job'), false);
  assert.equal(pool.get('a').busyJobId, null);
  assert.equal(pool.reserve(['a', 'A'], 'job'), false);
  assert.equal(pool.reserve(['a'], 'job'), true);
  assert.equal(pool.reserve(['b', 'a'], 'other'), false);
  assert.equal(pool.get('b').busyJobId, null);
  assert.equal(pool.markBusy('a', 'other'), false);
});

test('hardware thresholds and buyer exclusion precede ranking', () => {
  const { pool, engine } = setup();
  pool.add(provider('self', { accountId: 'buyer', pricePerHour: '0.001' }));
  pool.add(provider('weak', { pricePerHour: '0.001', machine: { cpuScore: 9, gpuScore: 999, memoryScore: 999 } }));
  pool.add(provider('good'));
  assert.deepEqual(engine.findTopK(job('job')).map(value => value.wallet), ['good']);
});

test('ranking is hourly price, bottleneck headroom, longest idle, then lexical wallet', () => {
  const { pool, engine } = setup();
  pool.add(provider('expensive', { pricePerHour: '2', machine: { cpuScore: 999, gpuScore: 999, memoryScore: 999 } }));
  pool.add(provider('c', { lastAssignedAt: 10 }));
  pool.add(provider('B', { lastAssignedAt: 0 }));
  pool.add(provider('a', { lastAssignedAt: 0 }));
  pool.add(provider('headroom', { machine: { cpuScore: 200, gpuScore: 200, memoryScore: 200 } }));
  assert.deepEqual(engine.findTopK(job('job', { k: 5 })).map(value => value.wallet), ['headroom', 'a', 'B', 'c', 'expensive']);
  assert.equal(engine.scoreProvider(job('none', { requirements: {} }), provider('a')).headroom, 0);
  assert.equal(engine.scoreProvider(job('bottleneck', { requirements: { minCpuScore: 10, minGpuScore: 100 } }), provider('a')).headroom, 1);
});

test('quotes use exact 18-decimal BigInt arithmetic and round each provider upward', () => {
  assert.equal(parseEthAmount('0.000000000000000001'), 1n);
  assert.equal(formatEthAmount(parseEthAmount('9007199254740993.123456789012345678')), '9007199254740993.123456789012345678');
  assert.throws(() => parseEthAmount('0.0000000000000000001'));
  assert.throws(() => parseEthAmount('1e18'));
  const quote = quoteProviders(job('tiny', { window: 1 }), [provider('a', { pricePerHour: '0.000000000000000001' }), provider('b', { pricePerHour: '0.000000000000000001' })]);
  assert.equal(quote.totalWei, '2');
  assert.equal(quote.totalPrice, '0.000000000000000002');
  assert.deepEqual(quote.providers.map(value => value.costWei), ['1', '1']);
});

test('insufficient provider count or insufficient budget leaves all providers unreserved and job queued', async () => {
  const { queue, pool, engine } = setup();
  pool.add(provider('a'));
  await engine.enqueue(job('two', { k: 2 }));
  await engine.enqueue(job('budget', { maxPrice: '0.999999999999999999' }));
  assert.equal(pool.get('a').busyJobId, null);
  assert.equal(queue.getPending().length, 2);
});

test('exact budget is accepted and queue scan skips unmatchable head-of-line jobs', async () => {
  const { queue, pool, engine } = setup();
  pool.add(provider('a'));
  queue.add(job('a-unmatchable', { k: 2 }));
  queue.add(job('b-matchable', { maxPrice: '1' }));
  const matches = await engine.matchNext();
  assert.deepEqual(matches.map(value => value.job.id), ['b-matchable']);
  assert.deepEqual(queue.getPending().map(value => value.id), ['a-unmatchable']);
  assert.equal(matches[0].quote.totalPrice, '1');
});

test('concurrent triggers serialize: no provider is allocated twice, and additions during callback rescan', async () => {
  let resolveCallback;
  let entered;
  const callbackEntered = new Promise(resolve => { entered = resolve; });
  const callbackBarrier = new Promise(resolve => { resolveCallback = resolve; });
  let calls = 0;
  const { pool, queue, engine } = setup({ onMatched: async () => { calls++; entered(); await callbackBarrier; } });
  pool.add(provider('a'));
  const first = engine.enqueue(job('first'));
  await callbackEntered;
  assert.equal(pool.get('a').busyJobId, 'first');
  const second = engine.enqueue(job('second'));
  const third = engine.matchNext();
  resolveCallback();
  await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.deepEqual(queue.getPending().map(value => value.id), ['second']);
});

test('jobs enqueued during an awaited callback are matched on the coalesced scan', async () => {
  let resolveCallback;
  let entered;
  const callbackEntered = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { resolveCallback = resolve; });
  let calls = 0;
  const { engine, pool } = setup({ onMatched: async () => { if (++calls === 1) { entered(); await barrier; } } });
  pool.add(provider('a')); pool.add(provider('b'));
  const first = engine.enqueue(job('first'));
  await callbackEntered;
  const second = engine.enqueue(job('second'));
  resolveCallback();
  const [matches] = await Promise.all([first, second]);
  assert.deepEqual(matches.map(value => value.job.id), ['first', 'second']);
  assert.equal(pool.getAvailable().length, 0);
});

test('failed persistence callback releases all providers, retains queued job, and allows retry', async () => {
  let fail = true;
  const { pool, queue, engine } = setup({ onMatched: async () => { if (fail) throw new Error('database unavailable'); } });
  pool.add(provider('a')); pool.add(provider('b'));
  await assert.rejects(engine.enqueue(job('job', { k: 2 })), /database unavailable/);
  assert.equal(pool.getAvailable().length, 2);
  assert.equal(queue.peek().id, 'job');
  fail = false;
  assert.equal((await engine.matchNext()).length, 1);
  assert.equal(queue.peek(), null);
});

test('preexecution provider failure releases the whole group, removes failed session and requeues', async () => {
  const { pool, queue, engine } = setup();
  pool.add(provider('a')); pool.add(provider('b'));
  await engine.enqueue(job('job', { k: 2 }));
  assert.deepEqual(await engine.handleProviderFailure('job', 'a'), []);
  assert.equal(pool.get('a'), null);
  assert.equal(pool.get('b').busyJobId, null);
  assert.equal(queue.peek().id, 'job');
  pool.add(provider('c'));
  assert.equal((await engine.matchNext()).length, 1);
});

test('disabled matching queues jobs without allocating providers', async () => {
  const { pool, queue, engine } = setup({ enabled: false });
  pool.add(provider('a'));
  assert.deepEqual(await engine.enqueue(job('job')), []);
  assert.equal(queue.peek().id, 'job');
  assert.equal(pool.getAvailable().length, 1);
});

test('forgetAssignment removes retry bookkeeping without releasing providers or changing the queue', async () => {
  const { pool, queue, engine } = setup();
  pool.add(provider('a'));
  await engine.enqueue(job('job'));
  assert.equal(engine.forgetAssignment('job'), true);
  assert.equal(engine.forgetAssignment('job'), false);
  assert.deepEqual(await engine.handleProviderFailure('job', 'a'), []);
  assert.equal(pool.get('a').busyJobId, 'job');
  assert.equal(queue.peek(), null);
});

test('fractional benchmarks with unknown GPU qualify only for workloads without a GPU requirement', async () => {
  const { pool, engine } = setup();
  pool.register(provider('cpu-only', { machine: { cpuScore: 20.5, gpuScore: null, memoryScore: 31.25 } }));
  assert.equal(pool.getAvailable().length, 1);
  const cpuJob = job('cpu-job', { requirements: { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 10 } });
  assert.deepEqual(engine.findTopK(cpuJob).map(value => value.wallet), ['cpu-only']);
  assert.equal(engine.scoreProvider(cpuJob, pool.get('cpu-only')).headroom, 2.05);
  const gpuJob = job('gpu-job', { requirements: { minCpuScore: 10, minGpuScore: 1, minMemoryScore: 10 } });
  assert.deepEqual(engine.findTopK(gpuJob), []);
  assert.equal(pool.get('cpu-only').machine.gpuScore, null);
  assert.equal((await engine.enqueue(cpuJob)).length, 1);
});

test('pool and matching reject missing, negative, nonfinite or oversized scores while allowing measured zero GPU', () => {
  const { pool, engine } = setup();
  const cpuOnly = { cpuScore: 20.5, gpuScore: null, memoryScore: 31.25 };
  let index = 0;
  for (const name of ['cpuScore', 'gpuScore', 'memoryScore']) {
    const bad = [undefined, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    if (name !== 'gpuScore') bad.push(null);
    for (const value of bad) {
      const invalid = provider(`invalid-${index++}`, { machine: { ...cpuOnly, [name]: value } });
      pool.register(invalid);
      assert.equal(engine.meetsRequirements(job('job'), invalid), false);
    }
  }
  assert.equal(pool.getAvailable().length, 0);
  pool.register(provider('zero-gpu', { machine: { cpuScore: Number.MAX_SAFE_INTEGER, gpuScore: 0, memoryScore: 0 } }));
  assert.deepEqual(engine.findTopK(job('job')).map(value => value.wallet), ['zero-gpu']);
  assert.equal(engine.meetsRequirements(job('fractional-min', { requirements: { minCpuScore: 1.5 } }), pool.get('zero-gpu')), false);
});
