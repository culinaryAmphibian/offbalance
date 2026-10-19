import { useCallback, useEffect, useRef, useState } from 'react';
import { dateLabel, jobPhase, statusLabel, timeLabel, windowMinutes, resultUrl } from '../jobs';
import { useResource } from '../useResource';
import { submitStoredJob } from '../chain';

export function Status({ value }) {
  return <span className={`status ${jobPhase(value)[0]}`}>{statusLabel(value)}</span>;
}

export function ResourceError({ message, retry }) {
  return <div className="notice error" role="alert"><span>{message}</span><button className="text-button" onClick={retry}>Try again</button></div>;
}

export default function JobDetail({ api, id, notice }) {
  const load = useCallback(signal => api.getJob(id, signal), [api, id]);
  const { data, error, loading, refresh } = useResource(load, 5000);
  const [results, setResults] = useState(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [resultError, setResultError] = useState('');
  const [chainPending, setChainPending] = useState(false);
  const [chainError, setChainError] = useState('');
  const [transaction, setTransaction] = useState('');
  const resultController = useRef(null);
  const chainSubmitting = useRef(false);
  const chainController = useRef(null);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; resultController.current?.abort(); chainController.current?.abort(); }; }, []);
  const job = data?.job;
  const needsChain = job?.executionMode === 'chain' && !job.submittedAt && job.status === 'PENDING';

  async function loadResults() {
    resultController.current?.abort();
    const controller = new AbortController();
    resultController.current = controller;
    setLoadingResults(true);
    setResultError('');
    try {
      const result = await api.getResult(id, controller.signal);
      if (controller.signal.aborted) return;
      if (!Array.isArray(result?.results)) throw new Error('The server did not return delivery records.');
      setResults(result.results);
    } catch (problem) {
      if (!controller.signal.aborted) setResultError(problem.status === 403 ? 'Delivery records are available to the job owner.' : problem.message);
    } finally {
      if (!controller.signal.aborted) setLoadingResults(false);
    }
  }

  async function submitChain() {
    if (chainSubmitting.current || transaction) return;
    chainSubmitting.current = true;
    const controller = new AbortController();
    chainController.current = controller;
    setChainPending(true);
    setChainError('');
    try {
      const config = await api.getConfig();
      if (!active.current || controller.signal.aborted) return;
      const { hash } = await submitStoredJob(job, config, window.ethereum, { signal: controller.signal });
      if (!active.current) return;
      setTransaction(hash);
      refresh();
    } catch (problem) {
      if (active.current) setChainError(problem.message || 'Blockchain submission failed.');
    } finally {
      chainSubmitting.current = false;
      if (active.current) setChainPending(false);
    }
  }

  return <>
    <a className="back-link" href="#/">← Overview</a>
    <div className="page-heading"><h1>{job?.name || 'Job details'}</h1>{job && <Status value={job.status} />}</div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {job?.executionMode === 'local' && <p className="notice">Database-backed coordinator mode. Blockchain submission, escrow, and settlement are disabled.</p>}
    {needsChain && <section className="panel" aria-label="Blockchain submission">
      <p>This job is saved in the database. It needs a blockchain submission before providers can be assigned.</p>
      {job.canSubmit !== false && <button className="button primary" onClick={submitChain} disabled={chainPending || !!transaction}>{chainPending ? 'Check your wallet…' : transaction ? 'Transaction sent' : 'Submit to blockchain'}</button>}
      {transaction && <p className="notice" role="status">Transaction sent: <span className="mono">{transaction}</span>. Waiting for the coordinator to observe the submission. Keep this page open while it is pending.</p>}
      {chainError && <p className="notice error" role="alert">{chainError}</p>}
    </section>}
    {error && <ResourceError message={error} retry={refresh} />}
    {loading && !job && <p className="muted" role="status">Loading job…</p>}
    {data && !job && !error && <p className="notice error" role="alert">The server did not return a job.</p>}
    {job && <>
      <p className="phase-note muted" role="status">{needsChain ? 'Saved; waiting for blockchain submission.' : jobPhase(job.status)[1]}</p>
      <section className="panel" aria-labelledby="details-heading">
        <div className="section-heading"><h2 id="details-heading">Details</h2><button className="text-button" onClick={refresh} disabled={loading}>Refresh</button></div>
        <dl className="detail-grid">
          <Item label="Job ID" mono>{job.id}</Item><Item label="Saved">{dateLabel(job.createdAt)}</Item>
          <Item label="Container image" mono>{job.dockerImage || '—'}</Item><Item label="Hourly cap per provider">{job.maxPrice ?? '—'} ETH / hour</Item>
          <Item label="Providers assigned">{job.providerCount ?? '—'} / {job.k ?? '—'}</Item><Item label="Matching results">{job.consensus?.agreeing ?? '—'} / {job.consensus?.required ?? job.quorum ?? '—'}</Item>
          <Item label="Runtime">{job.runtimeSeconds == null ? '—' : `${job.runtimeSeconds} seconds`}</Item><Item label="Execution window">{job.window == null ? '—' : `${windowMinutes(job.window)} ${job.window === 60 ? 'minute' : 'minutes'}`}</Item>
          <Item label="Minimum scores">CPU {job.requirements?.minCpuScore ?? '—'} · GPU {job.requirements?.minGpuScore ?? '—'} · Memory {job.requirements?.minMemoryScore ?? '—'}</Item>
          <Item label="Amount spent">{job.spent == null ? '—' : `${job.spent} ETH`}</Item>
          {job.onChainJobId != null && <Item label="On-chain job ID" mono>{job.onChainJobId}</Item>}
        </dl>
        {job.error && <p className="notice error" role="alert">{job.error}</p>}
      </section>
      <section className="panel" aria-labelledby="result-heading">
        <div className="section-heading"><h2 id="result-heading">Result</h2></div>
        <dl className="detail-grid result-metadata">
          <Item label="Delivery">{job.delivery?.status ? statusLabel(job.delivery.status) : 'Not reported'}</Item>
          <Item label="Payment">{job.payment?.status ? statusLabel(job.payment.status) : 'Not reported'}</Item>
          {job.delivery?.receivedAt && <Item label="Output received">{timeLabel(job.delivery.receivedAt)}</Item>}
          {job.delivery?.verifiedAt && <Item label="Receipt verified">{timeLabel(job.delivery.verifiedAt)}</Item>}
          {job.payment?.settledAt && <Item label="Payment settled">{timeLabel(job.payment.settledAt)}</Item>}
          {job.result?.retainedUntil && <Item label="Available until">{timeLabel(job.result.retainedUntil)}</Item>}
        </dl>
        {job.delivery?.error && <p className="notice error" role="alert">{job.delivery.error}</p>}
        {job.payment?.error && <p className="notice error" role="alert">{job.payment.error}</p>}
        {(job.resultHash || job.consensusResultHash) && <p className="result-hash mono"><span className="muted">Reported result hash </span>{job.resultHash || job.consensusResultHash}</p>}
        {job.canViewResults !== false ? <>
          <p className="muted">Delivery records are provider-reported output locations. Receipt verification and payment are separate.</p>
          <button className="button primary" onClick={loadResults} disabled={loadingResults}>{loadingResults ? 'Loading records…' : results ? 'Refresh delivery records' : 'Load delivery records'}</button>
          {results?.length === 0 && <p className="muted">No delivery records have been reported.</p>}
          {results?.map((result, index) => <div className="result-record" key={`${result.provider}-${index}`}>
            <dl className="detail-grid">
              <Item label="Provider" mono>{result.provider}</Item>
              <Item label="Reported hash" mono>{result.hash}</Item>
              <Item label="Delivered">{timeLabel(result.deliveryTime)}</Item>
              <Item label="Receipt">{result.receiptVerified ? 'Verified on chain' : 'Not verified'}</Item>
              <Item label="Output location" mono>{result.location || 'Not reported'}</Item>
            </dl>
            {resultUrl(result.location) && <a className="text-link" href={resultUrl(result.location)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open provider output{result.receiptVerified ? '' : ' (unverified receipt)'}</a>}
          </div>)}
        </> : <p className="muted">Delivery records are available to the job owner.</p>}
        {resultError && <p className="notice error" role="alert">{resultError}</p>}
      </section>
      <p className="muted refresh-note">Updates every 5 seconds.</p>
    </>}
  </>;
}

function Item({ label, mono, children }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{children}</dd></div>;
}
