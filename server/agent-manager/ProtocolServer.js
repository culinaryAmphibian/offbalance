import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { assert, HttpError } from '../errors.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const walletKey = wallet => wallet.toLowerCase();
const jobIdValid = value => (typeof value === 'string' && value.length > 0 && value.length <= 128) || (Number.isSafeInteger(value) && value >= 0);
const sameProvider = (left, right) => left.id === right.id && walletKey(left.wallet) === walletKey(right.wallet);

/** TLS transport only. Authentication, assignment ownership and job policy are injected. */
export class ProtocolServer {
  constructor({ authenticate, repository, onHello, onHeartbeat, onAccept, onFailure, onIdle, getAssignment, onDisconnect, pool,
    heartbeatTimeoutMs = 30_000, outputTimeoutMs = 30_000, maxFrameBytes = 12 * 1024 * 1024, maxOutputBytes = 8 * 1024 * 1024, now = Date.now }) {
    for (const [name, handler] of Object.entries({ authenticate, onHello, onHeartbeat, onAccept, onFailure, onIdle, getAssignment })) assert(typeof handler === 'function', 500, `${name} must be provided.`);
    assert(typeof repository?.getAssignedJob === 'function', 500, 'An assignment repository must be provided.');
    assert(Number.isSafeInteger(maxFrameBytes) && maxFrameBytes >= 128 && Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0, 500, 'Invalid provider size limits.');
    assert(Number.isFinite(heartbeatTimeoutMs) && heartbeatTimeoutMs > 0 && Number.isFinite(outputTimeoutMs) && outputTimeoutMs > 0, 500, 'Invalid provider timeout.');
    Object.assign(this, { authenticate, repository, onHello, onHeartbeat, onAccept, onFailure, onIdle, getAssignment, onDisconnect, pool,
      heartbeatTimeoutMs, outputTimeoutMs, maxFrameBytes, maxOutputBytes, now });
    this.sessions = new Map();
    this.sockets = new Set();
    this.pendingOutputs = new Map();
  }

  async listen({ host = '127.0.0.1', port = 4001, key, cert }) {
    assert(!this.server, 409, 'Provider protocol is already running.');
    const server = tls.createServer({ key, cert, minVersion: 'TLSv1.3', handshakeTimeout: 5000 }, socket => this.connect(socket));
    this.server = server;
    server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
      });
    } catch (error) { this.server = null; server.close(); throw error; }
    this.sweep = setInterval(() => {
      for (const session of this.sessions.values()) if (this.now() - session.lastSeen >= this.heartbeatTimeoutMs) this.fail(session, 408, 'Provider heartbeat timed out.');
    }, Math.max(25, Math.min(1000, this.heartbeatTimeoutMs / 2)));
    this.sweep.unref();
    return server.address();
  }

  async close() {
    clearInterval(this.sweep);
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const session of this.sessions.values()) { this.disconnect(session); session.socket.destroy(); }
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  hasSession(wallet) {
    const session = this.sessions.get(walletKey(wallet));
    return Boolean(session && !session.closed && session.socket.writable && !session.socket.destroyed);
  }

  revokeWallet(wallet) {
    const session = this.sessions.get(walletKey(wallet));
    if (!session || session.closed) return false;
    this.fail(session, 401, 'Provider credential revoked.');
    return true;
  }

  async identity(token) {
    const provider = await this.authenticate(token);
    assert(object(provider) && typeof provider.id === 'string' && provider.id.length > 0 && typeof provider.wallet === 'string' && /^0x[\da-f]{40}$/i.test(provider.wallet), 401, 'Invalid provider identity.');
    assert(provider.scope === undefined || provider.scope === 'provider', 403, 'A provider credential is required.');
    return { id: provider.id, wallet: provider.wallet };
  }

  async assigned(jobId, provider) {
    assert(jobIdValid(jobId), 400, 'A valid jobId is required.');
    const job = await this.repository.getAssignedJob(jobId, provider.id);
    assert(job, 403, 'This job is not assigned to the provider.');
    return job;
  }

  async sendAssignment(wallet, jobId) {
    const session = this.sessions.get(walletKey(wallet));
    if (!session || session.closed) return false;
    await this.assigned(jobId, session.provider);
    if (session.closed) return false;
    if (!session.ready) { session.pendingAssignments.add(jobId); return true; }
    return this.write(session, { type: 'ASSIGN_JOB', jobId });
  }

  async sendDockerImage(wallet, job) {
    const session = this.sessions.get(walletKey(wallet));
    if (!session || !session.ready || session.closed) return false;
    const assigned = await this.assigned(job.id, session.provider);
    // Registry reference only; the coordinator decides when execution may start.
    return this.write(session, { type: 'DOCKER_IMAGE', jobId: job.id,
      payload: { dockerImage: assigned.dockerImage, requirements: assigned.requirements, window: assigned.window, deadlineAt: assigned.deadlineAt } });
  }

  async requestOutput(jobId, wallet, { signal, timeoutMs = this.outputTimeoutMs, providerId } = {}) {
    signal?.throwIfAborted();
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 400, 'Output timeout must be positive.');
    const session = this.sessions.get(walletKey(wallet));
    assert(session?.ready && !session.closed, 503, 'The provider is not connected.');
    const current = await this.identity(session.token);
    assert(sameProvider(current, session.provider) && (providerId === undefined || providerId === current.id), 403, 'Provider identity does not match the output request.');
    await this.assigned(jobId, current);
    signal?.throwIfAborted();
    assert(!session.closed, 503, 'The provider disconnected.');
    assert(this.pendingOutputs.size < 128 && session.pendingOutputs.size < 4, 429, 'Too many pending output requests.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { requestId, jobId, session, resolve, reject, signal };
      pending.abort = () => this.settleOutput(pending, signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      pending.timer = setTimeout(() => this.settleOutput(pending, new HttpError(504, 'Provider output request timed out.')), timeoutMs);
      pending.timer.unref();
      this.pendingOutputs.set(requestId, pending);
      session.pendingOutputs.add(requestId);
      signal?.addEventListener('abort', pending.abort, { once: true });
      if (signal?.aborted) pending.abort();
      else if (!this.write(session, { type: 'REQUEST_OUTPUT', requestId, jobId })) this.settleOutput(pending, new HttpError(503, 'The provider disconnected.'));
    });
  }

  settleOutput(pending, error, result) {
    if (this.pendingOutputs.get(pending.requestId) !== pending) return;
    this.pendingOutputs.delete(pending.requestId);
    pending.session.pendingOutputs.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error); else pending.resolve(result);
  }

  connect(socket) {
    const session = { socket, buffer: Buffer.alloc(0), queue: Promise.resolve(), closed: false, provider: null, token: null,
      ready: false, lastSeen: this.now(), pendingAssignments: new Set(), pendingOutputs: new Set() };
    socket.setNoDelay(true);
    session.helloTimer = setTimeout(() => this.fail(session, 408, 'Send HELLO within five seconds.'), 5000);
    session.helloTimer.unref();
    socket.on('error', () => this.disconnect(session));
    socket.once('close', () => this.disconnect(session));
    socket.on('data', chunk => this.read(session, chunk));
  }

  read(session, chunk) {
    if (session.closed) return;
    session.socket.pause();
    if (session.buffer.length + chunk.length > this.maxFrameBytes * 2) { this.fail(session, 413, 'Provider input buffer limit exceeded.'); return; }
    const buffer = Buffer.concat([session.buffer, chunk]);
    const frames = [];
    let start = 0;
    let end;
    while ((end = buffer.indexOf(10, start)) !== -1) {
      if (end - start > this.maxFrameBytes) { this.fail(session, 413, 'Provider frame is too large.'); return; }
      frames.push(buffer.subarray(start, end)); start = end + 1;
    }
    session.buffer = buffer.subarray(start);
    if (session.buffer.length > this.maxFrameBytes) { this.fail(session, 413, 'Provider frame is too large.'); return; }
    session.queue = session.queue.then(async () => {
      for (const frame of frames) {
        if (session.closed) break;
        let request;
        try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
        catch { this.fail(session, 400, 'Provider frame must be valid UTF-8 JSON.'); break; }
        if (!object(request) || typeof request.type !== 'string') { this.fail(session, 400, 'Provider frame must contain a type.'); break; }
        await this.handle(session, request);
      }
      if (!session.closed) session.socket.resume();
    }).catch(() => this.fail(session, 500, 'Provider protocol request failed.'));
  }

  async handle(session, request) {
    if (!session.provider) {
      if (request.type !== 'HELLO') { this.fail(session, 400, 'The first provider frame must be HELLO.'); return; }
      try {
        const provider = await this.identity(request.token);
        if (session.closed) return;
        assert(!this.hasSession(provider.wallet), 409, 'This wallet already has a provider connection.');
        session.provider = provider;
        session.token = request.token;
        this.sessions.set(walletKey(provider.wallet), session);
        assert(sameProvider(await this.identity(request.token), provider), 401, 'Provider identity changed.');
        if (session.closed) return;
        await this.onHello(provider, request.specs);
        const assignment = await this.getAssignment(provider);
        if (assignment) { await this.assigned(assignment.id, provider); session.pendingAssignments.add(assignment.id); }
        if (session.closed) return;
        clearTimeout(session.helloTimer);
        session.lastSeen = this.now();
        this.write(session, { type: 'HELLO_ACK', providerId: provider.id, heartbeatTimeoutMs: this.heartbeatTimeoutMs });
        session.ready = true;
        for (const jobId of session.pendingAssignments) await this.sendAssignment(provider.wallet, jobId);
        session.pendingAssignments.clear();
      } catch (error) { this.fail(session, error.status || 401, error.status ? error.message : 'Provider handshake failed.'); }
      return;
    }
    try { assert(sameProvider(await this.identity(session.token), session.provider), 401, 'Provider identity changed.'); }
    catch (error) { this.fail(session, error.status || 401, 'Provider credential expired or revoked.'); return; }
    if (session.closed) return;
    session.lastSeen = this.now();
    try {
      const provider = session.provider;
      if (['ACCEPT_ACK', 'RESULT', 'ERROR', 'IDLE'].includes(request.type)) await this.assigned(request.jobId, provider);
      if (session.closed) return;
      switch (request.type) {
        case 'HEARTBEAT':
          await this.onHeartbeat(provider); this.write(session, { type: 'HEARTBEAT_ACK' }); break;
        case 'ACCEPT_ACK': {
          const payload = await this.onAccept(provider, request.jobId);
          this.write(session, { type: 'ACCEPTED', jobId: request.jobId, ...(payload === undefined ? {} : { payload }) });
          break;
        }
        case 'RESULT': this.receiveOutput(session, request); break;
        case 'ERROR':
          assert(typeof request.message === 'string' && request.message.length > 0 && request.message.length <= 2000, 400, 'A provider error message is required (at most 2000 characters).');
          await this.onFailure(provider, request.jobId, request.message);
          this.write(session, { type: 'ERROR_ACK', jobId: request.jobId }); break;
        case 'IDLE':
          await this.onIdle(provider, request.jobId); this.write(session, { type: 'IDLE_ACK', jobId: request.jobId }); break;
        default: assert(false, 400, `Unsupported provider message: ${request.type.slice(0, 100)}.`);
      }
    } catch (error) {
      this.write(session, { type: 'ERROR', status: error.status || 500, message: error.status ? error.message : 'Provider request failed.' });
    }
  }

  receiveOutput(session, request) {
    const pending = this.pendingOutputs.get(request.requestId);
    assert(pending && pending.session === session && pending.jobId === request.jobId, 409, 'Output was not requested for this provider and job.');
    const payload = request.payload;
    assert(object(payload) && typeof payload.resultBase64 === 'string' && payload.resultBase64.length <= Math.ceil(this.maxOutputBytes / 3) * 4, 413, 'Provider output exceeds the allowed size.');
    const bytes = Buffer.from(payload.resultBase64, 'base64');
    assert(bytes.length <= this.maxOutputBytes && bytes.toString('base64') === payload.resultBase64, 400, 'Provider output must be canonical base64 within the size limit.');
    assert(typeof payload.sha256 === 'string' && /^[\da-f]{64}$/i.test(payload.sha256), 400, 'Provider output must include its SHA-256 hash.');
    const filename = payload.filename ?? 'result.bin';
    assert(typeof filename === 'string' && filename.length > 0 && filename.length <= 120 && !/[\\/\x00-\x1f\x7f]/.test(filename), 400, 'Use an output filename without paths or control characters.');
    this.settleOutput(pending, null, { bytes, sha256: payload.sha256.toLowerCase(), filename, providerId: session.provider.id, wallet: session.provider.wallet });
    this.write(session, { type: 'RESULT_ACK', requestId: request.requestId, jobId: request.jobId, size: bytes.length });
  }

  write(session, frame) {
    if (session.closed || session.socket.destroyed || !session.socket.writable) return false;
    const data = `${JSON.stringify(frame)}\n`;
    const size = Buffer.byteLength(data);
    if (size > this.maxFrameBytes || session.socket.writableLength + size > this.maxFrameBytes * 2) { this.disconnect(session); session.socket.destroy(); return false; }
    try { session.socket.write(data); return true; }
    catch { this.disconnect(session); session.socket.destroy(); return false; }
  }

  fail(session, status, message) {
    if (session.closed) return;
    this.write(session, { type: 'ERROR', status, message });
    this.disconnect(session);
    session.socket.end();
    const timer = setTimeout(() => session.socket.destroy(), 250); timer.unref();
  }

  disconnect(session) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.helloTimer);
    for (const requestId of session.pendingOutputs) this.settleOutput(this.pendingOutputs.get(requestId), new HttpError(503, 'The provider disconnected.'));
    const provider = session.provider;
    if (!provider || this.sessions.get(walletKey(provider.wallet)) !== session) return;
    this.sessions.delete(walletKey(provider.wallet));
    const live = this.pool?.get(provider.wallet);
    if (live?.busyJobId) this.pool.register({ ...live, lastHeartbeat: 0 });
    else this.pool?.remove(provider.wallet);
    if (this.onDisconnect) Promise.resolve().then(() => this.onDisconnect(provider)).catch(() => {});
  }
}
