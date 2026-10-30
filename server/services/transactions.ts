import type { Hex } from 'viem';

export type TransactionRecord = {
  hash: Hex; raw: Hex; nonce: number; intent: string; state: 'pending' | 'success' | 'reverted';
};
export interface TransactionStore {
  exclusive<T>(work: (assertLease: () => Promise<void>) => Promise<T>): Promise<T>;
  pending(): Promise<TransactionRecord[]>;
  find(intent: string): Promise<TransactionRecord | null>;
  save(record: TransactionRecord): Promise<void>;
  finish(hash: Hex, state: 'success' | 'reverted'): Promise<void>;
}
export interface TransactionTransport {
  prepare(intent: string): Promise<TransactionRecord>;
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
  broadcast(raw: Hex): Promise<void>;
  wait(hash: Hex): Promise<'success' | 'reverted'>;
}

/** A signed transaction may already be mined; callers must retain their claims. */
export class TransactionPendingError extends Error {
  readonly uncertain = true;
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}
export class TransactionRevertedError extends Error {}
export class TransactionNotBroadcastError extends Error {}
export const uncertainTransaction = (error: unknown): boolean => error instanceof TransactionPendingError;

/** Persist exact signed bytes before broadcast. A retry can never create a second payment/assignment. */
export class DurableTransactions {
  private tail: Promise<unknown> = Promise.resolve();
  private store: TransactionStore;
  private transport: TransactionTransport;
  constructor(store: TransactionStore, transport: TransactionTransport) { this.store = store; this.transport = transport; }

  private serialized<T>(work: (lease: () => Promise<void>) => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(() => this.store.exclusive(work));
    this.tail = next;
    return next;
  }

  private async reconcile(row: TransactionRecord, lease: () => Promise<void>): Promise<void> {
    try {
      let status = await this.transport.receipt(row.hash);
      if (!status) {
        await lease();
        try { await this.transport.broadcast(row.raw); }
        catch (error) {
          // A provider may reject an already-known/mined transaction, or lose the broadcast response.
          status = await this.transport.receipt(row.hash);
          if (!status) status = await this.transport.wait(row.hash);
        }
        status ??= await this.transport.wait(row.hash);
      }
      await lease();
      await this.store.finish(row.hash, status);
      if (status === 'reverted') throw new TransactionRevertedError(`Transaction ${row.hash} reverted.`);
    } catch (error) {
      if (error instanceof TransactionRevertedError) throw error;
      throw new TransactionPendingError(`Transaction ${row.hash} has an unresolved outcome.`, { cause: error });
    }
  }

  async execute(intent: string): Promise<void> {
    return this.serialized(async lease => {
      const previous = await this.store.find(intent);
      if (previous) return this.reconcile(previous, lease);
      // Resolve prior nonces before allocating another nonce, including after process restart.
      for (const row of await this.store.pending()) {
        try { await this.reconcile(row, lease); }
        catch (error) { if (!(error instanceof TransactionRevertedError)) throw error; }
      }
      let row: TransactionRecord;
      try { row = await this.transport.prepare(intent); }
      catch (error) {
        if (error instanceof TransactionPendingError) throw error;
        throw new TransactionNotBroadcastError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      await lease();
      try { await this.store.save(row); }
      catch (error) { throw new TransactionPendingError('Signed transaction journal persistence is uncertain.', { cause: error }); }
      return this.reconcile(row, lease);
    }).catch(error => {
      if (error instanceof TransactionNotBroadcastError || error instanceof TransactionRevertedError || error instanceof TransactionPendingError) throw error;
      throw new TransactionPendingError('Signer or journal state is unavailable; retaining transaction intent.', { cause: error });
    });
  }

  async idle(): Promise<void> { await this.tail.catch(() => {}); }

  async recover(): Promise<void> {
    return this.serialized(async lease => {
      for (const row of await this.store.pending()) {
        try { await this.reconcile(row, lease); }
        catch (error) {
          if (error instanceof TransactionRevertedError || error instanceof TransactionPendingError) {
            console.warn(error.message);
          } else throw error;
        }
      }
    });
  }
}
