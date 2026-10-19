import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ProtocolServer } from '../agent-manager/index.js';
import { testCertificates } from '../agent-manager/test/certificates.js';
import { HttpError } from '../errors.js';

const material = testCertificates();
after(() => material.close());
const first = { id: 'first', wallet: `0x${'1'.repeat(40)}` };
const second = { id: 'second', wallet: `0x${'2'.repeat(40)}` };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const job = { id: 'job-1', dockerImage: 'example/work:latest', requirements: { minCpuScore: 1 }, window: 60, deadlineAt: '2026-10-18T12:01:00Z' };

async function fixture(t, options = {}) {
  let time = Date.parse('2026-10-18T12:00:00Z');
  const calls = [];
  const revoked = new Set();
  const live = new Map();
  const pool = {
    get(wallet) { return structuredClone(live.get(wallet.toLowerCase()) ?? null); },
    register(provider) { live.set(provider.wallet.toLowerCase(), structuredClone(provider)); },
    remove(wallet) { live.delete(wallet.toLowerCase()); },
  };
  const hooks = {
    async authenticate(token) {
      calls.push(['authenticate', token]);
      if (revoked.has(token) || !['first', 'second', 'user'].includes(token)) throw new HttpError(401, 'Invalid provider credential.');
      if (token === 'user') return { ...first, scope: 'user' };
      return token === 'second' ? second : first;
    },
    repository: { async getAssignedJob(jobId, providerId) { return jobId === job.id && ['first', 'second'].includes(providerId) ? structuredClone(job) : null; } },
    async onHello(provider, specs) { calls.push(['hello', provider.id, specs]); pool.register({ ...pool.get(provider.wallet), wallet: provider.wallet, lastHeartbeat: time }); },
    async onHeartbeat(provider) { calls.push(['heartbeat', provider.id]); },
    async onAccept(provider, jobId) { calls.push(['accept', provider.id, jobId]); return { recorded: true }; },
    async onFailure(provider, jobId, message) { calls.push(['failure', provider.id, jobId, message]); },
    async onIdle(provider, jobId) { calls.push(['idle', provider.id, jobId]); },
    async getAssignment() { return null; },
  };
  const protocol = new ProtocolServer({ ...hooks, pool, now: () => time, ...options });
  const address = await protocol.listen({ key: material.key, cert: material.cert, port: 0 });
  const clients = [];
  t.after(async () => { for (const client of clients) client.socket.destroy(); await protocol.close(); });
  return {
    protocol, pool, calls, revoked, advance(ms) { time += ms; },
    async client() {
      const socket = tls.connect({ host: '127.0.0.1', port: address.port, ca: material.cert, servername: 'localhost', minVersion: 'TLSv1.3' });
      const frames = [];
      const waiters = [];
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', data => {
        buffer += data.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (waiters.length) waiters.shift()(frame); else frames.push(frame);
        }
      });
      await once(socket, 'secureConnect');
      assert.equal(socket.authorized, true);
      assert.equal(socket.getProtocol(), 'TLSv1.3');
      const client = {
        socket,
        send(frame) { socket.write(`${JSON.stringify(frame)}\n`); },
        next() {
          if (frames.length) return Promise.resolve(frames.shift());
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for a TLS frame.')), 2000);
            waiters.push(frame => { clearTimeout(timer); resolve(frame); });
          });
        },
        async hello(token = 'first') { this.send({ type: 'HELLO', token, specs: { cpuScore: 1 } }); return this.next(); },
        result(request, bytes = Buffer.from('output'), overrides = {}) {
          this.send({ type: 'RESULT', requestId: request.requestId, jobId: request.jobId, payload: { resultBase64: bytes.toString('base64'), sha256: sha(bytes), filename: 'result.txt', ...overrides } });
        },
      };
      clients.push(client);
      return client;
    },
  };
}

test('verified TLS1.3 handles fragmented HELLO and injected assignment/acceptance policy', async t => {
  const f = await fixture(t);
  const client = await f.client();
  const hello = `${JSON.stringify({ type: 'HELLO', token: 'first' })}\n`;
  client.socket.write(hello.slice(0, 10)); client.socket.write(hello.slice(10));
  assert.equal((await client.next()).type, 'HELLO_ACK');
  client.send({ type: 'HEARTBEAT' }); assert.equal((await client.next()).type, 'HEARTBEAT_ACK');
  assert.equal(await f.protocol.sendAssignment(first.wallet, job.id), true);
  assert.deepEqual(await client.next(), { type: 'ASSIGN_JOB', jobId: job.id });
  client.send({ type: 'ACCEPT_ACK', jobId: job.id });
  assert.deepEqual(await client.next(), { type: 'ACCEPTED', jobId: job.id, payload: { recorded: true } });
  assert.equal(await f.protocol.sendDockerImage(first.wallet, { ...job, dockerImage: 'not-the-assigned-image' }), true);
  assert.equal((await client.next()).payload.dockerImage, job.dockerImage);
  assert.equal(f.calls.filter(call => call[0] === 'authenticate').length, 4);
});

test('TLS1.2 cannot negotiate this transport', async t => {
  const f = await fixture(t);
  const socket = tls.connect({ host: '127.0.0.1', port: f.protocol.server.address().port, ca: material.cert, servername: 'localhost', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  await assert.rejects(once(socket, 'secureConnect')); socket.destroy();
});

test('no default auth exists; foreign scopes, missing credentials and duplicate wallets are rejected', async t => {
  assert.throws(() => new ProtocolServer({}), /authenticate must be provided/);
  const f = await fixture(t);
  for (const token of ['dev', 'user']) { const client = await f.client(); assert.equal((await client.hello(token)).status, token === 'user' ? 403 : 401); }
  const valid = await f.client(); await valid.hello();
  const duplicate = await f.client(); assert.equal((await duplicate.hello()).status, 409);
  valid.send({ type: 'HEARTBEAT' }); assert.equal((await valid.next()).type, 'HEARTBEAT_ACK');
});

test('first-frame, UTF8/JSON, and frame-size failures close the connection', async t => {
  const f = await fixture(t, { maxFrameBytes: 512 });
  for (const raw of ['{"type":"HEARTBEAT"}\n', '{broken}\n', Buffer.from([255, 10]), `${'x'.repeat(513)}\n`]) {
    const client = await f.client(); const closed = once(client.socket, 'close');
    client.socket.write(raw); assert.ok([400, 413].includes((await client.next()).status)); await closed;
  }
});

test('every frame revalidates credentials and immediate revocation rejects pending output', async t => {
  const f = await fixture(t);
  const client = await f.client(); await client.hello();
  f.revoked.add('first'); client.send({ type: 'HEARTBEAT' }); assert.equal((await client.next()).status, 401);
  f.revoked.clear(); const reconnect = await f.client(); await reconnect.hello();
  const rejected = assert.rejects(f.protocol.requestOutput(job.id, first.wallet), { status: 503 });
  await reconnect.next(); assert.equal(f.protocol.revokeWallet(first.wallet), true);
  assert.equal(f.protocol.hasSession(first.wallet), false); await rejected;
  assert.equal((await reconnect.next()).status, 401);
});

test('revocation while initial auth is awaiting cannot register live capacity', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  let revoked = false; let count = 0; let registered = false;
  const f = await fixture(t, {
    async authenticate() { count++; if (count === 1) { entered(); await gate; return first; } if (revoked) throw new HttpError(401, 'revoked'); return first; },
    async onHello() { registered = true; },
  });
  const client = await f.client(); const response = client.hello();
  await ready; revoked = true; assert.equal(f.protocol.revokeWallet(first.wallet), false); release();
  assert.equal((await response).status, 401); assert.equal(registered, false); assert.equal(f.protocol.hasSession(first.wallet), false);
});

test('requested output is correlated to provider, job and requestId', async t => {
  const f = await fixture(t); const client = await f.client(); await client.hello();
  const result = f.protocol.requestOutput(job.id, first.wallet, { providerId: first.id });
  const request = await client.next(); assert.equal(request.type, 'REQUEST_OUTPUT'); assert.equal(request.jobId, job.id);
  client.result(request); const output = await result;
  assert.equal(output.bytes.toString(), 'output'); assert.equal(output.providerId, first.id); assert.equal(output.wallet, first.wallet);
  assert.equal((await client.next()).type, 'RESULT_ACK'); assert.equal(f.protocol.pendingOutputs.size, 0);
});

test('unsolicited and cross-provider/job results cannot consume an outstanding request', async t => {
  const f = await fixture(t); const client = await f.client(); await client.hello();
  const other = await f.client(); await other.hello('second');
  client.result({ requestId: 'unsolicited', jobId: job.id }); assert.equal((await client.next()).status, 409);
  const pending = f.protocol.requestOutput(job.id, first.wallet); const request = await client.next();
  other.result(request); assert.equal((await other.next()).status, 409);
  client.result({ ...request, jobId: 'foreign-job' }); assert.equal((await client.next()).status, 403);
  assert.equal(f.protocol.pendingOutputs.size, 1); client.result(request); await pending; await client.next();
  await assert.rejects(f.protocol.requestOutput(job.id, first.wallet, { providerId: second.id }), { status: 403 });
});

test('output timeout, caller cancellation and disconnect clear pending correlation state', async t => {
  const f = await fixture(t); const client = await f.client(); await client.hello();
  const expired = assert.rejects(f.protocol.requestOutput(job.id, first.wallet, { timeoutMs: 25 }), { status: 504 });
  await client.next(); await expired; assert.equal(f.protocol.pendingOutputs.size, 0);
  const controller = new AbortController(); const reason = new DOMException('cancelled', 'AbortError');
  const cancelled = assert.rejects(f.protocol.requestOutput(job.id, first.wallet, { signal: controller.signal }), error => error === reason);
  await client.next(); controller.abort(reason); await cancelled; assert.equal(f.protocol.pendingOutputs.size, 0);
  const disconnected = assert.rejects(f.protocol.requestOutput(job.id, first.wallet), { status: 503 });
  await client.next(); client.socket.destroy(); await disconnected; assert.equal(f.protocol.pendingOutputs.size, 0);
});

test('output size and canonical base64 limits are checked before accepting bytes', async t => {
  const f = await fixture(t, { maxOutputBytes: 4 }); const client = await f.client(); await client.hello();
  const pending = f.protocol.requestOutput(job.id, first.wallet); const request = await client.next();
  client.result(request, Buffer.from('too-large')); assert.equal((await client.next()).status, 413);
  client.result(request, Buffer.from('ok'), { resultBase64: '!!!!' }); assert.equal((await client.next()).status, 400);
  client.result(request, Buffer.from('ok'), { filename: '../unsafe' }); assert.equal((await client.next()).status, 400);
  client.result(request, Buffer.from('ok')); assert.equal((await pending).bytes.toString(), 'ok'); await client.next();
});

test('assignment access rejects foreign jobs while recoverable errors keep the channel usable', async t => {
  const f = await fixture(t); const client = await f.client(); await client.hello();
  client.send({ type: 'ACCEPT_ACK', jobId: 'not-assigned' }); assert.equal((await client.next()).status, 403);
  client.send({ type: 'ERROR', jobId: job.id, message: 'execution failed' }); assert.equal((await client.next()).type, 'ERROR_ACK');
  client.send({ type: 'IDLE', jobId: job.id }); assert.equal((await client.next()).type, 'IDLE_ACK');
  client.send({ type: 'HEARTBEAT' }); assert.equal((await client.next()).type, 'HEARTBEAT_ACK');
  assert.ok(f.calls.find(call => call[0] === 'failure')); assert.ok(f.calls.find(call => call[0] === 'idle'));
});

test('stale sessions close without releasing busy reservations and oversized writes are bounded', async t => {
  const f = await fixture(t, { heartbeatTimeoutMs: 100 }); const client = await f.client(); await client.hello();
  f.pool.register({ wallet: first.wallet, busyJobId: job.id, lastHeartbeat: Date.now() });
  f.advance(101); assert.equal((await client.next()).status, 408);
  assert.equal(f.pool.get(first.wallet).busyJobId, job.id); assert.equal(f.pool.get(first.wallet).lastHeartbeat, 0);
  const bounded = await fixture(t, { maxFrameBytes: 512, repository: { async getAssignedJob() { return { ...job, dockerImage: 'x'.repeat(1024) }; } } });
  const receiver = await bounded.client(); await receiver.hello();
  assert.equal(await bounded.protocol.sendDockerImage(first.wallet, job), false); assert.equal(bounded.protocol.hasSession(first.wallet), false);
});
