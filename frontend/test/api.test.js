import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../src/api.js';

const wallet = `0x${'a'.repeat(40)}`;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const dashboard = {
  account: { currentStake: '0.05' },
  buyer: { activeJobs: 4, completedJobs: 2, totalSpent: '0.008', jobs: [{ id: 9 }] },
  provider: { activeJobs: 1, completedJobs: 5, totalEarned: '0.02', jobs: [], hardware: {} },
};

// Fixtures use the public API's actual routes and JSON envelopes.
test('auth signs a raw server challenge and posts wallet/signature to /auth', async () => {
  const calls = [];
  const message = `Sign in to OffBalance\n\nWallet: ${wallet}\nNonce: ${'b'.repeat(32)}`;
  const api = createApi({ fetcher: async (...args) => {
    calls.push(args);
    return json(calls.length === 1 ? { message, wallet } : { token: 'session', accountId: 'account', wallet }, 201);
  } });
  assert.deepEqual(await api.nonce(wallet), { message, wallet });
  assert.deepEqual(await api.verify(wallet, '0xsigned'), {
    token: 'session', accountId: 'account', wallet, account: { id: 'account', wallet },
  });
  assert.equal(new URL(calls[0][0], 'https://localhost').searchParams.get('wallet'), wallet);
  assert.equal(calls[1][0], '/api/auth');
  assert.deepEqual(JSON.parse(calls[1][1].body), { wallet, signature: '0xsigned' });
  assert.equal(calls[0][1].headers.Authorization, undefined);
});

test('logout revokes a captured session and accepts the server 204 response', async () => {
  const calls = [];
  const api = createApi({ fetcher: async (...args) => { calls.push(args); return new Response(null, { status: 204 }); } });
  api.setToken('replacement');
  assert.equal(await api.logout('original'), null);
  assert.equal(calls[0][0], '/api/auth/logout');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer original');
});

test('submission posts server fields with bearer token and preserves normalized job metadata', async () => {
  const calls = [];
  const api = createApi({ baseUrl: 'https://localhost:3001/', fetcher: async (...args) => {
    calls.push(args);
    return json({ job: { id: 1, dockerImageDigest: 'image@sha256:abc', minNodesToRunOn: 3 }, requestId: 'request' }, 201);
  } });
  api.setToken('session');
  const payload = { image: 'example/image:latest', maxPrice: '0.1', minNodesToRunOn: 3 };
  const created = await api.createJob(payload, 'request-key');
  assert.equal(created.job.id, '1');
  assert.equal(created.job.k, 3);
  assert.equal(created.requestId, 'request');
  const [url, options] = calls[0];
  assert.equal(url, 'https://localhost:3001/jobs');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer session');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['Idempotency-Key'], 'request-key');
  assert.deepEqual(JSON.parse(options.body), payload);
  assert.ok(options.signal instanceof AbortSignal);
});

test('job listings use role and full list, with authoritative dashboard totals', async () => {
  const urls = [];
  const fullList = Array.from({ length: 25 }, (_, id) => ({ id, minNodesToRunOn: 3 }));
  const api = createApi({ fetcher: async url => {
    urls.push(url);
    return json(url.endsWith('/dashboard') ? dashboard : { jobs: fullList });
  } });
  const buyer = await api.listJobs('buyer');
  assert.equal(buyer.jobs.length, 25);
  assert.equal(buyer.jobs[24].id, '24');
  assert.equal(buyer.jobs[0].k, 3);
  assert.deepEqual(buyer.summary, { activeJobs: 4, completedJobs: 2, totalSpent: '0.008' });
  const provider = await api.listJobs('provider');
  assert.deepEqual(provider.summary, { activeJobs: 1, completedJobs: 5, totalEarned: '0.02', currentStake: '0.05' });
  assert.deepEqual(urls, ['/api/jobs?role=buyer', '/api/account/me/dashboard', '/api/jobs?role=provider', '/api/account/me/dashboard']);
});

test('job detail URL encodes IDs and normalizes persisted job fields', async () => {
  let url;
  const api = createApi({ fetcher: async value => {
    url = value;
    return json({ job: { id: 7, minNodesToRunOn: 3, minNodesToAgree: 2, timeWindow: 60, dockerImageDigest: 'repo@sha256:abc', providers: ['a', 'b'] } });
  } });
  const { job } = await api.getJob('id/with ?#&');
  assert.equal(url, '/api/jobs/id%2Fwith%20%3F%23%26');
  assert.equal(job.id, '7');
  assert.equal(job.k, 3);
  assert.equal(job.quorum, 2);
  assert.equal(job.window, 60);
  assert.equal(job.providerCount, 2);
  assert.equal(job.result, undefined);
  assert.equal(job.payment, undefined);
});

test('results are authenticated JSON metadata rather than an invented archive', async () => {
  let requested;
  const result = { status: 'AWAITING_DELIVERY', results: [{ provider: 'account', hash: '0xhash', location: 'https://storage.test/output', receiptVerified: false }] };
  const api = createApi({ fetcher: async (url, options) => { requested = { url, options }; return json(result); } });
  api.setToken('session');
  assert.deepEqual(await api.getResult('a/b'), result);
  assert.equal(requested.url, '/api/jobs/a%2Fb/result');
  assert.equal(requested.options.headers.Accept, 'application/json');
  assert.equal(requested.options.headers.Authorization, 'Bearer session');
});

test('configuration exposes the coordinator chain and execution mode', async () => {
  const config = { executionMode: 'database-only', chain: null };
  const api = createApi({ fetcher: async url => { assert.equal(url, '/api/config'); return json(config); } });
  assert.deepEqual(await api.getConfig(), config);
});

test('provider hardware, runtime liveness and account stake map to the setup view', async () => {
  const hardware = { id: 'machine', price: 0.002, cpuScore: 100, gpuScore: 50, memoryScore: 200, updatedAt: '2026-10-19T00:00:00Z' };
  const api = createApi({ fetcher: async url => json(url.endsWith('/dashboard') ? dashboard : {
    hardware, suggestedPrice: 0.003, online: true, lastSeen: '2026-10-19T01:00:00Z',
  }) });
  const { provider } = await api.getProvider();
  assert.deepEqual(provider, {
    registered: true, machine: hardware, pricePerHour: '0.002', suggestedPricePerHour: '0.003', currentStake: '0.05', online: true, lastSeen: '2026-10-19T01:00:00Z',
  });
});

test('unregistered hardware is a valid setup state and scores do not imply online', async () => {
  for (const status of [200, 404]) {
    const api = createApi({ fetcher: async url => json(url.endsWith('/dashboard') ? dashboard : { hardware: null }, url.endsWith('/dashboard') ? 200 : status) });
    const { provider } = await api.getProvider();
    assert.equal(provider.registered, false);
    assert.equal(provider.online, false);
    assert.equal(provider.machine, null);
    assert.equal(provider.currentStake, '0.05');
  }
});

test('provider tutorial preserves server text and pricing posts the real price field', async () => {
  const calls = [];
  const api = createApi({ fetcher: async (url, options) => {
    calls.push({ url, options });
    return json(url.endsWith('/tutorial') ? { text: 'Install the client.\n\nRun it with your API token.', updatedAt: '2026-10-19' } : { hardware: { id: 'machine', price: 0.002 } });
  } });
  api.setToken('provider');
  assert.deepEqual(await api.getProviderTutorial(), { tutorial: { title: 'Client setup', steps: ['Install the client.', 'Run it with your API token.'], updatedAt: '2026-10-19' } });
  assert.equal((await api.saveProviderPricing({ pricePerHour: '0.002' })).provider.pricePerHour, '0.002');
  assert.deepEqual(calls.map(({ url }) => url), ['/api/provider/tutorial', '/api/provider/price']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { price: '0.002' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer provider');
});

test('401 clears only the current authenticated session and retains server error detail', async () => {
  const api = createApi({ fetcher: async () => json({ error: 'bad token' }, 401) });
  let expired = 0;
  api.onUnauthorized = () => { expired += 1; };
  api.setToken('current');
  await assert.rejects(api.getJob('1'), error => error instanceof ApiError && error.status === 401 && error.message === 'bad token');
  assert.equal(expired, 1);
  api.setToken(null);
  await assert.rejects(api.nonce(wallet), { status: 401 });
  assert.equal(expired, 1);
});

test('401 from an old token cannot expire a replacement session', async () => {
  let respond;
  const api = createApi({ fetcher: () => new Promise(resolve => { respond = resolve; }) });
  let expired = 0;
  api.onUnauthorized = () => { expired += 1; };
  api.setToken('old');
  const request = api.getJob('1');
  api.setToken('new');
  respond(json({}, 401));
  await assert.rejects(request, { status: 401 });
  assert.equal(expired, 0);
});

test('clearing a token removes authorization and pricing errors retain server detail', async () => {
  const headers = [];
  const api = createApi({ fetcher: async (_, options) => { headers.push(options.headers); return json({ error: 'Pricing service unavailable.' }, 503); } });
  api.setToken('old');
  await assert.rejects(api.saveProviderPricing({ pricePerHour: '0.1' }), /Pricing service unavailable/);
  api.setToken(null);
  await assert.rejects(api.getJob('1'), { status: 503 });
  assert.equal(headers[0].Authorization, 'Bearer old');
  assert.equal(headers[1].Authorization, undefined);
});

test('network and timeout failures have actionable errors', async () => {
  const disconnected = createApi({ fetcher: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(disconnected.getJob('1'), error => error instanceof ApiError && error.status === 0 && /Cannot reach/.test(error.message));
  const timeout = createApi({ fetcher: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  await assert.rejects(timeout.getJob('1'), /took too long/);
});

test('caller cancellation is preserved across provider and job requests', async () => {
  for (const invoke of [(api, signal) => api.getProvider(signal), (api, signal) => api.getProviderTutorial(signal), (api, signal) => api.getJob('1', signal)]) {
    const controller = new AbortController();
    const signal = controller.signal;
    const reason = new DOMException('left page', 'AbortError');
    controller.abort(reason);
    const api = createApi({ fetcher: async (_, options) => { assert.equal(options.signal.aborted, true); throw reason; } });
    await assert.rejects(invoke(api, signal), error => error === reason);
  }
});

test('HTML, malformed JSON and malformed job envelopes fail explicitly', async () => {
  const html = createApi({ fetcher: async () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(html.getJob('1'), /VITE_API_BASE_URL/);
  const malformed = createApi({ fetcher: async () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(malformed.getJob('1'), /invalid JSON/);
  const missing = createApi({ fetcher: async () => json({ job: {} }) });
  await assert.rejects(missing.getJob('1'), /without an ID/);
  await assert.rejects(missing.createJob({}, 'key'), /without an ID/);
  const gateway = createApi({ fetcher: async () => new Response('<html/>', { status: 502 }) });
  await assert.rejects(gateway.getJob('1'), { status: 502, message: 'Request failed (502).' });
});


test('small provider rates remain editable decimal strings after Mongo numeric serialization', async () => {
  const api = createApi({ fetcher: async () => json({ hardware: { price: 1e-18 } }) });
  const response = await api.saveProviderPricing({ pricePerHour: '0.000000000000000001' });
  assert.equal(response.provider.pricePerHour, '0.000000000000000001');
});
