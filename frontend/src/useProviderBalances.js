import { useCallback, useEffect, useRef, useState } from 'react';
import { readProviderBalances } from './chain';
import { walletError } from './wallet';

// job statuses whose stakes are already returned or slashed
const SETTLED = new Set(['PAYOUT', 'COMPLETED', 'CANCELED', 'CANCELLED', 'NO_QUORUM', 'FAILED']);

// Polls the contract for a provider's collectable credits and locked stake.
// `account` is the address the provider client earns with; it falls back to the connected wallet.
// `config` is null until loaded; in demo mode (no contract) `available` is false.
export function useProviderBalances(api, account, { enabled = true, interval = 10000 } = {}) {
  const [config, setConfig] = useState(null);
  const [balances, setBalances] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const configRef = useRef(null);

  // only consulted when the deployed contract has no lockedStake view
  const unsettledJobIds = useCallback(async signal => {
    const { jobs } = await api.listJobs('provider', signal);
    return (Array.isArray(jobs) ? jobs : []).filter(job => !SETTLED.has(job.status)).map(job => job.id);
  }, [api]);

  const load = useCallback(async signal => {
    const cfg = configRef.current ?? await api.getConfig(signal);
    configRef.current = cfg;
    setConfig(cfg);
    if (cfg?.executionMode !== 'chain') return;
    const value = await readProviderBalances(cfg, window.ethereum, { account, signal, jobIds: unsettledJobIds });
    setBalances(value);
    setError('');
  }, [api, account, unsettledJobIds]);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer;
    async function update() {
      try { await load(controller.signal); }
      catch (problem) { if (!controller.signal.aborted) setError(walletError(problem)); }
      finally { if (!controller.signal.aborted && interval) timer = setTimeout(update, interval); }
    }
    update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load, enabled, interval, revision]);

  return {
    config,
    available: config?.executionMode === 'chain',
    balances,
    error,
    refresh: () => setRevision(value => value + 1),
  };
}
