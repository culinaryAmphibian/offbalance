import { useCallback, useEffect, useRef, useState } from 'react';
import { authorizeSessionKey, readSessionKey, revokeSessionKey } from '../sessionKey';
import { walletError } from '../wallet';

const dateLabel = seconds => new Date(seconds * 1000).toLocaleString();
const short = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

// Creates the session key the provider client signs with. The private key is shown once, here,
// and never stored or sent to the server.
export default function SessionKeyPanel({ api, wallet }) {
  const [config, setConfig] = useState(null);
  const [current, setCurrent] = useState(null);
  const [days, setDays] = useState('30');
  const [funding, setFunding] = useState('0.05');
  const [created, setCreated] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      if (!active.current) return;
      setConfig(cfg);
      if (cfg?.executionMode === 'chain') {
        const key = await readSessionKey(cfg, wallet);
        if (active.current) setCurrent(key);
      }
    } catch (problem) {
      if (active.current) setError(problem.message || 'Could not read your session key.');
    }
  }, [api, wallet]);
  useEffect(() => { refresh(); }, [refresh]);

  async function authorize(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(''); setNotice(''); setCreated(null);
    try {
      const result = await authorizeSessionKey({ config, owner: wallet, expiresInDays: days, fundingEth: funding });
      if (!active.current) return;
      setCreated(result);
      await refresh();
    } catch (problem) {
      if (active.current) setError(walletError(problem));
    } finally {
      if (active.current) setPending(false);
    }
  }

  async function revoke() {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try {
      await revokeSessionKey(config, wallet);
      if (!active.current) return;
      setCreated(null);
      setNotice('Session key revoked. The provider client can no longer act for your wallet.');
      await refresh();
    } catch (problem) {
      if (active.current) setError(walletError(problem));
    } finally {
      if (active.current) setPending(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.privateKey);
      if (active.current) setNotice('Session key copied.');
    } catch {
      if (active.current) setNotice('Clipboard access was denied. Select the key and copy it manually.');
    }
  }

  if (config && config.executionMode !== 'chain') return null;
  return <form className="panel" onSubmit={authorize} noValidate aria-labelledby="session-key-heading">
    <div className="section-heading"><h2 id="session-key-heading">Provider client session key</h2></div>
    <p className="muted">
      The provider client signs its stake, commit and reveal transactions with a session key that acts for this wallet.
      Earnings still go to this wallet, and only this wallet can withdraw them.
      Authorizing a new key replaces the old one. The ETH you add pays the key's gas and job stakes.
    </p>
    {current && <p className="muted">
      Current key {short(current.address)} · {current.expired ? 'expired' : 'expires'} {dateLabel(current.expiresAt)}
    </p>}
    <div className="field">
      <label htmlFor="session-days">Expires after (days)</label>
      <input id="session-days" inputMode="numeric" value={days} disabled={pending} onChange={e => setDays(e.target.value)} />
    </div>
    <div className="field">
      <label htmlFor="session-funding">Fund with (ETH)</label>
      <input id="session-funding" inputMode="decimal" value={funding} disabled={pending} onChange={e => setFunding(e.target.value)} />
    </div>
    {created && <div className="field">
      <label htmlFor="session-private-key">Session key (shown once)</label>
      <input id="session-private-key" type="password" readOnly value={created.privateKey} autoComplete="off" />
      <p className="muted">
        Paste this into the provider client when it asks for its session key. It won't be shown again;
        if you lose it, authorize a new one. Address {short(created.address)}, expires {dateLabel(created.expiresAt)}.
      </p>
      <button className="text-button" type="button" onClick={copy}>Copy session key</button>
    </div>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="form-actions">
      <button className="button primary" type="submit" disabled={pending || !config}>
        {pending ? 'Check your wallet…' : current && !current.expired ? 'Authorize a new key' : 'Authorize provider client'}
      </button>
      {current && !current.expired && <button className="text-button" type="button" disabled={pending} onClick={revoke}>Revoke key</button>}
    </div>
  </form>;
}
