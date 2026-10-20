import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../src/demoApi.js';

test('demo pricing persists only within its own adapter', async () => {
  const first = createDemoApi();
  const second = createDemoApi();
  const initial = (await second.getProvider()).provider;
  const { provider } = await first.saveProviderPricing({ pricePerHour: '0.000000000000000001' });
  assert.equal(provider.pricePerHour, '0.000000000000000001');
  assert.equal((await first.getProvider()).provider.pricePerHour, '0.000000000000000001');
  assert.deepEqual((await second.getProvider()).provider, initial);
  assert.equal(provider.currentStake, initial.currentStake);
  assert.deepEqual(provider.machine, initial.machine);
  provider.machine.cpuScore = -1;
  assert.deepEqual((await first.getProvider()).provider.machine, initial.machine);
});

test('demo lifecycle fixtures explicitly separate receipt validation and paid output', async () => {
  const api = createDemoApi();
  const { jobs } = await api.listJobs('buyer');
  const checking = jobs.find(job => job.status === 'DELIVERY_RECEIPT_VALIDATION');
  const completed = jobs.find(job => job.status === 'COMPLETED');
  assert.equal(checking.delivery.status, 'RECEIVED');
  assert.equal(checking.payment.status, 'PENDING');
  assert.equal(checking.result?.available, undefined);
  assert.deepEqual((await api.getResult(checking.id)).results, []);
  assert.equal(completed.delivery.status, 'VERIFIED');
  assert.equal(completed.payment.status, 'PAID');
  const result = await api.getResult(completed.id);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.results[0].receiptVerified, true);
  assert.equal(result.results[0].hash, completed.consensusResultHash);
  result.results[0].hash = 'mutated';
  assert.equal((await api.getResult(completed.id)).results[0].hash, completed.consensusResultHash);
});

test('demo job retries are idempotent and do not alter another adapter', async () => {
  const first = createDemoApi();
  const second = createDemoApi();
  const originalCount = (await second.listJobs('buyer')).jobs.length;
  const input = { name: 'Isolated workload', image: 'example/workload:latest', minNodesToRunOn: 3, minNodesToAgree: 2, maxPrice: '0.01' };
  const created = await first.createJob(input, 'same-request');
  const retried = await first.createJob(input, 'same-request');
  assert.equal(retried.job.id, created.job.id);
  assert.equal((await first.listJobs('buyer')).jobs.length, originalCount + 1);
  assert.equal((await second.listJobs('buyer')).jobs.length, originalCount);
  created.job.name = 'Mutated response';
  assert.equal((await first.getJob(retried.job.id)).job.name, input.name);
  assert.equal(retried.job.dockerImage, input.image);
  assert.equal(retried.job.k, 3);
  assert.equal(retried.job.quorum, 2);
  assert.equal(retried.job.executionMode, 'demo');
  assert.equal(retried.job.status, 'PENDING');
  assert.equal(retried.job.providerCount, 0);
  assert.equal(retried.job.result, undefined);
  assert.equal(retried.job.payment, undefined);
});
