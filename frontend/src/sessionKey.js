import { decodeFunctionResult, encodeFunctionData, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Session keys let the provider client sign stake / commit / reveal transactions for the signed-in
// wallet without holding that wallet's key. The browser generates the key, the key signs its
// consent, and the wallet sends OffBalance.registerSessionKey (funding the key in the same tx).
// Payouts still go to the wallet, and only the wallet can withdraw.

export const sessionKeyAbi = [
  { type: 'function', name: 'sessionKeyDigest', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'sessionKey', type: 'address' }, { name: 'expiresAt', type: 'uint64' }],
    outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'registerSessionKey', stateMutability: 'payable',
    inputs: [{ name: 'sessionKey', type: 'address' }, { name: 'expiresAt', type: 'uint64' }, { name: 'signature', type: 'bytes' }],
    outputs: [] },
  { type: 'function', name: 'revokeSessionKey', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'activeSessionKey', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'sessionKeys', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: 'owner', type: 'address' }, { name: 'expiresAt', type: 'uint64' }] },
];

const ZERO = '0x0000000000000000000000000000000000000000';
const isAddress = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);

function contractOf(config) {
  if (config?.executionMode !== 'chain' || !isAddress(config.chain?.address)) {
    throw new Error('The server has no real contract configured.');
  }
  const chainId = config.chain.chainId;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('The server returned an invalid chain configuration.');
  return { address: config.chain.address, chainId };
}

// The connected wallet must be the signed-in one, on the contract's chain.
async function checkWallet(provider, owner, chainId) {
  if (!provider?.request) throw new Error('Connect an Ethereum wallet first.');
  const [wallet] = await provider.request({ method: 'eth_accounts' });
  if (!isAddress(wallet)) throw new Error('Connect your wallet again.');
  if (wallet.toLowerCase() !== owner.toLowerCase()) throw new Error('Your wallet changed. Sign in again.');
  const actual = await provider.request({ method: 'eth_chainId' });
  if (BigInt(actual) !== BigInt(chainId)) throw new Error(`Switch your wallet to chain ${chainId} first.`);
  return wallet;
}

async function read(provider, to, functionName, args) {
  const data = encodeFunctionData({ abi: sessionKeyAbi, functionName, args });
  const result = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  return decodeFunctionResult({ abi: sessionKeyAbi, functionName, data: result });
}

async function waitForReceipt(provider, hash, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw new Error('The transaction failed on-chain.');
      return receipt;
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for the transaction. Check your wallet.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function send(provider, from, to, data, value = 0n, options) {
  const tx = { from, to, data };
  if (value > 0n) tx.value = toHex(value);
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
  if (!/^0x[\da-f]{64}$/i.test(hash ?? '')) throw new Error('The wallet returned an invalid transaction hash.');
  await waitForReceipt(provider, hash, options);
  return hash;
}

// Generate, register and fund a new session key. Returns the private key, which the caller shows
// once and never stores. Replaces any key the wallet already had.
export async function authorizeSessionKey({ config, owner, expiresInDays = 30, fundingEth = '0.05' },
  provider = globalThis.window?.ethereum, { now = Date.now, receipt } = {}) {
  const { address: contract, chainId } = contractOf(config);
  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('Choose an expiry between 1 and 365 days.');
  let funding;
  try { funding = parseEther(String(fundingEth).trim() || '0'); } catch { throw new Error('Enter the funding as an ETH amount.'); }
  if (funding < 0n) throw new Error('Funding cannot be negative.');

  const wallet = await checkWallet(provider, owner, chainId);
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const expiresAt = BigInt(Math.floor(now() / 1000 + days * 86400));

  // The digest includes the wallet's on-chain nonce, so ask the contract for it.
  const digest = await read(provider, contract, 'sessionKeyDigest', [wallet, account.address, expiresAt]);
  const signature = await account.signMessage({ message: { raw: digest } });
  const data = encodeFunctionData({ abi: sessionKeyAbi, functionName: 'registerSessionKey',
    args: [account.address, expiresAt, signature] });
  const hash = await send(provider, wallet, contract, data, funding, receipt);
  return { privateKey, address: account.address, expiresAt: Number(expiresAt), hash };
}

// The wallet's current session key, or null. `expired` keys no longer act for the wallet.
export async function readSessionKey(config, owner, provider = globalThis.window?.ethereum, { now = Date.now } = {}) {
  const { address: contract } = contractOf(config);
  if (!provider?.request || !isAddress(owner)) return null;
  const key = await read(provider, contract, 'activeSessionKey', [owner]);
  if (!key || key.toLowerCase() === ZERO) return null;
  const [, expiresAt] = await read(provider, contract, 'sessionKeys', [key]);
  return { address: key, expiresAt: Number(expiresAt), expired: Number(expiresAt) <= now() / 1000 };
}

export async function revokeSessionKey(config, owner, provider = globalThis.window?.ethereum, { receipt } = {}) {
  const { address: contract, chainId } = contractOf(config);
  const wallet = await checkWallet(provider, owner, chainId);
  const data = encodeFunctionData({ abi: sessionKeyAbi, functionName: 'revokeSessionKey', args: [] });
  return { hash: await send(provider, wallet, contract, data, 0n, receipt) };
}
