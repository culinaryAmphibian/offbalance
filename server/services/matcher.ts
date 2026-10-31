import { Types } from 'mongoose';
import { validatePricingQuote } from '../pricing.ts';
import { parseEthAmount, formatEthAmount, quoteProviders } from '../matching/MatchingEngine.ts';
import { AccountModel, JobModel, JobStatus } from '../models/index.ts';
import { MongoRepository } from '../adapters/repository.ts';
import { MatchManager } from '../matching/MatchManager.ts';
import type { AvailableProvider, SchedulingJob } from '../matching/types.ts';
import type { Chain } from './chain.ts';

export class Matcher {
  readonly repository: MongoRepository;
  readonly manager: MatchManager;
  private queue: Promise<void> = Promise.resolve();
  private chain: Pick<Chain, 'assignProviders' | 'getJobTerms'> | null;
  private now: () => number;

  constructor(chain: Pick<Chain, 'assignProviders' | 'getJobTerms'> | null, { now = Date.now, heartbeatTimeoutMs = 30_000 } = {}) {
    this.chain = chain;
    this.now = now;
    this.repository = new MongoRepository();
    this.manager = new MatchManager({ repository: this.repository, now, heartbeatTimeoutMs,
      onMatched: (job, providers) => this.assign(job, providers) });
  }

  async validateSubmission(jobId: number): Promise<boolean> {
    const job = await JobModel.findOne({ onChainJobId: jobId });
    if (!job) return false;
    let error: string | null = null;
    try { validatePricingQuote(job); }
    catch (reason) { error = String(reason); }
    if (!error && this.chain && !job.buyerWallet) error = 'Buyer wallet is not pinned; explicit draft ownership is required before funding.';
    if (!error && this.chain) {
      // RPC failures propagate for retry; a successfully read mismatched job is rejected permanently.
      const terms = await this.chain.getJobTerms(jobId);
      const quote = validatePricingQuote(job);
      if (terms.creator.toLowerCase() !== job.buyerWallet?.toLowerCase() ||
          terms.maxHourlyRate !== BigInt(quote.maxHourlyRateWei) || terms.k !== BigInt(quote.k) ||
          terms.quorum !== BigInt(job.minNodesToAgree) || terms.executionTime !== BigInt(quote.window) ||
          terms.dockerImage !== job.dockerImageDigest || terms.escrow !== BigInt(quote.totalEscrowWei)) {
        error = 'On-chain funding terms do not match the pinned buyer and booked-window quote.';
      }
    }
    await JobModel.updateOne({ _id: job._id }, { $set: { submissionValidationError: error } });
    return error === null;
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
      submittedAt: { $ne: null }, submissionValidationError: null, providers: { $size: 0 } }).sort({ createdAt: 1 });
    for (const job of waiting) {
      if (await this.validateSubmission(job.onChainJobId)) await this.manager.onJobSubmitted(String(job.onChainJobId));
    }
    await this.manager.matchNext();
  }

  private async assign(job: SchedulingJob, providers: AvailableProvider[]): Promise<void> {
    const accountIds = providers.map(p => p.accountId);
    if (!await this.validateSubmission(Number(job.id))) throw new Error('Job funding terms failed validation before assignment.');
    const quote = quoteProviders(job, providers);
    const rates = quote.providers.map(p => BigInt(p.rateWei));
    const cap = parseEthAmount(String(job.hourlyCeiling));
    if (rates.some(rate => rate <= 0n || rate > cap)) throw new Error('Assigned hourly rate exceeds the job cap.');
    const runningPrice = formatEthAmount(rates.reduce((max, rate) => rate > max ? rate : max, 0n));
    const assignedRates = providers.map((p, i) => ({ provider: p.accountId, wallet: p.wallet.toLowerCase(),
      hourlyRate: p.pricePerHour, hourlyRateWei: quote.providers[i].rateWei, charge: quote.providers[i].cost, chargeWei: quote.providers[i].costWei }));
    const claimed = await JobModel.findOneAndUpdate({ onChainJobId: Number(job.id), status: JobStatus.PENDING,
      submittedAt: { $ne: null }, submissionValidationError: null, providers: { $size: 0 } },
      { $set: { providers: accountIds, runningPrice, assignedRates, quotedTotal: Types.Decimal128.fromString(quote.totalPrice) } }, { returnDocument: 'after' });
    if (!claimed) throw new Error(`Job ${job.id} is no longer waiting.`);
    try {
      // Persist before broadcasting: providers fetch their manifest on selection.
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $addToSet: { takenJobs: claimed._id } });
      await this.chain?.assignProviders(claimed.onChainJobId, providers.map(p => p.wallet), rates);
    } catch (error) {
      await JobModel.updateOne({ _id: claimed._id }, { $set: { providers: [], runningPrice: '0', assignedRates: [], quotedTotal: '0' } });
      await AccountModel.updateMany({ _id: { $in: accountIds } }, { $pull: { takenJobs: claimed._id } });
      throw error;
    }
  }
}
