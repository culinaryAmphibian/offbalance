import test from 'node:test';
import assert from 'node:assert/strict';
import { jobPayload, validateJob, normalizeJob, jobPhase, timeLabel, windowMinutes, resultUrl, resourceSummary } from '../src/jobs.js';

const valid = () => ({ name: 'Example job', dockerImage: 'registry.example/workload:latest', maxPrice: '0.01', k: '3', quorum: '2', window: '10', vcpus: '2', memoryGb: '4', gpu: 'none', gpuVram: '0' });

test('valid submission accepts default resources and exact decimal budgets', () => {
  assert.deepEqual(validateJob(valid()), {});
  assert.deepEqual(validateJob({ ...valid(), maxPrice: '0.000000000000000001' }), {});
  assert.deepEqual(validateJob({ ...valid(), k: '1', quorum: '1' }), {});
});

test('job payload trims text and converts only integer fields to numbers', () => {
  assert.deepEqual(jobPayload({ ...valid(), name: '  Example job  ', dockerImage: '  registry.example/workload:latest  ' }), {
    name: 'Example job', image: 'registry.example/workload:latest', maxPrice: '0.01', minNodesToRunOn: 3, minNodesToAgree: 2, timeWindow: 600,
    requirements: { minVcpus: 2, minMemoryGb: 4, gpu: 'none', minGpuVramGb: 0 },
  });
});

test('blank names and invalid image references are rejected', () => {
  assert.ok(validateJob({ ...valid(), name: ' \n ' }).name);
  for (const dockerImage of ['', '  ', 'image name', 'image\nname']) {
    assert.ok(validateJob({ ...valid(), dockerImage }).dockerImage, JSON.stringify(dockerImage));
  }
});

test('budget rejects zero, negative, exponent notation, spaces and excess decimal precision', () => {
  for (const maxPrice of ['', '0', '0.000', '-1', '1e3', '.1', '1.', ' 1', 'NaN', 'Infinity', '0.0000000000000000001']) {
    assert.ok(validateJob({ ...valid(), maxPrice }).maxPrice, JSON.stringify(maxPrice));
  }
});

test('provider count, quorum and window require positive safe integers', () => {
  for (const field of ['k', 'quorum', 'window']) {
    for (const value of ['', '0', '-1', '1.5', '1e2', ' 2', 'NaN', 'Infinity', '9007199254740992']) {
      assert.ok(validateJob({ ...valid(), [field]: value })[field], `${field}=${JSON.stringify(value)}`);
    }
  }
});

test('vCPUs are whole numbers from 1 to 1024; memory is 0.25–4096 GB with up to 2 decimals', () => {
  for (const vcpus of ['1', '1024']) assert.equal(validateJob({ ...valid(), vcpus }).vcpus, undefined, vcpus);
  for (const vcpus of ['', '0', '-1', '1.5', '1e2', '1025', '9007199254740992']) {
    assert.ok(validateJob({ ...valid(), vcpus }).vcpus, `vcpus=${JSON.stringify(vcpus)}`);
  }
  for (const memoryGb of ['0.25', '15.5', '4096']) assert.equal(validateJob({ ...valid(), memoryGb }).memoryGb, undefined, memoryGb);
  for (const memoryGb of ['', '0', '0.2', '1.555', '-1', '1e2', '4097', ' 4']) {
    assert.ok(validateJob({ ...valid(), memoryGb }).memoryGb, `memoryGb=${JSON.stringify(memoryGb)}`);
  }
});

test('GPU requirements: a known option, and VRAM checked only when a GPU is wanted', () => {
  assert.ok(validateJob({ ...valid(), gpu: 'intel' }).gpu);
  assert.equal(validateJob({ ...valid(), gpu: 'none', gpuVram: 'junk' }).gpuVram, undefined);
  for (const gpuVram of ['', '-1', '1.5', '1025']) assert.ok(validateJob({ ...valid(), gpu: 'any', gpuVram }).gpuVram, gpuVram);
  assert.deepEqual(validateJob({ ...valid(), gpu: 'nvidia', gpuVram: '8' }), {});
  assert.deepEqual(jobPayload({ ...valid(), gpu: 'amd', gpuVram: '16' }).requirements, { minVcpus: 2, minMemoryGb: 4, gpu: 'amd', minGpuVramGb: 16 });
  // VRAM left over from switching the GPU off isn't sent
  assert.equal(jobPayload({ ...valid(), gpu: 'none', gpuVram: '16' }).requirements.minGpuVramGb, 0);
});

test('resource summaries read as plain capacity', () => {
  assert.equal(resourceSummary({ minVcpus: 1, minMemoryGb: 0.5, gpu: 'none' }), '1 vCPU · 0.5 GB memory · no GPU');
  assert.equal(resourceSummary({ minVcpus: 4, minMemoryGb: 16, gpu: 'nvidia', minGpuVramGb: 8 }), '4 vCPUs · 16 GB memory · NVIDIA GPU with 8 GB+ VRAM');
  assert.equal(resourceSummary({ minVcpus: 2, minMemoryGb: 4, gpu: 'any', minGpuVramGb: 0 }), '2 vCPUs · 4 GB memory · GPU');
  assert.equal(resourceSummary(null), '—');
});

test('quorum cannot exceed provider count, and may equal it', () => {
  assert.ok(validateJob({ ...valid(), k: '2', quorum: '3' }).quorum);
  assert.equal(validateJob({ ...valid(), k: '3', quorum: '3' }).quorum, undefined);
});

test('provider count and quorum fit the contract uint8 fields', () => {
  assert.deepEqual(validateJob({ ...valid(), k: '255', quorum: '255' }), {});
  assert.ok(validateJob({ ...valid(), k: '256' }).k);
  assert.ok(validateJob({ ...valid(), k: '256', quorum: '256' }).quorum);
});

test('execution windows use whole minutes in the form and seconds in API payloads', () => {
  for (const minutes of ['1', '60', '10080']) {
    const values = { ...valid(), window: minutes };
    assert.equal(validateJob(values).window, undefined);
    assert.equal(jobPayload(values).timeWindow, Number(minutes) * 60);
  }
  assert.ok(validateJob({ ...valid(), window: '10081' }).window);
  assert.equal(windowMinutes(3600), '60');
  assert.equal(windowMinutes(90), '1.5');
  assert.equal(windowMinutes(604800), '10080');
  for (const seconds of [null, undefined, '60', 0, -1, NaN, Infinity]) assert.equal(windowMinutes(seconds), '—');
});

test('USD budgets validate with a quote and send only the converted ETH limit', () => {
  const values = { ...valid(), maxPrice: '25.50', budgetCurrency: 'USD' };
  assert.deepEqual(validateJob(values, '3000'), {});
  assert.equal(jobPayload(values, '3000').maxPrice, '0.0085');
  assert.equal(jobPayload(values, '3000').budgetCurrency, undefined);
  assert.match(validateJob(values).maxPrice, /valid ETH\/USD rate/);
  assert.match(validateJob({ ...values, maxPrice: '1.001' }, '3000').maxPrice, /positive USD hourly cap/);
  assert.match(validateJob({ ...values, maxPrice: '0.01' }, '10000000000000001').maxPrice, /less than 1 wei/);
  assert.throws(() => jobPayload(values), /valid ETH\/USD rate/);
});

test('Lucidchart aliases normalize without mutating the source job', () => {
  const source = { _id: { $oid: 'mongo-id' }, minNodesToRunOn: 3, minNodesToAgree: 2, timeWindow: 90, dockerImageDigest: 'sha256:digest', providers: ['one', 'two'], result: { hash: '0xhash', deliveryTime: '2026-10-18T12:00:00Z', location: 'object://result' } };
  const original = structuredClone(source);
  const job = normalizeJob(source);
  assert.equal(job.id, 'mongo-id');
  assert.equal(job.k, 3);
  assert.equal(job.quorum, 2);
  assert.equal(job.window, 90);
  assert.equal(job.dockerImage, 'sha256:digest');
  assert.equal(job.providerCount, 2);
  assert.equal(job.resultHash, '0xhash');
  assert.equal(job.consensusResultHash, undefined);
  assert.deepEqual(job.delivery, { receivedAt: '2026-10-18T12:00:00Z' });
  assert.deepEqual(source, original);
});

test('canonical values, including zero and empty strings, take precedence over aliases', () => {
  const job = normalizeJob({ id: 0, _id: 'legacy', k: 0, minNodesToRunOn: 3, quorum: 0, minNodesToAgree: 2, window: 0, timeWindow: 60, dockerImage: '', dockerImageDigest: 'legacy-image', providerCount: 0, providers: ['one'], resultHash: '', consensusResultHash: '', result: { hash: 'legacy-hash', deliveryTime: '2026-10-18T12:00:00Z' }, delivery: { status: 'VERIFIED', receivedAt: 'canonical-time', receiptId: 'receipt' }, payment: { status: 'PENDING' } });
  assert.equal(job.id, '0');
  for (const field of ['k', 'quorum', 'window', 'providerCount']) assert.equal(job[field], 0);
  assert.equal(job.dockerImage, '');
  assert.equal(job.resultHash, '');
  assert.equal(job.consensusResultHash, '');
  assert.deepEqual(job.delivery, { status: 'VERIFIED', receivedAt: 'canonical-time', receiptId: 'receipt' });
  assert.deepEqual(job.payment, { status: 'PENDING' });
});

test('normalization never infers result availability, delivery verification or payment', () => {
  for (const status of ['COMPLETED', 'PAYOUT', 'DELIVERY_RECEIPT_VALIDATION']) {
    const job = normalizeJob({ id: 'job', status, result: { hash: '0xhash', location: 'https://storage.example/result', deliveryTime: '2026-10-18T12:00:00Z' } });
    assert.equal(job.resultHash, '0xhash');
    assert.equal(job.consensusResultHash, undefined);
    assert.equal(job.result.available, undefined);
    assert.equal(job.delivery.status, undefined);
    assert.equal(job.delivery.verifiedAt, undefined);
    assert.equal(job.payment, undefined);
  }
  assert.deepEqual(normalizeJob({ id: 'minimal' }), { id: 'minimal' });
});

test('job IDs accept canonical, Mongo and numeric values and reject missing IDs', () => {
  assert.equal(normalizeJob({ _id: 'mongo-string' }).id, 'mongo-string');
  assert.equal(normalizeJob({ id: 'canonical', _id: 'legacy' }).id, 'canonical');
  assert.equal(normalizeJob({ _id: 42 }).id, '42');
  for (const value of [null, undefined, 'job', {}, { id: '' }, { _id: {} }]) {
    assert.throws(() => normalizeJob(value), /invalid job|without an ID/);
  }
});

test('phase descriptions distinguish execution, consensus, delivery and pending payout', () => {
  assert.match(jobPhase('COMMIT_PHASE')[1], /committing/);
  assert.match(jobPhase('REVEAL_PHASE')[1], /revealing/);
  assert.match(jobPhase('CONSENSUS_VERIFICATION')[1], /agree/);
  assert.match(jobPhase('AWAITING_DELIVERY')[1], /Waiting.*output/);
  assert.match(jobPhase('DELIVERY_RECEIPT_VALIDATION')[1], /receipt/);
  assert.equal(jobPhase('PAYOUT')[0], 'verifying');
  assert.match(jobPhase('PAYOUT')[1], /being processed/);
  assert.match(jobPhase('PAYOUT')[1], /separately/);
  assert.match(jobPhase('COMPLETED')[1], /Delivery and payment.*separately/);
  assert.equal(jobPhase('NO_QUORUM')[0], 'failed');
  assert.equal(jobPhase('CANCELLED')[0], 'canceled');
});

test('unknown phases and absent timestamps remain explicit', () => {
  assert.deepEqual(jobPhase('FUTURE_PHASE'), ['pending', 'The server has reported a new job phase.']);
  assert.deepEqual(jobPhase(undefined), jobPhase('FUTURE_PHASE'));
  for (const time of [null, undefined, '', 'not-a-date']) assert.equal(timeLabel(time), 'Not reported');
  assert.notEqual(timeLabel('2026-10-18T12:00:00Z'), 'Not reported');
});


test('normalization preserves explicit unavailable output and reported settlement', () => {
  const source = { id: 'job', resultHash: 'raw-hash', consensusResultHash: 'consensus-hash', result: { hash: 'legacy-hash', available: false }, delivery: { status: 'FAILED', receivedAt: '', verifiedAt: null }, payment: { status: 'PAID', settledAt: '2026-10-18T12:00:00Z' } };
  const normalized = normalizeJob(source);
  assert.deepEqual(normalized, source);
  assert.equal(normalized.result.available, false);
  assert.equal(normalized.delivery.verifiedAt, null);
  assert.equal(normalized.payment.status, 'PAID');
});

test('pinned images bypass tag resolution and legacy field names are not submitted', () => {
  const image = `registry.example/workload@sha256:${'a'.repeat(64)}`;
  const payload = jobPayload({ ...valid(), dockerImage: image });
  assert.equal(payload.dockerImageDigest, image);
  for (const field of ['image', 'dockerImage', 'k', 'quorum', 'window']) assert.equal(payload[field], undefined);
  assert.equal(payload.minNodesToRunOn, 3);
  assert.equal(payload.timeWindow, 600);
});

test('provider output links allow HTTP(S) URLs without embedded credentials', () => {
  assert.equal(resultUrl('https://storage.example/result?signature=abc'), 'https://storage.example/result?signature=abc');
  assert.equal(resultUrl('http://localhost:8080/result'), 'http://localhost:8080/result');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '/relative', 'file:///etc/passwd', 'https://user:secret@example.com/result', '', null]) assert.equal(resultUrl(url), null);
});
