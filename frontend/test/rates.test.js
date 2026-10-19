import test from 'node:test';
import assert from 'node:assert/strict';
import { ETH_USD_URL, QUOTE_MAX_AGE_MS, fetchEthUsdQuote } from '../src/rates.js';

const price = amount => ({ data: { base: 'ETH', currency: 'USD', amount } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('quotes use the public ETH-USD endpoint anonymously without caching', async () => {
  let requested;
  const quote = await fetchEthUsdQuote({ now: () => 123456, fetcher: async (url, options) => {
    requested = { url, options };
    return json(price('3210.123456789012345678'));
  } });
  assert.equal(requested.url, ETH_USD_URL);
  assert.equal(ETH_USD_URL, 'https://api.coinbase.com/v2/prices/ETH-USD/spot');
  assert.equal(requested.options.method, 'GET');
  assert.equal(requested.options.credentials, 'omit');
  assert.equal(requested.options.cache, 'no-store');
  assert.deepEqual(requested.options.headers, { Accept: 'application/json' });
  assert.ok(requested.options.signal instanceof AbortSignal);
  assert.deepEqual(quote, { usdPerEth: '3210.123456789012345678', fetchedAt: 123456 });
  assert.equal(QUOTE_MAX_AGE_MS, 60_000);
});

test('prices must be positive decimal strings for the exact ETH/USD pair', async () => {
  const invalid = [null, {}, { data: null }, { data: { base: 'BTC', currency: 'USD', amount: '3000' } }, { data: { base: 'ETH', currency: 'EUR', amount: '3000' } }];
  for (const amount of ['', '0', '0.000', '-1', 'NaN', 'Infinity', '1e3', '.1', '1.', ' 1', '0.0000000000000000001', '9'.repeat(101), 3000, null]) invalid.push(price(amount));
  for (const data of invalid) await assert.rejects(fetchEthUsdQuote({ fetcher: async () => json(data) }), /invalid ETH\/USD pricing/);
});

test('HTTP, network and malformed responses fail visibly without a fallback rate', async () => {
  for (const status of [401, 429, 500, 503]) await assert.rejects(fetchEthUsdQuote({ fetcher: async () => json({}, status) }), /price service is unavailable/);
  await assert.rejects(fetchEthUsdQuote({ fetcher: async () => { throw new TypeError('offline'); } }), /Could not load/);
  await assert.rejects(fetchEthUsdQuote({ fetcher: async () => new Response('{broken') }), /invalid ETH\/USD pricing/);
});

test('timeouts during fetch or body parsing have useful feedback', async () => {
  const timeout = new DOMException('expired', 'TimeoutError');
  await assert.rejects(fetchEthUsdQuote({ fetcher: async () => { throw timeout; } }), /took too long/);
  await assert.rejects(fetchEthUsdQuote({ fetcher: async () => ({ ok: true, async json() { throw timeout; } }) }), /took too long/);
});

test('caller cancellation is preserved before requests, during fetch and during JSON parsing', async () => {
  const before = new AbortController();
  const reason = new DOMException('left USD mode', 'AbortError');
  before.abort(reason);
  let requests = 0;
  await assert.rejects(fetchEthUsdQuote({ signal: before.signal, fetcher: async () => { requests++; } }), error => error === reason);
  assert.equal(requests, 0);
  const during = new AbortController();
  await assert.rejects(fetchEthUsdQuote({ signal: during.signal, fetcher: async (_url, options) => {
    during.abort(reason);
    assert.equal(options.signal.aborted, true);
    throw reason;
  } }), error => error === reason);
  const body = new AbortController();
  await assert.rejects(fetchEthUsdQuote({ signal: body.signal, fetcher: async () => ({ ok: true, async json() { body.abort(reason); return price('3000'); } }) }), error => error === reason);
});

test('quote timestamps are recorded after receiving a valid response', async () => {
  let stamp = 1;
  const quote = await fetchEthUsdQuote({ now: () => stamp, fetcher: async () => { stamp = 2; return json(price('3000')); } });
  assert.equal(quote.fetchedAt, 2);
  await assert.rejects(fetchEthUsdQuote({ now: () => NaN, fetcher: async () => json(price('3000')) }), /quote time/);
});
