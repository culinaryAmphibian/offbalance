import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../matching/JobQueue.ts';
import { ProviderPoolCache } from '../matching/ProviderPoolCache.ts';
import { MatchingEngine, parseEthAmount, formatEthAmount, quoteProviders } from '../matching/MatchingEngine.ts';

const epoch = 1_000_000;
const provider = (wallet, changes = {}) => ({ wallet, accountId: `account-${wallet}`, registered: true,
  pricePerHour: '1', machine: { vcpus: 8, memoryGb: 16, gpus: [] },
  lastHeartbeat: epoch, busyJobId: null, lastAssignedAt: 0, ...changes });
const job = (id, changes = {}) => ({ id, owner: 'buyer', k: 1, quorum: 1, window: 3600,
  maxPrice: '100', requirements: { minVcpus: 2, minMemoryGb: 4, gpu: 'none', minGpuVramGb: 0 },
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
  queue.peek().requirements.minVcpus = 9000;
  assert.equal(queue.peek().requirements.minVcpus, 2);
  assert.equal(queue.remove('a'), true);
});

test('availability requires registration, heartbeat, machine specs, positive known price and idle', () => {
  const { pool } = setup();
  pool.add(provider('ready'));
  pool.add(provider('stale', { lastHeartbeat: epoch - 30_001 }));
  pool.add(provider('future', { lastHeartbeat: epoch + 1 }));
  pool.add(provider('busy', { busyJobId: 'another-job' }));
  pool.add(provider('unregistered', { registered: false }));
  pool.add(provider('missing-price', { pricePerHour: undefined }));
  pool.add(provider('free', { pricePerHour: '0.0000' }));
  pool.add(provider('invalid-price', { pricePerHour: '1e-2' }));
  pool.add(provider('unmeasured', { machine: { vcpus: 8 } }));
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
  pool.add(provider('weak', { pricePerHour: '0.001', machine: { vcpus: 1, memoryGb: 999, gpus: [{ vendor: 'nvidia', vramGb: 80 }] } }));
  pool.add(provider('good'));
  assert.deepEqual(engine.findTopK(job('job')).map(value => value.wallet), ['good']);
});

test('ranking is hourly price, bottleneck headroom, longest idle, then lexical wallet', () => {
  const { pool, engine } = setup();
  pool.add(provider('expensive', { pricePerHour: '2', machine: { vcpus: 64, memoryGb: 256, gpus: [] } }));
  pool.add(provider('c', { lastAssignedAt: 10 }));
  pool.add(provider('B', { lastAssignedAt: 0 }));
  pool.add(provider('a', { lastAssignedAt: 0 }));
  pool.add(provider('headroom', { machine: { vcpus: 16, memoryGb: 32, gpus: [] } }));
  assert.deepEqual(engine.findTopK(job('job', { k: 5 })).map(value => value.wallet), ['headroom', 'a', 'B', 'c', 'expensive']);
  // no requirements means the 1-vCPU default; memory is the bottleneck when it's tighter than CPU
  assert.equal(engine.scoreProvider(job('none', { requirements: {} }), provider('a')).headroom, 8);
  assert.equal(engine.scoreProvider(job('bottleneck', { requirements: { minVcpus: 2, minMemoryGb: 16 } }), provider('a')).headroom, 1);
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

test('CPU-only machines only take jobs without a GPU; GPU jobs need a usable GPU of the right vendor and VRAM', async () => {
  const { pool, engine } = setup();
  pool.register(provider('cpu-only', { machine: { vcpus: 4, memoryGb: 15.5, gpus: [] } }));
  pool.register(provider('nvidia-8', { pricePerHour: '2', machine: { vcpus: 8, memoryGb: 31.2, gpus: [{ vendor: 'nvidia', vramGb: 8 }] } }));
  pool.register(provider('amd-16', { pricePerHour: '3', machine: { vcpus: 8, memoryGb: 31.2, gpus: [{ vendor: 'amd', vramGb: 16 }] } }));
  const top = requirements => engine.findTopK(job('j', { k: 3, requirements })).map(value => value.wallet);
  const cpuJob = { minVcpus: 2, minMemoryGb: 15 };
  assert.deepEqual(top(cpuJob), ['cpu-only', 'nvidia-8', 'amd-16']);
  assert.equal(engine.scoreProvider(job('j', { requirements: cpuJob }), pool.get('cpu-only')).headroom, 15.5 / 15);
  // a 16 GB machine reports about 15.5 GB usable, so it doesn't qualify for 16
  assert.deepEqual(top({ minVcpus: 2, minMemoryGb: 16 }), ['nvidia-8', 'amd-16']);
  assert.deepEqual(top({ gpu: 'any', minGpuVramGb: 8 }), ['nvidia-8', 'amd-16']);
  assert.deepEqual(top({ gpu: 'amd' }), ['amd-16']);
  assert.deepEqual(top({ gpu: 'nvidia', minGpuVramGb: 12 }), []);
  assert.equal(engine.scoreProvider(job('j', { requirements: { minVcpus: 1, gpu: 'any', minGpuVramGb: 4 } }), pool.get('amd-16')).headroom, 4);
  assert.equal((await engine.enqueue(job('cpu-job', { requirements: cpuJob }))).length, 1);
});

test('pool and matching reject missing, negative, nonfinite or fractional specs and unknown GPU vendors', () => {
  const { pool, engine } = setup();
  const cpuOnly = { vcpus: 4, memoryGb: 15.5, gpus: [] };
  const bad = {
    vcpus: [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    memoryGb: [undefined, null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    gpus: [undefined, null, 'gpu', [{ vendor: 'intel', vramGb: 8 }], [{ vendor: 'nvidia', vramGb: -1 }], [{ vendor: 'nvidia' }]],
  };
  let index = 0;
  for (const [name, values] of Object.entries(bad)) {
    for (const value of values) {
      const invalid = provider(`invalid-${index++}`, { machine: { ...cpuOnly, [name]: value } });
      pool.register(invalid);
      if (name !== 'gpus' && value !== Number.MAX_SAFE_INTEGER + 1) assert.equal(engine.meetsRequirements(job('job'), invalid), false, `${name}=${value}`);
    }
  }
  assert.equal(pool.getAvailable().length, 0);
  pool.register(provider('valid', { machine: cpuOnly }));
  assert.deepEqual(engine.findTopK(job('job')).map(value => value.wallet), ['valid']);
  for (const requirements of [{ minVcpus: 0 }, { minVcpus: NaN }, { minMemoryGb: -1 }, { gpu: 'intel' }, { gpu: 'any', minGpuVramGb: -1 }]) {
    assert.equal(engine.meetsRequirements(job('bad', { requirements }), pool.get('valid')), false, JSON.stringify(requirements));
  }
});
