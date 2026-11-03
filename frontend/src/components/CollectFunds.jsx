import { useEffect, useRef, useState } from 'react';
import { collectFunds } from '../chain';
import { formatEth } from '../eth';
import { walletError } from '../wallet';

// The contract keeps each provider's earnings plus returned stakes as credits;
// "Collect funds" calls withdraw(), which sends all of them to the connected wallet.
// `chain` comes from useProviderBalances.
export default function CollectFunds({ chain, onCollected }) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);

  if (chain.config && !chain.available) return null; // demo mode: no contract
  const { balances } = chain;
  const mismatch = balances && balances.wallet.toLowerCase() !== balances.account.toLowerCase();
  const empty = !balances || balances.credits === 0n;

  async function collect() {
    if (pending || !chain.config) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const { wei } = await collectFunds(chain.config, window.ethereum);
      if (!active.current) return;
      setNotice(`Collected ${formatEth(wei, 3, { wei: true })} ETH to your wallet.`);
      chain.refresh();
      onCollected?.();
    } catch (problem) {
      if (active.current) setError(walletError(problem));
    } finally {
      if (active.current) setPending(false);
    }
  }

  return (
    <section className="panel collect" aria-labelledby="collect-heading">
      <div className="collect-row">
        <div>
          <h2 id="collect-heading">Available to collect</h2>
          <p className="collect-amount">
            {balances ? formatEth(balances.credits, 3, { wei: true }) : '—'}
            <span className="unit">ETH</span>
          </p>
          <p className="muted form-note">Earnings plus stakes returned from settled jobs. Sent straight to your connected wallet.</p>
        </div>
        <button className="button primary" onClick={collect} disabled={pending || empty || !!mismatch}>
          {pending ? 'Check your wallet…' : 'Collect funds'}
        </button>
      </div>
      {mismatch && (
        <p className="notice" role="status">
          Earnings are paid to {balances.account}, the wallet your provider client's session key acts for. Switch your wallet to it to collect them.
        </p>
      )}
      {(error || chain.error) && <p className="notice error" role="alert">{error || chain.error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </section>
  );
}
