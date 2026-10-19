import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../src/api.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('submission sends JSON, bearer token, and idempotency key to the configured API', async () => {
  const calls = [];
  const api = createApi({ baseUrl: 'https://api.example.test/v1/', fetcher: async (...args) => {
    calls.push(args);
    return json({ job: { id: '1' } }, 201);
  } });
  api.setToken('session-token');
  const payload = { dockerImage: 'example/image:latest', maxPrice: '0.1' };
  assert.deepEqual(await api.createJob(payload, 'request-key'), { job: { id: '1' } });
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.example.test/v1/jobs');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer session-token');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['Idempotency-Key'], 'request-key');
  assert.deepEqual(JSON.parse(options.body), payload);
  assert.ok(options.signal instanceof AbortSignal);
});

test('auth endpoints encode challenge parameters and send the signed message', async () => {
  const calls = [];
  const api = createApi({ fetcher: async (...args) => { calls.push(args); return json({}); } });
  await api.nonce('0xabc &?', 10);
  await api.verify('sign\nthis', '0xsigned');
  const challenge = new URL(calls[0][0], 'https://example.test');
  assert.equal(challenge.pathname, '/api/auth/nonce');
  assert.equal(challenge.searchParams.get('wallet'), '0xabc &?');
  assert.equal(challenge.searchParams.get('chainId'), '10');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[1][1].body), { message: 'sign\nthis', signature: '0xsigned' });
});

test('list view and job IDs are URL encoded', async () => {
  const urls = [];
  const api = createApi({ fetcher: async url => { urls.push(url); return json(url.includes('?') ? { jobs: [] } : { job: { id: '1' } }); } });
  await api.listJobs('buyer & provider');
  assert.deepEqual(await api.getJob('id/with ?#&'), { job: { id: '1' } });
  assert.equal(new URL(urls[0], 'https://example.test').searchParams.get('view'), 'buyer & provider');
  assert.equal(urls[1], '/api/jobs/id%2Fwith%20%3F%23%26');
});

test('clearing the token removes authorization on subsequent requests', async () => {
  const headers = [];
  const api = createApi({ fetcher: async (_, options) => { headers.push(options.headers); return json({}); } });
  api.setToken('old');
  await api.listJobs('buyer');
  api.setToken(null);
  await api.listJobs('buyer');
  assert.equal(headers[0].Authorization, 'Bearer old');
  assert.equal(headers[1].Authorization, undefined);
});

test('401 expires the current authenticated session and preserves the API error', async () => {
  const api = createApi({ fetcher: async () => json({ message: 'Session expired.' }, 401) });
  let expired = 0;
  api.setToken('current');
  api.onUnauthorized = () => { expired += 1; };
  await assert.rejects(api.listJobs('buyer'), error => error instanceof ApiError && error.status === 401 && error.message === 'Session expired.');
  assert.equal(expired, 1);
});

test('401 from an old token cannot expire a replacement session', async () => {
  let respond;
  const api = createApi({ fetcher: () => new Promise(resolve => { respond = resolve; }) });
  let expired = 0;
  api.onUnauthorized = () => { expired += 1; };
  api.setToken('old');
  const request = api.listJobs('buyer');
  api.setToken('new');
  respond(json({}, 401));
  await assert.rejects(request, { status: 401 });
  assert.equal(expired, 0);
});

test('unauthenticated 401 does not trigger session expiry', async () => {
  const api = createApi({ fetcher: async () => json({}, 401) });
  let expired = 0;
  api.onUnauthorized = () => { expired += 1; };
  await assert.rejects(api.nonce('0xabc', 1), { status: 401 });
  assert.equal(expired, 0);
});

test('non-JSON server errors have a useful fallback with status', async () => {
  const api = createApi({ fetcher: async () => new Response('<h1>Bad gateway</h1>', { status: 502 }) });
  await assert.rejects(api.getJob('1'), error => error instanceof ApiError && error.status === 502 && error.message === 'Request failed (502).');
});

test('network failures become an actionable API error', async () => {
  const api = createApi({ fetcher: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(api.getJob('1'), error => error instanceof ApiError && error.status === 0 && error.message.includes('Cannot reach the server'));
});

test('timeout errors have distinct feedback', async () => {
  const api = createApi({ fetcher: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  await assert.rejects(api.getJob('1'), error => error instanceof ApiError && error.message.includes('took too long'));
});

test('caller cancellation preserves the abort error', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancelled', 'AbortError');
  controller.abort(reason);
  const api = createApi({ fetcher: async (_, options) => {
    assert.equal(options.signal.aborted, true);
    throw reason;
  } });
  await assert.rejects(api.getJob('1', controller.signal), error => error === reason);
});

test('successful HTML and malformed JSON responses are rejected', async () => {
  const html = createApi({ fetcher: async () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(html.listJobs('buyer'), error => error instanceof ApiError && error.message.includes('VITE_API_BASE_URL'));
  const malformed = createApi({ fetcher: async () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(malformed.listJobs('buyer'));
});

test('result requests return binary content without JSON parsing and escape the ID', async () => {
  let requested;
  const api = createApi({ fetcher: async (url, options) => {
    requested = { url, options };
    return new Response(new Uint8Array([0, 255, 3]), { headers: { 'Content-Type': 'application/zip' } });
  } });
  api.setToken('session');
  const result = await api.getResult('a/b');
  assert.equal(requested.url, '/api/jobs/a%2Fb/result');
  assert.equal(requested.options.headers.Accept, 'application/octet-stream');
  assert.equal(requested.options.headers.Authorization, 'Bearer session');
  assert.equal(result.type, 'application/zip');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [0, 255, 3]);
});

test('listing, submission and detail normalize Lucidchart jobs while retaining response metadata', async () => {
  const legacy = { _id: { $oid: 'legacy-job' }, minNodesToRunOn: 3, minNodesToAgree: 2, timeWindow: 60, dockerImageDigest: 'sha256:example', providers: ['a', 'b'], result: { hash: '0xhash', deliveryTime: '2026-10-18T12:00:00Z' } };
  const api = createApi({ fetcher: async url => json(url.includes('?') ? { jobs: [legacy], summary: { activeJobs: 1 }, nextCursor: 'next' } : { job: legacy, requestId: 'request' }) });
  const listed = await api.listJobs('buyer');
  const created = await api.createJob({}, 'key');
  const detail = await api.getJob('legacy-job');
  for (const job of [listed.jobs[0], created.job, detail.job]) {
    assert.equal(job.id, 'legacy-job');
    assert.equal(job.k, 3);
    assert.equal(job.quorum, 2);
    assert.equal(job.window, 60);
    assert.equal(job.dockerImage, 'sha256:example');
    assert.equal(job.providerCount, 2);
    assert.equal(job.resultHash, '0xhash');
    assert.equal(job.consensusResultHash, undefined);
    assert.equal(job.delivery.receivedAt, '2026-10-18T12:00:00Z');
    assert.equal(job.result.available, undefined);
    assert.equal(job.delivery.status, undefined);
    assert.equal(job.delivery.verifiedAt, undefined);
    assert.equal(job.payment, undefined);
  }
  assert.deepEqual(listed.summary, { activeJobs: 1 });
  assert.equal(listed.nextCursor, 'next');
  assert.equal(created.requestId, 'request');
  assert.equal(detail.requestId, 'request');
});

test('malformed job detail and submission responses produce a useful schema error', async () => {
  const api = createApi({ fetcher: async () => json({ job: {} }) });
  await assert.rejects(api.getJob('missing'), /without an ID/);
  await assert.rejects(api.createJob({}, 'key'), /without an ID/);
});

test('provider profile, tutorial and pricing use authenticated adapter routes', async () => {
  const calls = [];
  const profile = { registered: true, pricePerHour: '0.000000000000000001' };
  const api = createApi({ baseUrl: '/service/', fetcher: async (url, options) => {
    calls.push({ url, options });
    return json(url.endsWith('/tutorial') ? { tutorial: { steps: ['Install client'] } } : { provider: profile });
  } });
  api.setToken('provider-token');
  assert.deepEqual(await api.getProvider(), { provider: profile });
  assert.deepEqual(await api.getProviderTutorial(), { tutorial: { steps: ['Install client'] } });
  assert.deepEqual(await api.saveProviderPricing({ pricePerHour: profile.pricePerHour }), { provider: profile });
  assert.deepEqual(calls.map(call => call.url), ['/service/provider/profile', '/service/provider/tutorial', '/service/provider/pricing']);
  for (const { options } of calls) assert.equal(options.headers.Authorization, 'Bearer provider-token');
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[2].options.body), { pricePerHour: '0.000000000000000001' });
});

test('every provider adapter operation handles authenticated 401 expiry', async () => {
  for (const invoke of [api => api.getProvider(), api => api.getProviderTutorial(), api => api.saveProviderPricing({ pricePerHour: '0.1' })]) {
    const api = createApi({ fetcher: async () => json({ message: 'Sign in again.' }, 401) });
    let expired = 0;
    api.setToken('provider-token');
    api.onUnauthorized = () => { expired += 1; };
    await assert.rejects(invoke(api), error => error instanceof ApiError && error.status === 401 && error.message === 'Sign in again.');
    assert.equal(expired, 1);
  }
});

test('pricing errors retain the server message without expiring a valid session', async () => {
  const api = createApi({ fetcher: async () => json({ message: 'Pricing service unavailable.' }, 503) });
  let expired = 0;
  api.setToken('provider-token');
  api.onUnauthorized = () => { expired += 1; };
  await assert.rejects(api.saveProviderPricing({ pricePerHour: '0.1' }), error => error instanceof ApiError && error.status === 503 && error.message === 'Pricing service unavailable.');
  assert.equal(expired, 0);
});


test('provider profile and tutorial preserve caller cancellation', async () => {
  for (const invoke of [(api, signal) => api.getProvider(signal), (api, signal) => api.getProviderTutorial(signal)]) {
    const controller = new AbortController();
    const reason = new DOMException('left provider setup', 'AbortError');
    controller.abort(reason);
    const api = createApi({ fetcher: async (_, options) => {
      assert.equal(options.signal.aborted, true);
      throw reason;
    } });
    await assert.rejects(invoke(api, controller.signal), error => error === reason);
  }
});
