import { useCallback, useEffect, useRef, useState } from 'react';
import { timeLabel } from '../jobs';
import { describeReputation, formatEth } from '../eth';
import { useProviderBalances } from '../useProviderBalances';
import { useResource } from '../useResource';
import { ResourceError } from './JobDetail';

const publicUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

const amount = (value, digits) => Number.isFinite(Number(value)) && value !== null
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';

// a measurement as a multiple of the server's reference machine
function Relative({ value }) {
  return Number.isFinite(value) ? <span className="relative">({amount(value, 2)}× reference)</span> : null;
}

// From the contract: agreeing with the consensus earns trust, failures cost it, and trust sets the
// stake the provider posts with each commitment. The full discount only applies to jobs priced at
// or below the value the provider has already delivered.
function Reputation({ value }) {
  const described = describeReputation(value);
  if (!described) return '—';
  return <>
    {described.trust} trust<br />
    Stakes {described.multiplier} the base stake
    {value.multiplierBps < 10_000n && value.earned > 0n && <><br /><span className="muted">on jobs up to {formatEth(value.earned, 3, { wei: true })} ETH; less discount above that</span></>}
  </>;
}

export default function ProviderSetup({ api, clientKey }) {
  const loadProvider = useCallback(signal => api.getProvider(signal), [api]);
  const loadTutorial = useCallback(signal => api.getProviderTutorial(signal), [api]);
  const providerResource = useResource(loadProvider);
  const tutorialResource = useResource(loadTutorial);
  const provider = providerResource.data?.provider;
  const tutorial = tutorialResource.data?.tutorial;
  const machine = provider?.machine;
  const relative = machine?.relative;
  const chain = useProviderBalances(api, machine?.address);
  const suggestion = provider?.suggestedPrice;
  const [price, setPrice] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [keyNotice, setKeyNotice] = useState('');
  const dirty = useRef(false);
  const saving = useRef(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!dirty.current && !saving.current) setPrice(provider?.pricePerHour ?? '');
  }, [provider]);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(clientKey);
      if (active.current) setKeyNotice('Client API key copied.');
    } catch {
      if (active.current) setKeyNotice('Clipboard access was denied. Allow clipboard access and try again.');
    }
  }

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
        <div><dt>Current stake</dt><dd>{chain.available
          ? (chain.balances?.stake != null ? `${formatEth(chain.balances.stake, 3, { wei: true })} ETH` : '—')
          : provider.currentStake == null ? '—' : `${formatEth(provider.currentStake)} ETH`}</dd></div>
        {chain.available && <div><dt>Reputation</dt><dd><Reputation value={chain.balances?.reputation} /></dd></div>}
        {machine?.cpu && <>
          <div><dt>CPU</dt><dd>
            {machine.cpu.model}<br />
            {machine.cpu.cores} cores · {machine.cpu.threads} vCPUs<br />
            {amount(machine.cpu.singleThreadMBps, 0)} MB/s per thread <Relative value={relative?.cpuSingleThread} /><br />
            {amount(machine.cpu.multiThreadMBps, 0)} MB/s all threads <Relative value={relative?.cpuMultiThread} />
          </dd></div>
          <div><dt>Memory</dt><dd>
            {amount(machine.memory.totalGb, 1)} GB usable<br />
            {amount(machine.memory.bandwidthGBps, 1)} GB/s bandwidth <Relative value={relative?.memoryBandwidth} />
          </dd></div>
          <div><dt>GPUs</dt><dd>
            {machine.gpus?.length ? <ul className="spec-list">{machine.gpus.map((gpu, position) => <li key={`${gpu.vendor}-${gpu.index}`}>
              {gpu.model}, {amount(gpu.vramGb, 1)} GB{gpu.runtime ? ` · ${gpu.runtime}` : ''}<br />
              {gpu.error
                ? <span className="field-error">Not offered for jobs: {gpu.error}</span>
                : <>{amount(gpu.fp32Tflops, 1)} FP32 TFLOPS <Relative value={relative?.gpus?.[position]} /> · {amount(gpu.memoryBandwidthGBps, 0)} GB/s</>}
            </li>)}</ul> : 'None detected'}
          </dd></div>
          <div><dt>Benchmarked</dt><dd>{timeLabel(machine.updatedAt)}</dd></div>
        </>}
      </dl>
      {!provider.registered && <p className="muted">Connect the provider client to register this machine.</p>}
      {!machine && <p className="muted">Waiting for the provider client's hardware benchmark.</p>}
      {machine && !machine.cpu && <p className="notice error" role="alert">This machine was benchmarked by an older provider client. Update the client and restart it.</p>}
      {relative?.reference && <p className="muted">1.0× is the reference machine: {relative.reference}. CPU speed is zlib compression throughput; memory and GPU bandwidth count bytes read and written.</p>}
      <p className="muted">Online status requires recent coordinator heartbeats; benchmark uploads alone do not keep a provider online.</p>
    </section>}
    <div className="form-grid">
      <section className="panel" aria-labelledby="client-heading">
        <div className="section-heading"><h2 id="client-heading">{tutorial?.title || 'Client setup'}</h2></div>
        {tutorialResource.error && <ResourceError message={tutorialResource.error} retry={tutorialResource.refresh} />}
        {tutorialResource.loading && !tutorial && <p className="muted" role="status">Loading setup instructions…</p>}
        {clientKey && <div className="field">
          <label htmlFor="client-api-key">Client API key</label>
          <input id="client-api-key" type="password" readOnly value={clientKey} autoComplete="off" />
          <p className="muted">Use this key when your provider client asks for its API key. Signing out revokes it.</p>
          <button className="text-button" type="button" onClick={copyKey}>Copy client API key</button>
          {keyNotice && <p role="status">{keyNotice}</p>}
        </div>}
        {Array.isArray(tutorial?.steps) && tutorial.steps.length > 0 && <ol>{tutorial.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
        {!tutorialResource.loading && !tutorialResource.error && !downloadUrl && <p className="muted">A client download is not available yet.</p>}
        <div className="form-actions">
          {downloadUrl && <a className="button primary" href={downloadUrl} target="_blank" rel="noopener noreferrer">Download client</a>}
          {sourceUrl && <a className="text-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Client source</a>}
        </div>
      </section>
      <form className="panel" onSubmit={save} noValidate aria-labelledby="pricing-heading">
        <div className="section-heading"><h2 id="pricing-heading">Hourly price</h2></div>
        <p className="muted">Set the hourly rate for your machine. Buyers' jobs are matched to the cheapest machines that have the resources they ask for.</p>
        {suggestion?.formula && <div className="price-suggestion">
          <p>Suggested from your hardware: <strong>{suggestion.formula.pricePerHour} ETH / hour</strong></p>
          <ul className="price-breakdown" aria-label="Suggested price breakdown">
            {suggestion.formula.items.map(item => <li key={item.label}>
              <span>{item.label}<span className="muted">{item.detail}</span></span>
              <span>{item.pricePerHour} ETH</span>
            </li>)}
          </ul>
          <p className="muted">{suggestion.market
            ? `Similar machines charge a median ${suggestion.market.pricePerHour} ETH / hour (${suggestion.market.similarMachines} ${suggestion.market.similarMachines === 1 ? 'machine' : 'machines'}).`
            : 'No similar machines have set a price yet.'}</p>
          <button className="text-button" type="button" disabled={pending || !machine || !provider?.registered}
            onClick={() => { dirty.current = true; setPrice(suggestion.formula.pricePerHour); setError(''); setNotice(''); }}>Use suggested price</button>
        </div>}
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
