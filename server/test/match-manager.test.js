import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchManager } from '../matching/MatchManager.js';
import { ProviderPoolCache } from '../matching/ProviderPoolCache.js';

const epoch = 1_000_000;
const job = (id, changes = {}) => ({ id, owner: 'buyer', k: 1, quorum: 1, window: 3600, maxPrice: '10',
  requirements: { minCpuScore: 10, minGpuScore: 0, minMemoryScore: 0 }, createdAt: '2026-10-18T12:00:00.000Z', ...changes });
const provider = (id, changes = {}) => ({ id, accountId: `account-${id}`, wallet: `wallet-${id}`, registered: true,
  pricePerHour: '1', machine: { cpuScore: 20, gpuScore: null, memoryScore: 10 }, ...changes });

function fixture(options = {}) {
  const jobs = new Map();
  const providers = new Map();
  const allowed = new Map();
  const reads = [];
  const assignments = [];
  const repository = {
    async getJob(id) {
      reads.push(['getJob', id]);
      if (repository.error) throw repository.error;
      return structuredClone(jobs.get(id) ?? null);
    },
    async listProviders(value) {
      reads.push(['listProviders', value.id]);
      if (repository.error) throw repository.error;
      return structuredClone(allowed.get(value.id) ?? [...providers.values()]);
    },
  };
  const pool = new ProviderPoolCache({ now: () => epoch });
  const manager = new MatchManager({ repository, pool, now: () => epoch,
    onMatched: async (...args) => { assignments.push(args); }, ...options });
  return { manager, pool, jobs, providers, allowed, assignments, reads, repository,
    addJob: value => jobs.set(value.id, value),
    addProvider(value, live = true) { providers.set(value.id, value); if (live) pool.register(value); },
  };
}

test('required repository and assignment ports fail immediately with actionable diagnostics', () => {
  assert.throws(() => new MatchManager(), /repository\.getJob/);
  assert.throws(() => new MatchManager({ repository: { getJob() {} } }), /repository\.listProviders/);
  assert.throws(() => new MatchManager({ repository: { getJob() {}, listProviders() {} } }), /onMatched/);
});

test('findMatchingScores loads the job/provider repository and returns ordered top-k provider ids', async () => {
  const f = fixture();
  f.addJob(job('job', { k: 2 }));
  f.addProvider(provider('expensive', { pricePerHour: '2' }));
  f.addProvider(provider('ordinary'));
  f.addProvider(provider('headroom', { machine: { cpuScore: 30, gpuScore: null, memoryScore: 10 } }));
  f.addProvider(provider('self', { accountId: 'buyer', pricePerHour: '0.01' }));
  assert.deepEqual(await f.manager.findMatchingScores('job'), ['headroom', 'ordinary']);
  assert.deepEqual(f.reads, [['getJob', 'job'], ['listProviders', 'job']]);
  assert.equal(f.manager.queue.peek(), null);
  assert.equal(f.assignments.length, 0);
});

test('provider ids fall back to account ids without inventing an identity', async () => {
  const f = fixture();
  f.addJob(job('job'));
  f.addProvider(provider('one', { id: undefined }));
  assert.deepEqual(await f.manager.findMatchingScores('job'), ['account-one']);
});

test('repository metadata cannot forge liveness, including when the clock is within the heartbeat TTL', async () => {
  const f = fixture();
  f.addJob(job('job'));
  f.addProvider(provider('offline', { lastHeartbeat: epoch + 999_999 }), false);
  assert.deepEqual(await f.manager.findMatchingScores('job'), []);
  assert.equal(f.pool.get('wallet-offline').lastHeartbeat, 0);
  f.pool.heartbeat('wallet-offline');
  assert.deepEqual(await f.manager.findMatchingScores('job'), ['offline']);
  const earlyPool = new ProviderPoolCache({ now: () => 1000 });
  earlyPool.register(provider('never-online', { lastHeartbeat: 0 }));
  assert.deepEqual(earlyPool.getAvailable(), []);
});

test('provider metadata/spec triggers refresh pending jobs without clearing existing reservations', async () => {
  const f = fixture();
  f.addJob(job('job', { requirements: { minCpuScore: 25, minGpuScore: 0, minMemoryScore: 0 } }));
  f.addProvider(provider('one'));
  assert.deepEqual(await f.manager.onJobSubmitted('job'), []);
  const heartbeat = f.pool.get('wallet-one').lastHeartbeat;
  f.providers.set('one', provider('one', { machine: { cpuScore: 25.5, gpuScore: null, memoryScore: 10.25 } }));
  const matches = await f.manager.onMachineSpecsUpdated('wallet-one');
  assert.equal(matches.length, 1);
  assert.equal(f.pool.get('wallet-one').lastHeartbeat, heartbeat);
  assert.equal(f.pool.get('wallet-one').busyJobId, 'job');
  assert.equal(f.assignments[0][1][0].machine.cpuScore, 25.5);
  assert.equal(f.assignments[0][2].totalPrice, '1');
  await f.manager.findMatchingScores('job');
  assert.equal(f.pool.get('wallet-one').busyJobId, 'job');
});

test('job-specific repository eligibility excludes unrelated providers from the shared live cache', async () => {
  const f = fixture();
  f.addJob(job('a')); f.addJob(job('b'));
  const first = provider('first');
  const second = provider('second');
  f.addProvider(first); f.addProvider(second);
  f.addProvider(provider('outsider', { pricePerHour: '0.001' }));
  f.allowed.set('a', [first]); f.allowed.set('b', [second]);
  f.manager.queue.add(job('a')); f.manager.queue.add(job('b'));
  const matches = await f.manager.matchNext();
  assert.deepEqual(matches.map(match => [match.job.id, match.providers[0].id]), [['a', 'first'], ['b', 'second']]);
  assert.equal(f.pool.get('wallet-outsider').busyJobId, null);
});

test('queued jobs are refreshed from the repository and an unavailable head does not block later work', async () => {
  const f = fixture();
  f.addProvider(provider('one'));
  f.addJob(job('a', { k: 2 }));
  f.addJob(job('b', { requirements: { minCpuScore: 100 } }));
  await f.manager.onJobSubmitted('a');
  await f.manager.onJobSubmitted('b');
  f.jobs.set('b', job('b'));
  const matches = await f.manager.onProviderUpdated('wallet-one');
  assert.deepEqual(matches.map(match => match.job.id), ['b']);
  assert.deepEqual(f.manager.queue.getPending().map(value => value.id), ['a']);
});

test('repository errors propagate and cannot dispatch using stale cached metadata', async () => {
  const f = fixture();
  f.addJob(job('job'));
  f.addProvider(provider('one'), false);
  await f.manager.onJobSubmitted('job');
  f.pool.heartbeat('wallet-one');
  f.repository.error = new Error('Repository unavailable');
  await assert.rejects(f.manager.onProviderUpdated('wallet-one'), /Repository unavailable/);
  assert.equal(f.assignments.length, 0);
  assert.equal(f.pool.get('wallet-one').busyJobId, null);
  delete f.repository.error;
  assert.equal((await f.manager.matchNext()).length, 1);
});

test('assignment-port failure rolls back reservations and leaves the job available for retry', async () => {
  let fail = true;
  const f = fixture({ onMatched: async () => { if (fail) throw new Error('Assignment not persisted'); } });
  f.addJob(job('job')); f.addProvider(provider('one'));
  await assert.rejects(f.manager.onJobSubmitted('job'), /Assignment not persisted/);
  assert.equal(f.manager.queue.peek().id, 'job');
  assert.equal(f.pool.get('wallet-one').busyJobId, null);
  fail = false;
  assert.equal((await f.manager.matchNext()).length, 1);
});

test('concurrent duplicate submissions forward an assignment once even before an external state update', async () => {
  const f = fixture();
  f.addJob(job('job'));
  f.addProvider(provider('one')); f.addProvider(provider('two'));
  await Promise.all([f.manager.onJobSubmitted('job'), f.manager.onJobSubmitted('job')]);
  assert.equal(f.assignments.length, 1);
  assert.equal(f.pool.getAvailable().length, 1);
  assert.equal(f.manager.forgetAssignment('job'), true);
  assert.equal(f.pool.get('wallet-one').busyJobId, 'job', 'forgetting bookkeeping does not release a worker');
});

test('repository removal drops pending queue entries and direct lookups fail clearly', async () => {
  const f = fixture();
  f.addJob(job('job'));
  await f.manager.onJobSubmitted('job');
  f.jobs.delete('job');
  assert.deepEqual(await f.manager.matchNext(), []);
  assert.equal(f.manager.queue.peek(), null);
  await assert.rejects(f.manager.findMatchingScores('job'), /job not found/);
  await assert.rejects(f.manager.onJobSubmitted('job'), /job not found/);
});

test('invalid repository outputs fail rather than creating fake jobs or providers', async () => {
  const f = fixture();
  f.addJob(job('job'));
  f.allowed.set('job', [{ wallet: 'bad', accountId: undefined }]);
  await assert.rejects(f.manager.onJobSubmitted('job'), /listProviders/);
  assert.equal(f.manager.queue.peek(), null);
  f.jobs.set('job', job('wrong-id'));
  await assert.rejects(f.manager.onJobSubmitted('job'), /scheduling job/);
});
