import { isValidObjectId } from 'mongoose';
import { decimalString } from '../models/decimal.ts';
import { AccountModel, HardwareModel, JobModel, JobStatus, TERMINAL_STATUSES, type Hardware, type Job } from '../models/index.ts';
import { formatEthAmount, parseEthAmount } from '../matching/MatchingEngine.ts';
import type { MatchRepository, ProviderRecord, SchedulingJob } from '../matching/types.ts';
import type { Assignment, AssignmentRepository, JobId } from '../agent-manager/types.ts';

export function numericJobId(id: JobId): number | null {
  const value = String(id);
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

// Hardware.price is a Number in the database branch; expand scientific notation
// before passing its decimal value to the manager's integer-wei arithmetic.
export function hourlyPrice(price: number): string {
  if (!Number.isFinite(price) || price < 0) throw new TypeError('Invalid hourly price.');
  const decimal = decimalString(price);
  if (price > 0 && parseEthAmount(decimal) === 0n) throw new TypeError('Hourly price is below one wei.');
  return decimal;
}

export function schedulingJob(job: Job): SchedulingJob {
  const rate = parseEthAmount(decimalString(job.maxPrice ?? '0'));
  // DB API: each provider's hourly ceiling. Manager: total execution budget.
  // Round each provider's maximum cost up exactly as quoteProviders does.
  const budget = ((rate * BigInt(job.timeWindow) + 3599n) / 3600n) * BigInt(job.minNodesToRunOn);
  return {
    id: String(job.onChainJobId), owner: String(job.owner), k: job.minNodesToRunOn,
    quorum: job.minNodesToAgree, window: job.timeWindow, maxPrice: formatEthAmount(budget),
    createdAt: job.createdAt.toISOString(), requirements: { minCpuScore: job.requirements?.minCpuScore ?? 0, minGpuScore: job.requirements?.minGpuScore ?? 0, minMemoryScore: job.requirements?.minMemoryScore ?? 0 },
    hourlyCeiling: decimalString(job.maxPrice ?? '0'),
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
      submittedAt: { $ne: null }, providers: { $size: 0 } });
    return job ? schedulingJob(job) : null;
  }

  async listProviders(job: SchedulingJob): Promise<ProviderRecord[]> {
    const busy = await JobModel.distinct('providers', { status: { $nin: TERMINAL_STATUSES } });
    const hardware = await HardwareModel.find({ userRef: { $nin: [...busy, job.owner] }, price: { $ne: null } });
    const accounts = await AccountModel.find({ _id: { $in: hardware.map(hw => hw.userRef) } }, 'walletIds');
    const wallets = new Map(accounts.map(account => [String(account._id), new Set(account.walletIds)]));
    const ceiling = parseEthAmount(String(job.hourlyCeiling));
    return hardware.flatMap(hw => {
      if (!wallets.get(String(hw.userRef))?.has(hw.address)) return [];
      try { return parseEthAmount(hourlyPrice(hw.price!)) <= ceiling ? [providerRecord(hw, null)] : []; }
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
