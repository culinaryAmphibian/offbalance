import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChainTiming, ChainConfigurationError } from '../services/chain.ts';
const nonlocal = { chainId: 1, confirmations: 6, pollMs: 1000, revealWindow: 15n, deliveryWindow: 30n };
test('nonlocal deadline validation rejects missing estimates and confirmation lag beyond deployed windows', () => {
  assert.throws(() => validateChainTiming(nonlocal), ChainConfigurationError);
  assert.throws(() => validateChainTiming({ ...nonlocal, blockTimeS: 12, transactionBudgetS: 12 }), /must fit/);
  assert.throws(() => validateChainTiming({ ...nonlocal, blockTimeS: NaN, transactionBudgetS: 12 }), ChainConfigurationError);
});
test('explicit timing budgets must fit strictly within both windows', () => {
  validateChainTiming({ ...nonlocal, confirmations: 0, blockTimeS: 1, transactionBudgetS: 10 });
  assert.throws(() => validateChainTiming({ ...nonlocal, confirmations: 0, blockTimeS: 1, transactionBudgetS: 14 }), /must fit/);
  validateChainTiming({ ...nonlocal, revealWindow: 120n, deliveryWindow: 300n, blockTimeS: 12, transactionBudgetS: 12 });
});
test('local demo chains remain usable but invalid monitor settings are rejected', () => {
  validateChainTiming({ ...nonlocal, chainId: 31337, confirmations: 0 });
  assert.throws(() => validateChainTiming({ ...nonlocal, chainId: 31337, confirmations: -1 }), ChainConfigurationError);
});

test('nonce replacement receipts cannot confirm a different journaled operation', async () => {
  const { assertReceiptHash } = await import('../services/chain.ts');
  const { TransactionPendingError } = await import('../services/transactions.ts');
  assertReceiptHash(`0x${'a'.repeat(64)}`, `0x${'A'.repeat(64)}`);
  assert.throws(() => assertReceiptHash(`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`), TransactionPendingError);
});

test('canonical checkpoint changes halt transaction recovery and future writes before signing', async t => {
  const { Chain } = await import('../services/chain.ts');
  const { MongoCheckpointStore } = await import('../adapters/checkpoints.ts');
  const { TransactionPendingError } = await import('../services/transactions.ts');
  const oldHash = `0x${'a'.repeat(64)}`;
  const genesis = `0x${'0'.repeat(64)}`;
  let canonical = `0x${'b'.repeat(64)}`;
  t.mock.method(MongoCheckpointStore.prototype, 'load', async () => ({ blockNumber: 7, blockHash: oldHash }));
  const publicClient = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockNumber === 0n ? genesis : canonical }) };
  const wallet = { account: { address: `0x${'1'.repeat(40)}` } };
  const deployment = { address: `0x${'2'.repeat(40)}`, chainId: 31337, abi: ['event Observed(uint256 jobId)'] };
  const chain = Reflect.construct(Chain, [publicClient, wallet, { destroy() {}, getBlockNumber: async () => 10, getLogs: async () => [], getBlock: async () => null }, deployment, genesis]) as Chain;
  assert.equal(chain.canWrite, true);
  await assert.rejects(chain.recoverTransactions(), TransactionPendingError);
  assert.equal(chain.canWrite, false);
  canonical = oldHash;
  await assert.rejects(chain.assignProviders(1, [wallet.account.address]), /requires reconciliation/);
  await chain.stop();
});

test('unreadable canonical checkpoint cannot broadcast or release an unresolved transaction', async t => {
  const { Chain } = await import('../services/chain.ts');
  const { MongoCheckpointStore } = await import('../adapters/checkpoints.ts');
  const { TransactionPendingError } = await import('../services/transactions.ts');
  t.mock.method(MongoCheckpointStore.prototype, 'load', async () => { throw new Error('database unavailable'); });
  const deployment = { address: `0x${'2'.repeat(40)}`, chainId: 31337, abi: ['event Observed(uint256 jobId)'] };
  const genesis = `0x${'0'.repeat(64)}`;
  const chain = Reflect.construct(Chain, [{ getBlock: async () => ({ hash: genesis }) }, null, { destroy() {}, getBlockNumber: async () => 10, getLogs: async () => [], getBlock: async () => null }, deployment, genesis]) as Chain;
  await assert.rejects(chain.recoverTransactions(), TransactionPendingError);
  await chain.stop();
});

test('a live chain reset halts recovery even before an event checkpoint exists', async t => {
  const { Chain } = await import('../services/chain.ts');
  const { MongoCheckpointStore } = await import('../adapters/checkpoints.ts');
  const { TransactionPendingError } = await import('../services/transactions.ts');
  let checkpointsRead = 0;
  t.mock.method(MongoCheckpointStore.prototype, 'load', async () => { checkpointsRead++; return null; });
  const genesis = `0x${'a'.repeat(64)}`;
  let currentGenesis = `0x${'b'.repeat(64)}`;
  const wallet = { account: { address: `0x${'1'.repeat(40)}` } };
  const deployment = { address: `0x${'2'.repeat(40)}`, chainId: 31337, abi: ['event Observed(uint256 jobId)'] };
  const chain = Reflect.construct(Chain, [{ getBlock: async () => ({ hash: currentGenesis }) }, wallet,
    { destroy() {}, getBlockNumber: async () => 0, getLogs: async () => [], getBlock: async () => null }, deployment, genesis]) as Chain;
  try {
    await assert.rejects(chain.recoverTransactions(), /reset chain/);
    assert.equal(checkpointsRead, 0);
    assert.equal(chain.canWrite, false);
    currentGenesis = genesis;
    await assert.rejects(chain.assignProviders(1, [wallet.account.address]), TransactionPendingError);
  } finally { await chain.stop(); }
});
