import { encodeFunctionData, toHex } from 'viem';
import { validateSavedPricing } from './pricing.js';

// The buyer escrows the price with the job, so the call is payable.
const submitAbi = [{ type: 'function', name: 'submitJob', stateMutability: 'payable',
  inputs: [...['jobId', 'maxHourlyRate', 'k', 'quorum', 'executionTime'].map(name => ({ name, type: 'uint256' })),
    { name: 'dockerImage', type: 'string' }], outputs: [] }];

export async function submitStoredJob(job, config, provider = globalThis.window?.ethereum, { signal } = {}) {
  signal?.throwIfAborted();
  if (!provider?.request) throw new Error('Connect an Ethereum wallet to submit this job.');
  if (config?.executionMode !== 'chain' || !/^0x[\da-f]{40}$/i.test(config.chain?.address ?? '')) {
    throw new Error('The server has no real contract configured for this job.');
  }
  if (job.canSubmit === false || job.submittedAt || job.status !== 'PENDING') throw new Error('This job cannot be submitted to the blockchain.');
  if (!/^0x[\da-f]{40}$/i.test(job.submitWallet ?? '')) throw new Error('The saved job has no authenticated submission wallet. Refresh and sign in again.');
  const chainId = config.chain.chainId;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('The server returned an invalid chain configuration.');
  const count = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (!/^\d+$/.test(String(job.id)) || !count(job.k) || !count(job.quorum) || Number(job.quorum) > Number(job.k) || !count(job.window)) {
    throw new Error('The saved job has invalid blockchain parameters.');
  }
  if (typeof job.dockerImage !== 'string' || !job.dockerImage.trim()) throw new Error('The saved job has no Docker image.');
  // Validate and capture immutable terms before even reading wallet accounts.
  const pricing = validateSavedPricing(job, { forSubmission: true });
  const snapshot = { id: job.id, k: job.k, quorum: job.quorum, window: job.window,
    dockerImage: job.dockerImage, buyerWallet: job.buyerWallet };
  const data = encodeFunctionData({ abi: submitAbi, functionName: 'submitJob',
    args: [BigInt(snapshot.id), BigInt(pricing.maxHourlyRateWei), BigInt(snapshot.k), BigInt(snapshot.quorum), BigInt(snapshot.window), snapshot.dockerImage] });
  const [wallet] = await provider.request({ method: 'eth_accounts' });
  signal?.throwIfAborted();
  if (!/^0x[\da-f]{40}$/i.test(wallet ?? '')) throw new Error('Connect your wallet again.');
  if (wallet.toLowerCase() !== snapshot.buyerWallet.toLowerCase()) throw new Error('Your wallet changed. Sign in again.');
  const actual = await provider.request({ method: 'eth_chainId' });
  signal?.throwIfAborted();
  if (BigInt(actual) !== BigInt(chainId)) throw new Error(`Switch your wallet to chain ${chainId} before submitting.`);
  const [current] = await provider.request({ method: 'eth_accounts' });
  signal?.throwIfAborted();
  const currentChain = await provider.request({ method: 'eth_chainId' });
  signal?.throwIfAborted();
  if (current?.toLowerCase() !== wallet.toLowerCase() || BigInt(currentChain) !== BigInt(chainId)) throw new Error('Your wallet changed. Sign in again.');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: config.chain.address, data, value: toHex(BigInt(pricing.totalEscrowWei)) }] });
  if (!/^0x[\da-f]{64}$/i.test(hash ?? '')) throw new Error('The wallet returned an invalid transaction hash. Check your wallet before retrying.');
  return { hash };
}
