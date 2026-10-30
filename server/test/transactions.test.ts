import test from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { DurableTransactions, TransactionPendingError, TransactionRevertedError, TransactionNotBroadcastError,
  type TransactionRecord, type TransactionStore, type TransactionTransport } from '../services/transactions.ts';

function fixture() {
  const records: TransactionRecord[] = [];
  const receipts = new Map<Hex, 'success' | 'reverted'>();
  const broadcasts: Hex[] = [];
  let prepared = 0;
  let waitError = false;
  let minedBeforeTimeout = false;
  let receiptStatus: 'success' | 'reverted' = 'success';
  const store: TransactionStore = {
    exclusive: async work => work(async () => {}),
    pending: async () => records.filter(row => row.state === 'pending'),
    find: async intent => records.findLast(row => row.intent === intent && row.state !== 'reverted') ?? null,
    save: async row => { records.push(structuredClone(row)); },
    finish: async (hash, status) => { records.find(row => row.hash === hash)!.state = status; },
  };
  const transport: TransactionTransport = {
    prepare: async intent => {
      const nonce = prepared++;
      return { hash: `0x${nonce.toString(16).padStart(64, '0')}`, raw: `0x${nonce.toString(16).padStart(2, '0')}`,
        nonce, intent, state: 'pending' };
    },
    receipt: async hash => receipts.get(hash) ?? null,
    broadcast: async raw => {
      assert.ok(records.some(row => row.raw === raw), 'signed bytes must be durable before broadcast');
      broadcasts.push(raw);
    },
    wait: async hash => {
      if (minedBeforeTimeout) receipts.set(hash, receiptStatus);
      if (waitError) throw new Error('receipt timeout');
      receipts.set(hash, receiptStatus);
      return receiptStatus;
    },
  };
  return { records, receipts, broadcasts, store, transport,
    prepared: () => prepared,
    failWait: (mined = false) => { waitError = true; minedBeforeTimeout = mined; },
    succeedWait: () => { waitError = false; },
    revert: () => { receiptStatus = 'reverted'; },
    create: () => new DurableTransactions(store, transport),
  };
}

test('lost receipt after mining recovers without signing or broadcasting a second transaction', async () => {
  const f = fixture(); f.failWait(true);
  await assert.rejects(f.create().execute('assign:1'), TransactionPendingError);
  assert.equal(f.records[0].state, 'pending');
  await f.create().execute('assign:1');
  assert.equal(f.records[0].state, 'success'); assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 1);
});
test('restart rebroadcasts identical bytes and nonce for an unresolved transaction', async () => {
  const f = fixture(); f.failWait();
  await assert.rejects(f.create().execute('assign:1'), TransactionPendingError);
  f.succeedWait(); await f.create().recover();
  assert.deepEqual(f.broadcasts, [f.records[0].raw, f.records[0].raw]);
  assert.equal(f.prepared(), 1); assert.equal(f.records[0].state, 'success');
});
test('a mined revert is definitive and a later attempt gets a new nonce', async () => {
  const f = fixture(); f.revert();
  await assert.rejects(f.create().execute('assign:1'), TransactionRevertedError);
  assert.equal(f.records[0].state, 'reverted');
  await assert.rejects(f.create().execute('assign:1'), TransactionRevertedError);
  assert.deepEqual(f.records.map(row => row.nonce), [0, 1]);
});
test('concurrent intents serialize nonce allocation and unresolved prior nonce blocks new signing', async () => {
  const f = fixture(); const runner = f.create();
  await Promise.all([runner.execute('assign:1'), runner.execute('receipt:1'), runner.execute('phase:1')]);
  assert.deepEqual(f.records.map(row => row.nonce), [0, 1, 2]);
  f.failWait(); await assert.rejects(runner.execute('assign:2'), TransactionPendingError);
  await assert.rejects(runner.execute('assign:3'), TransactionPendingError);
  assert.equal(f.prepared(), 4); await runner.idle();
});
test('journal persistence and lease-release failures remain uncertain after signing/broadcast', async () => {
  const f = fixture(); const save = f.store.save;
  f.store.save = async row => { await save(row); throw new Error('lost database acknowledgement'); };
  await assert.rejects(f.create().execute('assign:1'), TransactionPendingError);
  assert.equal(f.broadcasts.length, 0); f.store.save = save; await f.create().recover();
  f.store.exclusive = async work => { await work(async () => {}); throw new Error('lease release unavailable'); };
  await assert.rejects(f.create().execute('assign:2'), TransactionPendingError);
  assert.equal(f.records[1].state, 'success');
});
test('missing canonical receipt for prior success rebroadcasts the same transaction and fails closed', async () => {
  const f = fixture(); await f.create().execute('assign:1'); f.receipts.clear(); f.failWait();
  await assert.rejects(f.create().execute('assign:1'), TransactionPendingError);
  assert.equal(f.prepared(), 1); assert.deepEqual(f.broadcasts, [f.records[0].raw, f.records[0].raw]);
});
test('pre-sign simulation failure is explicitly safe to roll back', async () => {
  const f = fixture(); f.transport.prepare = async () => { throw new Error('execution reverted: wrong phase'); };
  await assert.rejects(f.create().execute('assign:1'), TransactionNotBroadcastError);
  assert.equal(f.records.length, 0); assert.equal(f.broadcasts.length, 0);
});
test('database failure recording a mined receipt does not turn success into a definitive failure', async () => {
  const f = fixture(); f.store.finish = async () => { throw new Error('write failed'); };
  await assert.rejects(f.create().execute('assign:1'), TransactionPendingError);
  assert.equal(f.prepared(), 1); assert.equal(f.records[0].state, 'pending');
});
