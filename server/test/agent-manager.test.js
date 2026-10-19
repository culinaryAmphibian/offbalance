import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AgentManager } from '../agent-manager/index.js';

const wallet = `0x${'1'.repeat(40)}`;
const bytes = Buffer.from('verified provider output');
const hash = createHash('sha256').update(bytes).digest('hex');
const input = { jobId: 'job-1', providerId: 'provider-1', wallet, expectedHash: `0x${hash}` };

function fixture(options = {}) {
  const calls = [];
  const output = { bytes, sha256: hash, filename: 'answer.txt', providerId: input.providerId, wallet };
  const ports = {
    repository: { async getAssignedJob(jobId, providerId) { calls.push(['assigned', jobId, providerId]); return { id: jobId }; } },
    providerTransport: { async requestOutput(jobId, providerWallet, context) { calls.push(['request', jobId, providerWallet, context]); return output; } },
    objectStorage: {
      async put(content, metadata) { calls.push(['put', Buffer.from(content), metadata]); return 'object:stored-output'; },
      async get(reference) { calls.push(['get', reference]); return bytes; },
    },
  };
  const manager = new AgentManager({ ...ports, ...options });
  return { manager, calls, output };
}

test('requested output is stored only after matching the caller-observed hash and provider', async () => {
  const f = fixture(); const result = await f.manager.collectOutput(input);
  assert.deepEqual(result, { reference: 'object:stored-output', jobId: input.jobId, providerId: input.providerId, hash, filename: 'answer.txt', size: bytes.length });
  assert.deepEqual(f.calls[1].slice(0, 3), ['request', input.jobId, wallet]); assert.equal(f.calls[1][3].providerId, input.providerId);
  assert.deepEqual(f.calls[2], ['put', bytes, { jobId: input.jobId, providerId: input.providerId, hash, filename: 'answer.txt' }]);
  assert.deepEqual(await f.manager.requestAnswer(result.reference, { expectedHash: hash }), bytes);
});

test('missing assignment and missing observed hash fail before requesting provider bytes', async () => {
  const f = fixture(); await assert.rejects(f.manager.collectOutput({ ...input, expectedHash: null }), { status: 400 }); assert.deepEqual(f.calls, []);
  const blocked = fixture({ repository: { async getAssignedJob() { return null; } } });
  await assert.rejects(blocked.manager.collectOutput(input), { status: 403 }); assert.deepEqual(blocked.calls, []);
});

test('provider identity mismatches and unverified bytes never reach object storage', async () => {
  for (const changes of [{ providerId: 'someone-else' }, { wallet: `0x${'2'.repeat(40)}` }, { bytes: Buffer.from('different output') }, { sha256: '0'.repeat(64) }, { filename: '../unsafe' }]) {
    const f = fixture(); Object.assign(f.output, changes); await assert.rejects(f.manager.collectOutput(input));
    assert.equal(f.calls.some(call => call[0] === 'put'), false);
  }
});

test('size limits and persisted-byte integrity apply equally to upload and retrieval', async () => {
  const small = fixture({ maxOutputBytes: 4 });
  await assert.rejects(small.manager.collectOutput(input), { status: 413 });
  await assert.rejects(small.manager.requestAnswer('object:ref', { expectedHash: hash }), { status: 413 });
  const corrupt = fixture({ objectStorage: { async put() {}, async get() { return Buffer.from('corrupt'); } } });
  await assert.rejects(corrupt.manager.requestAnswer('object:ref', { expectedHash: hash }), { status: 422 });
  await assert.rejects(corrupt.manager.requestAnswer('object:ref'), { status: 400 });
});

test('cancellation is preserved before work and after provider retrieval without storing output', async () => {
  const controller = new AbortController(); const reason = new DOMException('stop', 'AbortError'); controller.abort(reason);
  const f = fixture(); await assert.rejects(f.manager.collectOutput({ ...input, signal: controller.signal }), error => error === reason); assert.deepEqual(f.calls, []);
  const later = new AbortController();
  const stopped = fixture({ providerTransport: { async requestOutput() { later.abort(reason); return f.output; } } });
  await assert.rejects(stopped.manager.collectOutput({ ...input, signal: later.signal }), error => error === reason);
  assert.equal(stopped.calls.some(call => call[0] === 'put'), false);
});

test('construction requires explicit transport, repository and storage adapters', () => {
  assert.throws(() => new AgentManager({}), /provider output transport/);
  assert.throws(() => new AgentManager({ providerTransport: { requestOutput() {} } }), /Object storage/);
});
