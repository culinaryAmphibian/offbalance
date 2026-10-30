import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoTransactionStore } from '../adapters/transactions.ts';
import { DurableTransactions, TransactionPendingError, type TransactionRecord, type TransactionTransport } from '../services/transactions.ts';
const uri = process.env.MONGODB_URI;

test('Mongo journal survives coordinator replacement and rebroadcasts exactly the persisted signed bytes', { skip: !uri }, async () => {
  const connection = await mongoose.createConnection(uri!, { dbName: `offbalance_transactions_${randomUUID().replaceAll('-', '')}` }).asPromise();
  try {
    const store = new MongoTransactionStore('31337:signer', connection);
    const row: TransactionRecord = { hash: `0x${'1'.repeat(64)}`, raw: '0x0102', nonce: 7, intent: 'assign:42', state: 'pending' };
    let prepared = 0; let timeout = true;
    const broadcasts: string[] = [];
    const transport: TransactionTransport = {
      prepare: async () => { prepared++; return row; },
      receipt: async () => null,
      broadcast: async raw => {
        assert.equal((await new MongoTransactionStore('31337:signer', connection).find('assign:42'))?.raw, raw);
        broadcasts.push(raw);
      },
      wait: async () => { if (timeout) throw new Error('receipt timeout'); return 'success'; },
    };
    await assert.rejects(new DurableTransactions(store, transport).execute(row.intent), TransactionPendingError);
    const restartedStore = new MongoTransactionStore('31337:signer', connection);
    assert.equal((await restartedStore.pending())[0].nonce, 7);
    timeout = false;
    await new DurableTransactions(restartedStore, transport).recover();
    assert.deepEqual(broadcasts, ['0x0102', '0x0102']); assert.equal(prepared, 1);
    assert.equal((await restartedStore.find(row.intent))?.state, 'success');
    assert.deepEqual(await restartedStore.pending(), []);
    const second = { ...row, hash: `0x${'2'.repeat(64)}` as `0x${string}`, intent: 'other' };
    await assert.rejects(restartedStore.save(second), /duplicate key/);
  } finally { await connection.dropDatabase(); await connection.close(); }
});

test('Mongo signer lease excludes competing coordinators and permits takeover after release or expiration', { skip: !uri }, async () => {
  const connection = await mongoose.createConnection(uri!, { dbName: `offbalance_signer_${randomUUID().replaceAll('-', '')}` }).asPromise();
  try {
    const first = new MongoTransactionStore('1:signer', connection);
    const second = new MongoTransactionStore('1:signer', connection);
    await first.exclusive(async assertLease => {
      await assertLease();
      await assert.rejects(second.exclusive(async () => {}), TransactionPendingError);
    });
    await second.exclusive(async () => {});
    const leases = connection.collection<{ _id: string; owner: string; expiresAt: Date }>('serversignerleases');
    await leases.updateOne({ _id: '1:signer' }, { $set: { owner: 'dead-process', expiresAt: new Date(0) } });
    await first.exclusive(async assertLease => { await assertLease(); });
  } finally { await connection.dropDatabase(); await connection.close(); }
});
