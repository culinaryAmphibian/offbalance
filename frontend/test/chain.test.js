import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseEther } from 'viem';
import { submitStoredJob } from '../src/chain.js';

const wallet = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const hash = `0x${'ab'.repeat(32)}`;
const config = () => ({ executionMode: 'chain', chain: { chainId: 31337, address: contract } });
const image = 'repo@sha256:' + 'c'.repeat(64);
const job = () => ({ id: '42', maxPrice: '0.000000000000000123', k: 3, quorum: 2, window: 3600, dockerImage: image, canSubmit: true, submitWallet: wallet, status: 'PENDING', submittedAt: null });
// The production Solidity signature: five uint256 arguments and the image, payable with the escrowed price.
const abi = [{ type: 'function', name: 'submitJob', stateMutability: 'payable', inputs: [
  { name: 'price', type: 'uint256' },
  { name: 'k', type: 'uint256' }, { name: 'quorum', type: 'uint256' }, { name: 'executionTime', type: 'uint256' },
  { name: 'dockerName', type: 'string' },
], outputs: [{ type: 'bool' }] }];

function mockWallet({ accounts = [wallet], chains = ['0x7a69'], transactionHash = hash } = {}) {
  const calls = [];
  let accountReads = 0;
  let chainReads = 0;
  return {
    calls,
    request: async request => {
      calls.push(request);
      if (request.method === 'eth_accounts') return [accounts[Math.min(accountReads++, accounts.length - 1)]];
      if (request.method === 'eth_chainId') return chains[Math.min(chainReads++, chains.length - 1)];
      if (request.method === 'eth_sendTransaction') return transactionHash;
      throw new Error(`Unexpected wallet request: ${request.method}`);
    },
  };
}

const sent = provider => provider.calls.filter(call => call.method === 'eth_sendTransaction');

test('stored job submission encodes the real contract call and escrows the exact wei price', async () => {
  const provider = mockWallet();
  assert.deepEqual(await submitStoredJob(job(), config(), provider), { hash });
  assert.equal(sent(provider).length, 1);
  const [transaction] = sent(provider)[0].params;
  assert.equal(transaction.from, wallet);
  assert.equal(transaction.to, contract);
  assert.equal(BigInt(transaction.value), parseEther(job().maxPrice));
  const decoded = decodeFunctionData({ abi, data: transaction.data });
  assert.equal(decoded.functionName, 'submitJob');
  // contract k = our quorum, contract quorum = our k
  assert.deepEqual(decoded.args, [parseEther(job().maxPrice), 2n, 3n, 3600n, image]);
});

test('wrong wallet network rejects before sending a transaction', async () => {
  const provider = mockWallet({ chains: ['0x1'] });
  await assert.rejects(submitStoredJob(job(), config(), provider), /Switch your wallet to chain 31337/);
  assert.equal(sent(provider).length, 0);
});

test('wallet account or network changes during preparation reject before sending', async () => {
  for (const options of [
    { accounts: [wallet, '0x3333333333333333333333333333333333333333'] },
    { chains: ['0x7a69', '0x1'] },
  ]) {
    const provider = mockWallet(options);
    await assert.rejects(submitStoredJob(job(), config(), provider), /Your wallet changed/);
    assert.equal(sent(provider).length, 0);
  }
});

test('local, missing, and invalid contract configurations never reach the wallet', async () => {
  for (const value of [null, {}, { executionMode: 'local', chain: null }, { ...config(), chain: null },
    { ...config(), chain: { ...config().chain, address: 'bad-address' } },
    { ...config(), chain: { ...config().chain, chainId: 0 } },
  ]) {
    const provider = mockWallet();
    await assert.rejects(submitStoredJob(job(), value, provider), /no real contract|invalid chain configuration/);
    assert.equal(provider.calls.length, 0);
  }
});

test('unauthorized, submitted, and terminal jobs cannot send transactions', async () => {
  for (const changes of [{ canSubmit: false }, { submittedAt: '2026-10-19T00:00:00Z' }, { status: 'COMPLETED' }, { status: 'CANCELED' }]) {
    const provider = mockWallet();
    await assert.rejects(submitStoredJob({ ...job(), ...changes }, config(), provider), /cannot be submitted/);
    assert.equal(provider.calls.length, 0);
  }
});

test('invalid saved job parameters reject before requesting wallet access', async () => {
  for (const changes of [{ id: 'database-object-id' }, { k: 0 }, { quorum: 4 }, { window: 0 }, { k: 1.5 }]) {
    const provider = mockWallet();
    await assert.rejects(submitStoredJob({ ...job(), ...changes }, config(), provider), /invalid blockchain parameters/);
    assert.equal(provider.calls.length, 0);
  }
});

test('missing wallet and disconnected accounts give actionable errors', async () => {
  await assert.rejects(submitStoredJob(job(), config(), {}), /Connect an Ethereum wallet/);
  const provider = mockWallet({ accounts: [] });
  await assert.rejects(submitStoredJob(job(), config(), provider), /Connect your wallet again/);
  assert.equal(sent(provider).length, 0);
});

test('invalid transaction hash reports uncertain wallet state without claiming submission success', async () => {
  const provider = mockWallet({ transactionHash: '0x1234' });
  await assert.rejects(submitStoredJob(job(), config(), provider), /invalid transaction hash.*Check your wallet before retrying/);
  assert.equal(sent(provider).length, 1);
});


test('initial wallet must match the server-authenticated submission wallet', async () => {
  const provider = mockWallet({ accounts: ['0x3333333333333333333333333333333333333333'] });
  await assert.rejects(submitStoredJob(job(), config(), provider), /Your wallet changed/);
  assert.equal(sent(provider).length, 0);
  const missing = mockWallet();
  await assert.rejects(submitStoredJob({ ...job(), submitWallet: null }, config(), missing), /no authenticated submission wallet/);
  assert.equal(missing.calls.length, 0);
});

test('canceling during any wallet preparation request prevents transaction submission', async () => {
  for (let pauseAt = 1; pauseAt <= 4; pauseAt++) {
    const controller = new AbortController();
    const mock = mockWallet();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let reached;
    const paused = new Promise(resolve => { reached = resolve; });
    let requests = 0;
    const provider = { request: async request => {
      const result = await mock.request(request);
      if (++requests === pauseAt) { reached(); await gate; }
      return result;
    } };
    const submission = submitStoredJob(job(), config(), provider, { signal: controller.signal });
    await paused;
    controller.abort();
    release();
    await assert.rejects(submission, { name: 'AbortError' });
    assert.equal(sent(mock).length, 0, `canceled during wallet request ${pauseAt}`);
  }
});

test('already canceled submission never accesses the wallet', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = mockWallet();
  await assert.rejects(submitStoredJob(job(), config(), provider, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(provider.calls.length, 0);
});

test('a job without a Docker image rejects before requesting wallet access', async () => {
  for (const dockerImage of [undefined, '', '   ']) {
    const provider = mockWallet();
    await assert.rejects(submitStoredJob({ ...job(), dockerImage }, config(), provider), /no Docker image/);
    assert.equal(provider.calls.length, 0);
  }
});

// Collect funds: credits(address) view + withdraw()
import { collectFunds, readCredits, readProviderBalances } from '../src/chain.js';
import { encodeAbiParameters } from 'viem';

function creditWallet({ credits = parseEther('0.0060'), stake = parseEther('0.001'), receipt = { status: '0x1' }, chain = '0x7a69' } = {}) {
  const calls = [];
  return {
    calls,
    request: async request => {
      calls.push(request);
      switch (request.method) {
        case 'eth_accounts': return [wallet];
        case 'eth_chainId': return chain;
        case 'eth_call': {
          if (decodeFunctionData({ abi: [...viewAbi, ...withdrawAbi], data: request.params[0].data }).functionName === 'withdraw') return '0x';
          const { functionName } = decodeFunctionData({ abi: viewAbi, data: request.params[0].data });
          return encodeAbiParameters([{ type: 'uint256' }], [functionName === 'lockedStake' ? stake : credits]);
        }
        case 'eth_sendTransaction': return hash;
        case 'eth_getTransactionReceipt': return receipt;
        default: throw new Error(`Unexpected wallet request: ${request.method}`);
      }
    },
  };
}
const viewAbi = ['credits', 'lockedStake'].map(name => ({ type: 'function', name, stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }));
const withdrawAbi = [{ type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] }];

test('readCredits reads the connected wallet\'s balance from the contract', async () => {
  const provider = creditWallet();
  assert.deepEqual(await readCredits(config(), provider), { wallet, wei: parseEther('0.006') });
  const call = provider.calls.find(c => c.method === 'eth_call');
  assert.equal(call.params[0].to, contract);
});

test('collectFunds sends withdraw() from the connected wallet with no value and waits for the receipt', async () => {
  const provider = creditWallet();
  assert.deepEqual(await collectFunds(config(), provider, { pollMs: 0 }), { hash, wei: parseEther('0.006') });
  const [tx] = sent(provider).map(c => c.params[0]);
  assert.equal(tx.from, wallet);
  assert.equal(tx.to, contract);
  assert.equal(tx.value, undefined);
  assert.equal(decodeFunctionData({ abi: withdrawAbi, data: tx.data }).functionName, 'withdraw');
});

test('collectFunds refuses an empty balance, a wrong chain, and a reverted withdrawal', async () => {
  const empty = creditWallet({ credits: 0n });
  await assert.rejects(collectFunds(config(), empty, { pollMs: 0 }), /nothing to collect/);
  assert.equal(sent(empty).length, 0);
  await assert.rejects(collectFunds(config(), creditWallet({ chain: '0x1' }), { pollMs: 0 }), /Switch your wallet/);
  await assert.rejects(collectFunds(config(), creditWallet({ receipt: { status: '0x0' } }), { pollMs: 0 }), /failed on chain/);
  await assert.rejects(readCredits({ executionMode: 'demo', chain: null }, creditWallet()), /no real contract/);
});

test('readProviderBalances reads credits and locked stake for the provider address, defaulting to the wallet', async () => {
  const other = '0x3333333333333333333333333333333333333333';
  const provider = creditWallet();
  assert.deepEqual(await readProviderBalances(config(), provider, { account: other }),
    { wallet, account: other, credits: parseEther('0.006'), stake: parseEther('0.001') });
  const reads = provider.calls.filter(c => c.method === 'eth_call').map(c => decodeFunctionData({ abi: viewAbi, data: c.params[0].data }));
  assert.deepEqual(reads.map(r => [r.functionName, r.args[0].toLowerCase()]), [['credits', other], ['lockedStake', other]]);
  assert.equal((await readProviderBalances(config(), creditWallet())).account, wallet);
});

test('readProviderBalances still reads credits from a contract without lockedStake', async () => {
  const provider = creditWallet();
  const request = provider.request;
  provider.request = async call => {
    if (call.method === 'eth_call' && decodeFunctionData({ abi: viewAbi, data: call.params[0].data }).functionName === 'lockedStake') {
      throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: { message: 'function selector was not recognized and there\'s no fallback function' } });
    }
    return request(call);
  };
  const result = await readProviderBalances(config(), provider);
  assert.equal(result.credits, parseEther('0.006'));
  assert.equal(result.stake, null);
});
