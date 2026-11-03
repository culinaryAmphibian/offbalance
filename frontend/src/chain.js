import { decodeFunctionResult, encodeFunctionData, parseEther, toHex } from 'viem';

// submitJob(price, k, quorum, executionTime, dockerName) in OffBalance.sol.
// The contract assigns the job id itself. The buyer escrows the price, so the call is payable.
const submitAbi = [{ type: 'function', name: 'submitJob', stateMutability: 'payable',
  inputs: [...['price', 'k', 'quorum', 'executionTime'].map(name => ({ name, type: 'uint256' })),
    { name: 'dockerName', type: 'string' }], outputs: [{ type: 'bool' }] }];

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
  const [wallet] = await provider.request({ method: 'eth_accounts' });
  signal?.throwIfAborted();
  if (!/^0x[\da-f]{40}$/i.test(wallet ?? '')) throw new Error('Connect your wallet again.');
  if (wallet.toLowerCase() !== job.submitWallet.toLowerCase()) throw new Error('Your wallet changed. Sign in again.');
  const actual = await provider.request({ method: 'eth_chainId' });
  signal?.throwIfAborted();
  if (BigInt(actual) !== BigInt(chainId)) throw new Error(`Switch your wallet to chain ${chainId} before submitting.`);
  const price = parseEther(String(job.maxPrice));
  // The names are swapped on chain: the contract's `quorum` is how many providers get
  // assigned (our job.k), and its `k` is how many matching results settle the job (our job.quorum).
  const data = encodeFunctionData({ abi: submitAbi, functionName: 'submitJob',
    args: [price, BigInt(job.quorum), BigInt(job.k), BigInt(job.window), job.dockerImage] });
  const [current] = await provider.request({ method: 'eth_accounts' });
  signal?.throwIfAborted();
  const currentChain = await provider.request({ method: 'eth_chainId' });
  signal?.throwIfAborted();
  if (current?.toLowerCase() !== wallet.toLowerCase() || BigInt(currentChain) !== BigInt(chainId)) throw new Error('Your wallet changed. Sign in again.');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: config.chain.address, data, value: toHex(price) }] });
  if (!/^0x[\da-f]{64}$/i.test(hash ?? '')) throw new Error('The wallet returned an invalid transaction hash. Check your wallet before retrying.');
  return { hash };
}

// Providers' earnings and returned stakes accrue as credits in the contract (pull payment);
// withdraw() sends the caller's whole balance to the caller's wallet.
const creditsAbi = [
  { type: 'function', name: 'credits', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'lockedStake', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getProviderCommitment', stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }, { name: 'provider', type: 'address' }],
    outputs: [{ name: 'commitmentHash', type: 'bytes32' }, { name: 'outputHash', type: 'bytes32' }, { name: 'revealed', type: 'bool' },
      { name: 'winning', type: 'bool' }, { name: 'delivered', type: 'bool' }, { name: 'stake', type: 'uint256' }] },
];

// Stake the provider still has in each job; settlement sets it to 0 (paid back or slashed).
async function stakeAcrossJobs(provider, to, account, jobIds) {
  const stakes = await Promise.all(jobIds.map(async id => {
    const data = encodeFunctionData({ abi: creditsAbi, functionName: 'getProviderCommitment', args: [BigInt(id), account] });
    const result = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
    return decodeFunctionResult({ abi: creditsAbi, functionName: 'getProviderCommitment', data: result })[5];
  }));
  return stakes.reduce((sum, value) => sum + value, 0n);
}

async function readUint(provider, to, functionName, account) {
  const data = encodeFunctionData({ abi: creditsAbi, functionName, args: [account] });
  const result = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  return decodeFunctionResult({ abi: creditsAbi, functionName, data: result });
}

function chainTarget(config) {
  if (config?.executionMode !== 'chain' || !/^0x[\da-f]{40}$/i.test(config.chain?.address ?? '')) {
    throw new Error('The server has no real contract configured.');
  }
  const chainId = config.chain.chainId;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('The server returned an invalid chain configuration.');
  return { address: config.chain.address, chainId };
}

async function connectedWallet(provider, chainId, signal) {
  if (!provider?.request) throw new Error('Connect an Ethereum wallet first.');
  const [wallet] = await provider.request({ method: 'eth_accounts' });
  signal?.throwIfAborted();
  if (!/^0x[\da-f]{40}$/i.test(wallet ?? '')) throw new Error('Connect your wallet again.');
  const actual = await provider.request({ method: 'eth_chainId' });
  signal?.throwIfAborted();
  if (BigInt(actual) !== BigInt(chainId)) throw new Error(`Switch your wallet to chain ${chainId}.`);
  return wallet;
}

/** The connected wallet and its collectable balance in wei. */
export async function readCredits(config, provider = globalThis.window?.ethereum, { signal } = {}) {
  const { address, chainId } = chainTarget(config);
  const wallet = await connectedWallet(provider, chainId, signal);
  const wei = await readUint(provider, address, 'credits', wallet);
  signal?.throwIfAborted();
  return { wallet, wei };
}

/**
 * On-chain balances of a provider (default: the connected wallet): `credits` is what it can
 * collect, `stake` what it has locked in unsettled jobs. Both in wei.
 */
export async function readProviderBalances(config, provider = globalThis.window?.ethereum, { account, jobIds, signal } = {}) {
  const { address, chainId } = chainTarget(config);
  const wallet = await connectedWallet(provider, chainId, signal);
  const target = /^0x[\da-f]{40}$/i.test(account ?? '') ? account : wallet;
  const [credits, locked] = await Promise.all([
    readUint(provider, address, 'credits', target),
    // lockedStake is newer than credits/withdraw; an older deployment lacks it
    readUint(provider, address, 'lockedStake', target).catch(() => null),
  ]);
  signal?.throwIfAborted();
  let stake = locked;
  if (stake === null) {
    // older contract: add up the per-job stakes instead (jobIds: a function or a list of on-chain ids)
    const ids = typeof jobIds === 'function' ? await jobIds(signal) : jobIds;
    stake = Array.isArray(ids) ? await stakeAcrossJobs(provider, address, target, ids.filter(id => /^\d+$/.test(String(id)))).catch(() => null) : null;
    signal?.throwIfAborted();
  }
  return { wallet, account: target, credits, stake };
}

/** Withdraw the connected wallet's credits to that wallet; resolves once the transaction is mined. */
export async function collectFunds(config, provider = globalThis.window?.ethereum, { signal, pollMs = 1000, maxPolls = 120 } = {}) {
  const { address } = chainTarget(config);
  const { wallet, wei } = await readCredits(config, provider, { signal });
  if (wei === 0n) throw new Error('There is nothing to collect yet.');
  const data = encodeFunctionData({ abi: creditsAbi, functionName: 'withdraw' });
  // dry run first, so a revert (e.g. "No credit") is reported before the wallet prompts
  await provider.request({ method: 'eth_call', params: [{ from: wallet, to: address, data }, 'latest'] });
  signal?.throwIfAborted();
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: address, data }] });
  await waitForReceipt(provider, hash, 'withdrawal', { signal, pollMs, maxPolls });
  return { hash, wei };
}

const cancelAbi = [{ type: 'function', name: 'cancelJob', stateMutability: 'nonpayable',
  inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

/**
 * The buyer cancels an on-chain job nobody has been assigned to yet: cancelJob(jobId).
 * The contract credits the escrowed price back to the buyer (collect it with collectFunds).
 * Resolves once the transaction is mined.
 */
export async function cancelStoredJob(job, config, provider = globalThis.window?.ethereum, { signal, pollMs = 1000, maxPolls = 120 } = {}) {
  signal?.throwIfAborted();
  const { address, chainId } = chainTarget(config);
  if (!job?.canCancel || !/^\d+$/.test(String(job.id))) throw new Error('This job can no longer be canceled.');
  const wallet = await connectedWallet(provider, chainId, signal);
  if (job.submitWallet && wallet.toLowerCase() !== job.submitWallet.toLowerCase()) throw new Error('Connect the wallet that submitted this job.');
  const data = encodeFunctionData({ abi: cancelAbi, functionName: 'cancelJob', args: [BigInt(job.id)] });
  // dry run first, so a revert (e.g. providers were just assigned) is reported before the wallet prompts
  await provider.request({ method: 'eth_call', params: [{ from: wallet, to: address, data }, 'latest'] });
  signal?.throwIfAborted();
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: address, data }] });
  await waitForReceipt(provider, hash, 'cancel', { signal, pollMs, maxPolls });
  return { hash };
}

async function waitForReceipt(provider, hash, what, { signal, pollMs, maxPolls }) {
  if (!/^0x[\da-f]{64}$/i.test(hash ?? '')) throw new Error('The wallet returned an invalid transaction hash. Check your wallet before retrying.');
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error(`The ${what} transaction failed on chain.`);
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    signal?.throwIfAborted();
  }
  throw new Error(`The ${what} was sent but is not confirmed yet. Check your wallet.`);
}
