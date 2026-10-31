import { isValidObjectId } from 'mongoose';
import { decimalString } from '../models/decimal.ts';
import { AccountModel, HardwareModel, JobModel, JobStatus, TERMINAL_STATUSES, type Hardware, type Job } from '../models/index.ts';
import { validatePricingQuote } from '../pricing.ts';
import { parseEthAmount } from '../matching/MatchingEngine.ts';
import type { MatchRepository, ProviderRecord, SchedulingJob } from '../matching/types.ts';
import type { Assignment, AssignmentRepository, JobId } from '../agent-manager/types.ts';

export function numericJobId(id: JobId): number | null {
  const value = String(id);
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Decimal128 and legacy numeric data share the stored decimal value; no float arithmetic. */
export function hourlyPrice(price: Parameters<typeof decimalString>[0]): string {
  return decimalString(price);
}

export function schedulingJob(job: Job): SchedulingJob {
  const pricing = validatePricingQuote(job);
  return {
    id: String(job.onChainJobId), owner: String(job.owner), k: pricing.k,
    quorum: job.minNodesToAgree, window: pricing.window, maxPrice: pricing.totalEscrow,
    createdAt: job.createdAt.toISOString(), requirements: { minCpuScore: job.requirements?.minCpuScore ?? 0, minGpuScore: job.requirements?.minGpuScore ?? 0, minMemoryScore: job.requirements?.minMemoryScore ?? 0 },
    hourlyCeiling: pricing.maxHourlyRate,
  };
}

function providerRecord(hw: Hardware, busyJobId: string | null): ProviderRecord {
  return {
    id: String(hw.userRef), accountId: String(hw.userRef), wallet: hw.address, registered: true,
    ...(hw.price == null ? {} : { pricePerHour: hourlyPrice(hw.price) }),
    machine: { cpuScore: hw.cpuScore, gpuScore: hw.gpuScore, memoryScore: hw.memoryScore },
    busyJobId,
  };
}

export class MongoRepository implements MatchRepository, AssignmentRepository {
  async getJob(id: string): Promise<SchedulingJob | null> {
    const number = numericJobId(id);
    if (number === null) return null;
    const job = await JobModel.findOne({ onChainJobId: number, status: JobStatus.PENDING,
      submittedAt: { $ne: null }, submissionValidationError: null, providers: { $size: 0 } });
    if (!job) return null;
    try { return schedulingJob(job); }
    catch (error) {
      await JobModel.updateOne({ _id: job._id }, { $set: { submissionValidationError: String(error) } });
      return null;
    }
  }

  async listProviders(job: SchedulingJob): Promise<ProviderRecord[]> {
    const busy = await JobModel.distinct('providers', { status: { $nin: TERMINAL_STATUSES } });
    const hardware = await HardwareModel.find({ userRef: { $nin: [...busy, job.owner] }, price: { $ne: null } });
    const accounts = await AccountModel.find({ _id: { $in: hardware.map(hw => hw.userRef) } }, 'walletIds');
    const wallets = new Map(accounts.map(account => [String(account._id), new Set(account.walletIds)]));
    const ceiling = parseEthAmount(String(job.hourlyCeiling));
    return hardware.flatMap(hw => {
      if (!wallets.get(String(hw.userRef))?.has(hw.address)) return [];
      try { const rate = parseEthAmount(hourlyPrice(hw.price!)); return rate > 0n && rate <= ceiling ? [providerRecord(hw, null)] : []; }
      catch { console.warn(`Ignoring unsupported hourly price for hardware ${hw._id}`); return []; }
    });
  }

  async getProvider(wallet: string): Promise<ProviderRecord | null> {
    const hw = await HardwareModel.findOne({ address: wallet.toLowerCase() });
    if (!hw || !(await AccountModel.exists({ _id: hw.userRef, walletIds: hw.address }))) return null;
    const active = await JobModel.findOne({ providers: hw.userRef, status: { $nin: TERMINAL_STATUSES } });
    return providerRecord(hw, active ? String(active.onChainJobId) : null);
  }

  async getAssignedJob(id: JobId, providerId: string): Promise<Assignment | null> {
    const number = numericJobId(id);
    if (number === null || !isValidObjectId(providerId)) return null;
    const job = await JobModel.findOne({ onChainJobId: number, providers: providerId });
    return job ? { id: String(job.onChainJobId), dockerImage: job.dockerImageDigest,
      requirements: { minCpuScore: job.requirements?.minCpuScore ?? 0, minGpuScore: job.requirements?.minGpuScore ?? 0, minMemoryScore: job.requirements?.minMemoryScore ?? 0 }, window: job.timeWindow } : null;
  }

  async getActiveAssignment(providerId: string): Promise<Assignment | null> {
    if (!isValidObjectId(providerId)) return null;
    const job = await JobModel.findOne({ providers: providerId, status: { $nin: TERMINAL_STATUSES } });
    return job ? this.getAssignedJob(job.onChainJobId, providerId) : null;
  }
}
