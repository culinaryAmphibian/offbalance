import { useEffect, useRef, useState } from 'react';
import { jobPayload, validateJob } from '../jobs';
import { convertBudget } from '../budget';
import { fetchEthUsdQuote, QUOTE_MAX_AGE_MS } from '../rates';

const initial = { name: '', dockerImage: '', maxPrice: '', budgetCurrency: 'ETH', k: '3', quorum: '2', window: '60', minCpuScore: '0', minGpuScore: '0', minMemoryScore: '0' };

export default function JobForm({ api, onCreated }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [rate, setRate] = useState({ quote: null, loading: false, error: '' });
  const [rateRevision, setRateRevision] = useState(0);
  const [, updateClock] = useState(0);
  const request = useRef(null);
  const submitting = useRef(false);
  const formRef = useRef(null);
  const input = JSON.stringify(values);
  const retry = request.current?.input === input ? request.current : null;
  const quote = retry?.quote ?? rate.quote;
  const usd = values.budgetCurrency === 'USD';
  const quoteLocked = usd && Boolean(retry);
  const quoteFresh = quote && Date.now() >= quote.fetchedAt && Date.now() - quote.fetchedAt < QUOTE_MAX_AGE_MS;
  let converted = null;
  if (usd && quote) { try { converted = convertBudget(values.maxPrice, 'USD', quote.usdPerEth); } catch {} }

  useEffect(() => {
    if (!usd) return;
    const controller = new AbortController();
    setRate({ quote: null, loading: true, error: '' });
    fetchEthUsdQuote({ signal: controller.signal }).then(quote => {
      if (!controller.signal.aborted) setRate({ quote, loading: false, error: '' });
    }).catch(problem => {
      if (!controller.signal.aborted) setRate({ quote: null, loading: false, error: problem.message });
    });
    return () => controller.abort();
  }, [usd, rateRevision]);

  useEffect(() => {
    if (!quote || quoteLocked) return;
    const timer = setTimeout(() => updateClock(value => value + 1), Math.max(0, quote.fetchedAt + QUOTE_MAX_AGE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, quoteLocked]);

  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    const nextErrors = validateJob(values, quote?.usdPerEth);
    const freshAtSubmission = quote && Date.now() >= quote.fetchedAt && Date.now() - quote.fetchedAt < QUOTE_MAX_AGE_MS;
    if (usd && !retry && !freshAtSubmission) nextErrors.maxPrice = rate.loading ? 'Loading the ETH/USD rate…' : 'Refresh the ETH/USD rate to continue.';
    setErrors(nextErrors);
    setError('');
    if (Object.keys(nextErrors).length) {
      const control = formRef.current.elements.namedItem(Object.keys(nextErrors)[0]);
      const disclosure = control.closest('details');
      if (disclosure) disclosure.open = true;
      control.focus();
      return;
    }
    // Preserve the exact ETH limit and key after an uncertain response, even if the rate expires.
    if (!retry) request.current = { input, payload: jobPayload(values, quote?.usdPerEth), quote: usd ? quote : null, key: crypto.randomUUID() };
    submitting.current = true;
    setPending(true);
    const form = formRef.current;
    try {
      const { job } = await api.createJob(request.current.payload, request.current.key);
      if (!job?.id) throw new Error('The server did not return a job ID.');
      if (form.isConnected) onCreated(job.id);
    } catch (problem) {
      if (form.isConnected) setError(problem.message);
    } finally {
      submitting.current = false;
      if (form.isConnected) setPending(false);
    }
  }

  function change(name, value) {
    setValues(previous => ({ ...previous, [name]: value }));
    setErrors(previous => ({ ...previous, [name === 'budgetCurrency' ? 'maxPrice' : name]: '' }));
  }

  function field(name, label, props = {}) {
    return <div className="field" key={name}>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} value={values[name]} onChange={event => change(name, event.target.value)} aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `${name}-error` : undefined} {...props} />
      {errors[name] && <span className="field-error" id={`${name}-error`}>{errors[name]}</span>}
    </div>;
  }

  return <>
    <a className="back-link" href="#/">← Overview</a>
    <div className="page-heading"><h1>Submit job</h1></div>
    <form className="panel job-form" ref={formRef} onSubmit={submit} noValidate>
      <p className="muted form-intro">Submit a container workload. Providers are assigned automatically.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <fieldset disabled={pending}>
        {field('name', 'Job name', { autoFocus: true, maxLength: 120, autoComplete: 'off' })}
        {field('dockerImage', 'Container image', { maxLength: 512, autoCapitalize: 'none', spellCheck: false })}
        <p className="muted image-note">Use the provider client’s output-directory convention so results can be collected.</p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="maxPrice">Maximum budget ({values.budgetCurrency})</label>
            <div className="budget-input">
              <input id="maxPrice" name="maxPrice" inputMode="decimal" value={values.maxPrice} onChange={event => change('maxPrice', event.target.value)} aria-invalid={!!errors.maxPrice} aria-describedby={[errors.maxPrice && 'maxPrice-error', usd && 'budget-conversion'].filter(Boolean).join(' ') || undefined} />
              <select aria-label="Budget currency" name="budgetCurrency" value={values.budgetCurrency} onChange={event => change('budgetCurrency', event.target.value)}>
                <option value="ETH">ETH</option><option value="USD">USD</option>
              </select>
            </div>
            {errors.maxPrice && <span className="field-error" id="maxPrice-error">{errors.maxPrice}</span>}
            {usd && <div className="budget-conversion" id="budget-conversion" aria-live="polite">
              {rate.loading && !quoteLocked ? <span>Loading ETH/USD rate…</span> : rate.error && !quoteLocked ? <span className="field-error">{rate.error}</span> : quote && <span>{converted ? `≈ ${converted} ETH · ` : ''}1 ETH = {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(quote.usdPerEth))}{!quoteFresh && !quoteLocked ? ' · Rate expired' : ''}</span>}
              {!quoteLocked && <button className="text-button" type="button" disabled={rate.loading} onClick={() => { setErrors(previous => ({ ...previous, maxPrice: '' })); setRateRevision(value => value + 1); }}>Refresh rate</button>}
              {quoteLocked && <span>Conversion kept for retry.</span>}
            </div>}
          </div>
          {field('window', 'Execution window (minutes)', { inputMode: 'numeric' })}
          {field('k', 'Provider count', { inputMode: 'numeric' })}
          {field('quorum', 'Required matching results', { inputMode: 'numeric' })}
        </div>
        <details className="hardware-fields"><summary>Minimum hardware scores</summary>
          <div className="form-grid">
            {field('minCpuScore', 'CPU score', { inputMode: 'numeric' })}
            {field('minGpuScore', 'GPU score', { inputMode: 'numeric' })}
            {field('minMemoryScore', 'Memory score', { inputMode: 'numeric' })}
          </div>
          <p className="muted">Leave at zero for no minimum.</p>
        </details>
        <div className="form-actions"><button className="button primary" type="submit">{pending ? 'Submitting…' : 'Submit job'}</button><a className="text-link" href="#/">Cancel</a></div>
        <p className="muted form-note">The budget is a spending limit{usd ? ', converted to ETH at the quoted rate' : ''}. This form does not transfer funds.</p>
      </fieldset>
    </form>
  </>;
}
