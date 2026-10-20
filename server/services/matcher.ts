import { AccountModel, JobModel, JobStatus } from '../models/index.ts';
import { MongoRepository } from '../adapters/repository.ts';
import { MatchManager } from '../matching/MatchManager.ts';
import type { AvailableProvider, SchedulingJob } from '../matching/types.ts';
import type { Chain } from './chain.ts';

export class Matcher {
  readonly repository: MongoRepository;
  readonly manager: MatchManager;
  private queue: Promise<void> = Promise.resolve();
  private chain: Pick<Chain, 'assignProviders'> | null;
  private now: () => number;

  constructor(chain: Pick<Chain, 'assignProviders'> | null, { now = Date.now, heartbeatTimeoutMs = 30_000 } = {}) {
    this.chain = chain;
    this.now = now;
    this.repository = new MongoRepository();
    this.manager = new MatchManager({ repository: this.repository, now, heartbeatTimeoutMs,
      onMatched: (job, providers) => this.assign(job, providers) });
  }

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
      submittedAt: { $ne: null }, providers: { $size: 0 } }).sort({ createdAt: 1 });
    for (const job of waiting) await this.manager.onJobSubmitted(String(job.onChainJobId));
    await this.manager.matchNext();
  }

  private async assign(job: SchedulingJob, providers: AvailableProvider[]): Promise<void> {
    const accountIds = providers.map(p => p.accountId);
    const runningPrice = providers.reduce((max, p) => Math.max(max, Number(p.pricePerHour)), 0);
    const claimed = await JobModel.findOneAndUpdate({ onChainJobId: Number(job.id), status: JobStatus.PENDING,
      submittedAt: { $ne: null }, providers: { $size: 0 } },
      { $set: { providers: accountIds, runningPrice: String(runningPrice) } }, { returnDocument: 'after' });
    if (!claimed) throw new Error(`Job ${job.id} is no longer waiting.`);
    try {
      // Persist before broadcasting: providers fetch their manifest on selection.
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $addToSet: { takenJobs: claimed._id } });
      await this.chain?.assignProviders(claimed.onChainJobId, providers.map(p => p.wallet));
    } catch (error) {
      await JobModel.updateOne({ _id: claimed._id }, { $set: { providers: [], runningPrice: '0' } });
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $pull: { takenJobs: claimed._id } });
      throw error;
    }
  }
}
