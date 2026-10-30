import { randomUUID } from 'node:crypto';
import mongoose, { Schema, type Connection } from 'mongoose';
import type { Hex } from 'viem';
import { TransactionPendingError, type TransactionRecord, type TransactionStore } from '../services/transactions.ts';

const transactionSchema = new Schema({
  _id: { type: String, required: true }, namespace: { type: String, required: true },
  hash: { type: String, required: true }, raw: { type: String, required: true },
  intent: { type: String, required: true }, nonce: { type: Number, required: true },
  state: { type: String, enum: ['pending', 'success', 'reverted'], required: true },
}, { timestamps: true, versionKey: false, writeConcern: { w: 'majority', j: true } });
transactionSchema.index({ namespace: 1, nonce: 1 }, { unique: true });
transactionSchema.index({ namespace: 1, intent: 1, createdAt: -1 });
const leaseSchema = new Schema({
  _id: { type: String, required: true }, owner: String, expiresAt: Date,
}, { versionKey: false, writeConcern: { w: 'majority', j: true } });

export class MongoTransactionStore implements TransactionStore {
  private transactions;
  private leases;
  private namespace: string;
  constructor(namespace: string, connection: Connection = mongoose.connection) {
    this.namespace = namespace;
    this.transactions = connection.model('ServerTransaction', transactionSchema);
    this.leases = connection.model('ServerSignerLease', leaseSchema);
  }
  async exclusive<T>(work: (assertLease: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.transactions.init();
    const owner = randomUUID();
    await this.leases.updateOne({ _id: this.namespace }, { $setOnInsert: { expiresAt: new Date(0) } }, { upsert: true });
    const claim = await this.leases.findOneAndUpdate({ _id: this.namespace, expiresAt: { $lte: new Date() } },
      { $set: { owner, expiresAt: new Date(Date.now() + 120_000) } });
    if (!claim) throw new TransactionPendingError('Another coordinator owns the signer lease.');
    const assertLease = async () => {
      const renewed = await this.leases.updateOne({ _id: this.namespace, owner, expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: new Date(Date.now() + 120_000) } });
      if (!renewed.matchedCount) throw new TransactionPendingError('Signer lease expired; refusing to broadcast.');
    };
    try { return await work(assertLease); }
    finally {
      try { await this.leases.updateOne({ _id: this.namespace, owner }, { $set: { expiresAt: new Date(0) } }); }
      catch (error) { throw new TransactionPendingError('Signer lease release could not be persisted.', { cause: error }); }
    }
  }
  async pending(): Promise<TransactionRecord[]> {
    return await this.transactions.find({ namespace: this.namespace, state: 'pending' }).sort({ nonce: 1 }).lean() as unknown as TransactionRecord[];
  }
  async find(intent: string): Promise<TransactionRecord | null> {
    return await this.transactions.findOne({ namespace: this.namespace, intent, state: { $in: ['pending', 'success'] } })
      .sort({ createdAt: -1 }).lean() as unknown as TransactionRecord | null;
  }
  async save(row: TransactionRecord): Promise<void> {
    await this.transactions.create({ _id: `${this.namespace}:${row.hash}`, namespace: this.namespace, ...row });
  }
  async finish(hash: Hex, state: 'success' | 'reverted'): Promise<void> {
    const result = await this.transactions.updateOne({ _id: `${this.namespace}:${hash}` }, { $set: { state } });
    if (!result.matchedCount) throw new Error('Signed transaction journal disappeared.');
  }
}
