import { useCallback, useEffect, useRef, useState } from 'react';

const ethAmount = value => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value);
const validFunds = funds => funds?.currency === 'ETH' && ethAmount(funds.available) && typeof funds.collectionEnabled === 'boolean';
const validCollection = collection => ['PENDING', 'COLLECTED'].includes(collection?.status) && ethAmount(collection.amount) && /[1-9]/.test(collection.amount);

export default function ProviderFunds({ api, demo, request }) {
  const [funds, setFunds] = useState(null);
  const [collection, setCollection] = useState(request.current?.collection ?? null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(!!request.current?.inFlight);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const reader = useRef(null);

  const refresh = useCallback(async () => {
    if (request.current?.inFlight) return;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setPending(false);
    setLoading(true);
    try {
      const result = await api.getProviderFunds(controller.signal);
      if (controller.signal.aborted) return;
      if (!validFunds(result?.funds) || (result.collection && !validCollection(result.collection))) throw new Error('The server returned invalid collection information.');
      setFunds(result.funds);
      setReadError('');
      if (result.collection) {
        if (request.current?.uncertain) {
          // Pending status blocks retries; confirmation still needs the original key.
          request.current.collection = result.collection.status === 'PENDING' ? result.collection : null;
          setCollection(request.current.collection);
        } else {
          setCollection(result.collection);
          request.current = result.collection.status === 'PENDING' ? { ...request.current, collection: result.collection } : null;
        }
      }
    } catch (problem) {
      if (!controller.signal.aborted) setReadError([404, 501].includes(problem.status) ? 'Fund collection is not configured yet.' : problem.message || 'Could not load available funds.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api, request]);

  useEffect(() => {
    active.current = true;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { active.current = false; reader.current?.abort(); clearInterval(timer); };
  }, [refresh]);

  const awaiting = collection?.status === 'PENDING';
  const retrying = !!request.current?.uncertain;
  const enabled = funds?.collectionEnabled && !awaiting && (retrying || /[1-9]/.test(funds.available));

  async function collect() {
    if (request.current?.inFlight || loading || readError || !enabled) return;
    reader.current?.abort();
    const attempt = request.current ?? { key: crypto.randomUUID() };
    request.current = attempt;
    attempt.inFlight = true;
    setPending(true);
    setError('');
    setCollection(null);
    try {
      const result = await api.collectProviderFunds(attempt.key);
      if (!validFunds(result?.funds) || !validCollection(result?.collection)) throw new Error('The server did not confirm the collection. Retry to check the same request.');
      attempt.uncertain = false;
      attempt.collection = result.collection;
      if (result.collection.status === 'COLLECTED') request.current = null;
      if (active.current) {
        setFunds(result.funds);
        setCollection(result.collection);
      }
    } catch (problem) {
      attempt.uncertain = true;
      if (active.current) setError(problem.message || 'Could not confirm collection. You can retry the same request.');
    } finally {
      attempt.inFlight = false;
      if (active.current) setPending(false);
    }
  }

  return <section className="panel provider-funds" aria-labelledby="funds-heading">
    <div className="section-heading"><h2 id="funds-heading">Available funds</h2><button className="text-button" onClick={refresh} disabled={loading || pending}>Refresh funds</button></div>
    <div className="funds-actions">
      <p className="funds-amount">{funds?.available ?? '—'}<span className="unit">ETH</span></p>
      <button className="button primary" onClick={collect} disabled={loading || pending || !!readError || !enabled}>{pending ? 'Collecting…' : retrying ? 'Retry collection' : 'Collect funds'}</button>
    </div>
    {loading && !funds && <p className="muted" role="status">Loading available funds…</p>}
    {!loading && !readError && funds && !funds.collectionEnabled && <p className="muted">Fund collection is not configured yet.</p>}
    {!loading && !readError && funds?.collectionEnabled && !/[1-9]/.test(funds.available) && !awaiting && !retrying && <p className="muted">No funds available to collect.</p>}
    {readError && <p className="notice error" role="alert">{readError}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {collection && <p className="notice" role="status">{awaiting ? `Collection of ${collection.amount} ETH is pending. Confirmation will appear here.` : `${demo ? 'Demo: ' : ''}${collection.amount} ETH collected.`}</p>}
  </section>;
}
