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
  { name: 'jobId', type: 'uint256' }, { name: 'price', type: 'uint256' },
  { name: 'k', type: 'uint256' }, { name: 'quorum', type: 'uint256' }, { name: 'executionTime', type: 'uint256' },
  { name: 'dockerImage', type: 'string' },
], outputs: [] }];

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
  assert.deepEqual(decoded.args, [42n, parseEther(job().maxPrice), 3n, 2n, 3600n, image]);
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
