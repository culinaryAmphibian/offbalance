import { useCallback, useEffect, useRef, useState } from 'react';
import { dateLabel, jobPhase, statusLabel, timeLabel } from '../jobs';
import { useResource } from '../useResource';

export function Status({ value }) {
  return <span className={`status ${jobPhase(value)[0]}`}>{statusLabel(value)}</span>;
}

export function ResourceError({ message, retry }) {
  return <div className="notice error" role="alert"><span>{message}</span><button className="text-button" onClick={retry}>Try again</button></div>;
}

export default function JobDetail({ api, id, notice }) {
  const load = useCallback(signal => api.getJob(id, signal), [api, id]);
  const { data, error, loading, refresh } = useResource(load, 5000);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const downloadController = useRef(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  const job = data?.job;

  async function download() {
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await api.getResult(id, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (job.result?.filename || `offbalance-${id}.bin`).replace(/[\\/\x00-\x1f]/g, '_');
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (!controller.signal.aborted) setDownloadError(problem.message);
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return <>
    <a className="back-link" href="#/">← Overview</a>
    <div className="page-heading"><h1>{job?.name || 'Job details'}</h1>{job && <Status value={job.status} />}</div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {job?.executionMode === 'local' && <p className="notice">Local execution. On-chain escrow and settlement are not configured.</p>}
    {error && <ResourceError message={error} retry={refresh} />}
    {loading && !job && <p className="muted" role="status">Loading job…</p>}
    {data && !job && !error && <p className="notice error" role="alert">The server did not return a job.</p>}
    {job && <>
      <p className="phase-note muted" role="status">{jobPhase(job.status)[1]}</p>
      <section className="panel" aria-labelledby="details-heading">
        <div className="section-heading"><h2 id="details-heading">Details</h2><button className="text-button" onClick={refresh} disabled={loading}>Refresh</button></div>
        <dl className="detail-grid">
          <Item label="Job ID" mono>{job.id}</Item><Item label="Submitted">{dateLabel(job.createdAt)}</Item>
          <Item label="Container image" mono>{job.dockerImage || '—'}</Item><Item label="Maximum budget">{job.maxPrice ?? '—'} ETH</Item>
          <Item label="Providers assigned">{job.providerCount ?? '—'} / {job.k ?? '—'}</Item><Item label="Matching results">{job.consensus?.agreeing ?? '—'} / {job.consensus?.required ?? job.quorum ?? '—'}</Item>
          <Item label="Runtime">{job.runtimeSeconds == null ? '—' : `${job.runtimeSeconds} seconds`}</Item><Item label="Execution window">{job.window == null ? '—' : `${job.window} seconds`}</Item>
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
        {job.result?.available ? <>
          {(job.resultHash || job.consensusResultHash) && <p className="result-hash mono"><span className="muted">Result hash </span>{job.resultHash || job.consensusResultHash}</p>}
          <button className="button primary" onClick={download} disabled={downloading}>{downloading ? 'Downloading…' : 'Download result'}</button>
        </> : <p className="muted">{['FAILED', 'NO_QUORUM', 'CANCELED', 'CANCELLED'].includes(job.status) ? 'No verified result is available.' : 'The result will appear here when it is ready.'}</p>}
        {downloadError && <p className="notice error" role="alert">{downloadError}</p>}
      </section>
      <p className="muted refresh-note">Updates every 5 seconds.</p>
    </>}
  </>;
}

function Item({ label, mono, children }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{children}</dd></div>;
}
