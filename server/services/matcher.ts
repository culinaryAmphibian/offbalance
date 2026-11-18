import { AccountModel, JobModel, JobStatus } from '../models/index.ts';
import { MongoRepository } from '../adapters/repository.ts';
import { MatchManager } from '../matching/MatchManager.ts';
import type { AvailableProvider, MatchQuote, SchedulingJob } from '../matching/types.ts';
import { ChainWriteUnconfirmedError, type Chain } from './chain.ts';
import { formatEthAmount } from '../matching/MatchingEngine.ts';

export class Matcher {
  readonly repository: MongoRepository;
  readonly manager: MatchManager;
  private queue: Promise<void> = Promise.resolve();
  private chain: Pick<Chain, 'assignProviders'> & Partial<Pick<Chain, 'assignQuotedProviders' | 'supportsQuotedPricing'>> | null;
  private now: () => number;

  constructor(chain: (Pick<Chain, 'assignProviders'> & Partial<Pick<Chain, 'assignQuotedProviders' | 'supportsQuotedPricing'>>) | null, { now = Date.now, heartbeatTimeoutMs = 30_000 } = {}) {
    this.chain = chain;
    this.now = now;
    this.repository = new MongoRepository();
    this.manager = new MatchManager({ repository: this.repository, now, heartbeatTimeoutMs,
      onMatched: (job, providers, quote) => this.assign(job, providers, quote) });
  }

  get supportsQuotedPricing(): boolean { return this.chain?.supportsQuotedPricing === true; }

  // A benchmark or price update never establishes liveness. Authenticated
  // HTTPS heartbeats explicitly call this method instead.
  async heartbeat(wallet: string): Promise<boolean> {
    const provider = await this.repository.getProvider(wallet);
    if (!provider) return false;
    this.manager.pool.register({ ...provider, lastHeartbeat: this.now() });
    await this.ping();
    return true;
  }

  release(jobId: number): void {
    const id = String(jobId);
    this.manager.forgetAssignment(id);
    this.manager.pool.release(id);
  }

  async idle(): Promise<void> { await this.queue; }

  ping(): Promise<void> {
    const pending = this.queue.catch(() => {}).then(() => this.run());
    this.queue = pending;
    return pending;
  }

  private async run(): Promise<void> {
    const waiting = await JobModel.find({ status: JobStatus.PENDING,
      submittedAt: { $ne: null }, fundingError: null, providers: { $size: 0 } }).sort({ createdAt: 1 });
    for (const job of waiting) await this.manager.onJobSubmitted(String(job.onChainJobId));
    await this.manager.matchNext();
  }

  private async assign(job: SchedulingJob, providers: AvailableProvider[], quote: MatchQuote): Promise<void> {
    const accountIds = providers.map(p => p.accountId);
    const highestRate = quote.providers.reduce((max, p) => {
      const rate = BigInt(p.rateWei);
      return rate > max ? rate : max;
    }, 0n);
    const assignedRates = providers.map((provider, index) => ({
      provider: provider.accountId, wallet: provider.wallet,
      hourlyRate: quote.providers[index].pricePerHour, bookedCharge: quote.providers[index].cost,
    }));
    const claimed = await JobModel.findOneAndUpdate({ onChainJobId: Number(job.id), status: JobStatus.PENDING,
      submittedAt: { $ne: null }, fundingError: null, providers: { $size: 0 } },
      { $set: { providers: accountIds, assignedRates, runningPrice: formatEthAmount(highestRate) } }, { returnDocument: 'after' });
    if (!claimed) throw new Error(`Job ${job.id} is no longer waiting.`);
    try {
      // Persist before broadcasting: providers fetch their manifest on selection.
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $addToSet: { takenJobs: claimed._id } });
      const wallets = providers.map(p => p.wallet);
      if (claimed.quoteId) {
        if (claimed.contractJobId == null || !this.chain?.assignQuotedProviders) throw new Error('Confirmed quote and priced contract required.');
        await this.chain.assignQuotedProviders(claimed.contractJobId, wallets, quote.providers.map(p => BigInt(p.rateWei)));
      } else {
        await this.chain?.assignProviders(claimed.onChainJobId, wallets);
      }
    } catch (error) {
      if (claimed.quoteId && error instanceof ChainWriteUnconfirmedError) {
        // A confirmed transaction may still arrive. Keep its exact wallet/rate set for event replay.
        console.warn(`Quoted assignment ${claimed.contractJobId} remains reserved: ${error.message}`);
        return;
      }
      await JobModel.updateOne({ _id: claimed._id }, { $set: { providers: [], assignedRates: [], runningPrice: '0' } });
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $pull: { takenJobs: claimed._id } });
      throw error;
    }
  }
}
