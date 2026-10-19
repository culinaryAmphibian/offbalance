export const ETH_USD_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
export const QUOTE_MAX_AGE_MS = 60_000;

export async function fetchEthUsdQuote({ signal, fetcher = globalThis.fetch, now = Date.now } = {}) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    response = await fetcher(ETH_USD_URL, {
      method: 'GET', credentials: 'omit', cache: 'no-store', mode: 'cors',
      headers: { Accept: 'application/json' }, signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error(error?.name === 'TimeoutError' || deadline.aborted
      ? 'The ETH/USD price service took too long. Try again.'
      : 'Could not load the ETH/USD rate. Try again.');
  }
  if (!response.ok) throw new Error('The ETH/USD price service is unavailable. Try again.');
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error(error?.name === 'TimeoutError' || deadline.aborted
      ? 'The ETH/USD price service took too long. Try again.'
      : 'The price service returned invalid ETH/USD pricing.');
  }
  signal?.throwIfAborted();
  const price = data?.data?.amount;
  if (data?.data?.base !== 'ETH' || data?.data?.currency !== 'USD' || typeof price !== 'string' || price.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(price) || !/[1-9]/.test(price)) {
    throw new Error('The price service returned invalid ETH/USD pricing.');
  }
  const fetchedAt = now();
  if (!Number.isFinite(fetchedAt)) throw new Error('Could not record the ETH/USD quote time.');
  return { usdPerEth: price, fetchedAt };
}
