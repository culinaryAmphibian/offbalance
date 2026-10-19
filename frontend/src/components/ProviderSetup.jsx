import { useCallback, useEffect, useRef, useState } from 'react';
import { timeLabel } from '../jobs';
import { useResource } from '../useResource';
import { ResourceError } from './JobDetail';

const publicUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

export default function ProviderSetup({ api }) {
  const loadProvider = useCallback(signal => api.getProvider(signal), [api]);
  const loadTutorial = useCallback(signal => api.getProviderTutorial(signal), [api]);
  const providerResource = useResource(loadProvider);
  const tutorialResource = useResource(loadTutorial);
  const provider = providerResource.data?.provider;
  const tutorial = tutorialResource.data?.tutorial;
  const machine = provider?.machine;
  const [price, setPrice] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = useRef(false);
  const saving = useRef(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!dirty.current && !saving.current) setPrice(provider?.pricePerHour ?? '');
  }, [provider]);

  async function save(event) {
    event.preventDefault();
    if (saving.current || !machine || !provider?.registered) return;
    setNotice('');
    const value = price.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value) || !/[1-9]/.test(value)) {
      setError('Enter a positive ETH amount with up to 18 decimal places.');
      return;
    }
    saving.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api.saveProviderPricing({ pricePerHour: value });
      if (!active.current) return;
      if (!result?.provider) throw new Error('The server did not return the updated provider.');
      dirty.current = false;
      setPrice(result.provider.pricePerHour ?? value);
      setNotice('Hourly price saved.');
      providerResource.refresh();
    } catch (problem) {
      if (active.current) setError(problem.message || 'Could not save your hourly price.');
    } finally {
      saving.current = false;
      if (active.current) setPending(false);
    }
  }

  const downloadUrl = publicUrl(tutorial?.downloadUrl);
  const sourceUrl = publicUrl(tutorial?.sourceUrl);
  return <>
    <a className="back-link" href="#/">← Overview</a>
    <div className="page-heading"><h1>Provider setup</h1><button className="text-button" disabled={pending || providerResource.loading} onClick={providerResource.refresh}>Refresh status</button></div>
    {providerResource.error && <ResourceError message={providerResource.error} retry={providerResource.refresh} />}
    {providerResource.loading && !provider && <p className="muted" role="status">Loading provider…</p>}
    {providerResource.data && !provider && !providerResource.error && <p className="notice error" role="alert">The server did not return provider information.</p>}
    {provider && <section className="panel" aria-labelledby="machine-heading">
      <div className="section-heading"><h2 id="machine-heading">Your machine</h2><span className="muted">{!provider.registered ? 'Not registered' : provider.online ? 'Online' : 'Offline'}</span></div>
      <dl className="detail-grid">
        <div><dt>Last seen</dt><dd>{timeLabel(provider.lastSeen)}</dd></div>
        <div><dt>Current stake</dt><dd>{provider.currentStake == null ? '—' : `${provider.currentStake} ETH`}</dd></div>
        {machine && <>
          <div><dt>Hardware scores</dt><dd>CPU {machine.cpuScore ?? '—'} · GPU {machine.gpuScore ?? '—'} · Memory {machine.memoryScore ?? '—'}</dd></div>
          <div><dt>Scores reported</dt><dd>{timeLabel(machine.updatedAt)}</dd></div>
        </>}
      </dl>
      {!provider.registered && <p className="muted">Connect the provider client to register this machine.</p>}
      {!machine && <p className="muted">Waiting for hardware scores from the provider client.</p>}
      <p className="muted">The client reports hardware scores and availability. Jobs are assigned automatically.</p>
    </section>}
    <div className="form-grid">
      <section className="panel" aria-labelledby="client-heading">
        <div className="section-heading"><h2 id="client-heading">{tutorial?.title || 'Client setup'}</h2></div>
        {tutorialResource.error && <ResourceError message={tutorialResource.error} retry={tutorialResource.refresh} />}
        {tutorialResource.loading && !tutorial && <p className="muted" role="status">Loading setup instructions…</p>}
        {Array.isArray(tutorial?.steps) && tutorial.steps.length > 0 && <ol>{tutorial.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
        {!tutorialResource.loading && !tutorialResource.error && !downloadUrl && <p className="muted">A client download is not available yet.</p>}
        <div className="form-actions">
          {downloadUrl && <a className="button primary" href={downloadUrl} target="_blank" rel="noopener noreferrer">Download client</a>}
          {sourceUrl && <a className="text-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Client source</a>}
        </div>
      </section>
      <form className="panel" onSubmit={save} noValidate aria-labelledby="pricing-heading">
        <div className="section-heading"><h2 id="pricing-heading">Hourly price</h2></div>
        <p className="muted">Set the hourly rate for your machine.</p>
        {provider?.suggestedPricePerHour != null && <p className="muted">Suggested: {provider.suggestedPricePerHour} ETH / hour</p>}
        <div className="field">
          <label htmlFor="provider-price">Price (ETH / hour)</label>
          <input id="provider-price" name="pricePerHour" inputMode="decimal" value={price} disabled={pending || !machine || !provider?.registered} aria-invalid={!!error} aria-describedby={error ? 'provider-price-error' : undefined} onChange={event => { dirty.current = true; setPrice(event.target.value); setError(''); setNotice(''); }} />
        </div>
        {error && <p id="provider-price-error" className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="form-actions"><button className="button primary" type="submit" disabled={pending || !machine || !provider?.registered}>{pending ? 'Saving…' : 'Save price'}</button></div>
      </form>
    </div>
  </>;
}
