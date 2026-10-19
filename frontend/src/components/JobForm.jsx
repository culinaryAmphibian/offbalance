import { useRef, useState } from 'react';
import { jobPayload, validateJob } from '../jobs';

const initial = { name: '', dockerImage: '', maxPrice: '', k: '3', quorum: '2', window: '3600', minCpuScore: '0', minGpuScore: '0', minMemoryScore: '0' };

export default function JobForm({ api, onCreated }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef(null);
  const formRef = useRef(null);

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    const nextErrors = validateJob(values);
    setErrors(nextErrors);
    setError('');
    if (Object.keys(nextErrors).length) {
      const control = formRef.current.elements.namedItem(Object.keys(nextErrors)[0]);
      const disclosure = control.closest('details');
      if (disclosure) disclosure.open = true;
      control.focus();
      return;
    }
    const payload = jobPayload(values);
    const serialized = JSON.stringify(payload);
    if (request.current?.serialized !== serialized) request.current = { serialized, key: crypto.randomUUID() };
    setPending(true);
    const form = formRef.current;
    try {
      const { job } = await api.createJob(payload, request.current.key);
      if (!job?.id) throw new Error('The server did not return a job ID.');
      if (form.isConnected) onCreated(job.id);
    } catch (problem) {
      if (form.isConnected) setError(problem.message);
    } finally {
      if (form.isConnected) setPending(false);
    }
  }

  function field(name, label, props = {}) {
    return <div className="field" key={name}>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} value={values[name]} onChange={event => { setValues({ ...values, [name]: event.target.value }); setErrors(previous => ({ ...previous, [name]: '' })); }} aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `${name}-error` : undefined} {...props} />
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
        {field('dockerImage', 'Container image', { placeholder: 'ghcr.io/your-team/workload:latest', maxLength: 512, autoCapitalize: 'none', spellCheck: false })}
        <p className="muted image-note">Use the provider client’s output-directory convention so results can be collected.</p>
        <div className="form-grid">
          {field('maxPrice', 'Maximum budget (ETH)', { inputMode: 'decimal', placeholder: '0.01' })}
          {field('window', 'Execution window (seconds)', { inputMode: 'numeric' })}
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
        <p className="muted form-note">The budget is a spending limit. This form does not transfer funds.</p>
      </fieldset>
    </form>
  </>;
}
