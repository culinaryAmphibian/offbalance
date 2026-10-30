import { AccountModel, JobModel, JobStatus } from '../models/index.ts';
import { MongoRepository } from '../adapters/repository.ts';
import { MatchManager } from '../matching/MatchManager.ts';
import type { AvailableProvider, SchedulingJob } from '../matching/types.ts';
import type { Chain } from './chain.ts';
import { uncertainTransaction, TransactionNotBroadcastError, TransactionRevertedError } from './transactions.ts';

export class Matcher {
  readonly repository: MongoRepository;
  readonly manager: MatchManager;
  private queue: Promise<void> = Promise.resolve();
  private chain: (Pick<Chain, 'assignProviders'> & Partial<Pick<Chain, 'getAssignedProviders' | 'getDeadlines'>>) | null;
  private now: () => number;

  constructor(chain: (Pick<Chain, 'assignProviders'> & Partial<Pick<Chain, 'getAssignedProviders' | 'getDeadlines'>>) | null, { now = Date.now, heartbeatTimeoutMs = 30_000 } = {}) {
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

  recoverAssignments(): Promise<void> {
    const pending = this.queue.catch(() => {}).then(() => this.recoverClaims());
    this.queue = pending;
    return pending;
  }

  private async recoverClaims(): Promise<void> {
    const claims = await JobModel.find({ 'providers.0': { $exists: true },
      $or: [{ assignmentState: 'pending' }, { status: JobStatus.PENDING }] });
    for (const job of claims) {
      // Old claims lack a wallet snapshot. Never invent a replacement identity on restart.
      if (!job.assignmentWallets.length) {
        console.warn(`Job ${job.onChainJobId}: assignment has no persisted wallet roster; retaining for reconciliation.`);
        continue;
      }
      try {
        await AccountModel.updateMany({ _id: { $in: job.providers } }, { $addToSet: { takenJobs: job._id } }, { writeConcern: { w: 'majority', j: true } });
        const assigned = await this.chain?.getAssignedProviders?.(job.onChainJobId);
        if (assigned?.length) {
          if (assigned.length !== job.assignmentWallets.length || assigned.some((wallet, i) => wallet.toLowerCase() !== job.assignmentWallets[i].toLowerCase())) {
            throw new Error(`Job ${job.onChainJobId}: on-chain assignment differs from the persisted claim.`);
          }
        } else {
          // Same intent reuses its journaled signed transaction after a lost response or restart.
          await this.chain?.assignProviders(job.onChainJobId, job.assignmentWallets);
        }
        await JobModel.updateOne({ _id: job._id }, { $set: { assignmentState: 'confirmed' } });
      } catch (error) {
        if (error instanceof TransactionRevertedError || error instanceof TransactionNotBroadcastError) {
          await JobModel.updateOne({ _id: job._id }, { $set: { providers: [], assignmentWallets: [], assignmentState: 'pending', runningPrice: '0' } });
          await AccountModel.updateMany({ _id: { $in: job.providers } }, { $pull: { takenJobs: job._id } }, { writeConcern: { w: 'majority', j: true } });
          this.release(job.onChainJobId);
          continue;
        }
        // RPC/journal errors cannot prove an assignment failed. Preserve the durable exclusion.
        console.warn(`Job ${job.onChainJobId}: assignment recovery is unresolved; retaining providers.`, error);
      }
    }
  }

  private async run(): Promise<void> {
    await this.recoverClaims();
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
      { $set: { providers: accountIds, runningPrice: String(runningPrice), assignmentWallets: providers.map(p => p.wallet), assignmentState: 'pending' } }, { returnDocument: 'after' });
    if (!claimed) throw new Error(`Job ${job.id} is no longer waiting.`);
    let assignmentSent = false;
    try {
      // Persist before broadcasting: providers fetch their manifest on selection.
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $addToSet: { takenJobs: claimed._id } }, { writeConcern: { w: 'majority', j: true } });
      await this.chain?.assignProviders(claimed.onChainJobId, providers.map(p => p.wallet));
      assignmentSent = true;
      await JobModel.updateOne({ _id: claimed._id }, { $set: { assignmentState: 'confirmed' } });
    } catch (error) {
      if (assignmentSent || uncertainTransaction(error)) {
        console.warn(`Job ${job.id}: transaction outcome is unresolved; retaining assignment.`);
        return; // MatchManager keeps its reservation; recovery retries the identical signed bytes.
      }
      await JobModel.updateOne({ _id: claimed._id }, { $set: { providers: [], runningPrice: '0', assignmentWallets: [], assignmentState: 'pending' } });
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $pull: { takenJobs: claimed._id } }, { writeConcern: { w: 'majority', j: true } });
      throw error;
    }
  }
}
