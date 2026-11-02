import type { JobQueue } from './JobQueue.ts';
import type { ProviderPoolCache } from './ProviderPoolCache.ts';
import type { AvailableProvider, Match, MatchCallback, MatchQuote, ProviderRecord, SchedulingJob } from './types.ts';

const WEI_PER_ETH = 10n ** 18n;
const compare = (a: string | number | bigint, b: string | number | bigint) => a < b ? -1 : a > b ? 1 : 0;

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parseEthAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value)) {
    throw new TypeError('ETH amounts must be nonnegative decimal strings with at most 18 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * WEI_PER_ETH + BigInt(fraction.padEnd(18, '0'));
}

export function formatEthAmount(wei: bigint): string {
  const fraction = String(wei % WEI_PER_ETH).padStart(18, '0').replace(/0+$/, '');
  return `${wei / WEI_PER_ETH}${fraction ? `.${fraction}` : ''}`;
}

/** The provider's GPUs that satisfy the job's GPU requirement, largest VRAM first. */
export function fittingGpus(job: SchedulingJob, provider: ProviderRecord) {
  const { gpu = 'none', minGpuVramGb = 0 } = job.requirements ?? {};
  if (gpu === 'none') return [];
  return (provider.machine?.gpus ?? []).filter(card => (gpu === 'any' || card.vendor === gpu) && card.vramGb >= minGpuVramGb)
    .sort((a, b) => b.vramGb - a.vramGb);
}

export function meetsRequirements(job: SchedulingJob, provider: ProviderRecord): boolean {
  if (!provider.machine || String(provider.accountId) === String(job.owner)) return false;
  const { minVcpus = 1, minMemoryGb = 0, gpu = 'none', minGpuVramGb = 0 } = job.requirements ?? {};
  if (!positive(minVcpus) || !nonNegative(minMemoryGb) || !nonNegative(minGpuVramGb)) return false;
  if (!['none', 'any', 'nvidia', 'amd'].includes(gpu)) return false;
  const { vcpus, memoryGb } = provider.machine;
  return positive(vcpus) && vcpus >= minVcpus && nonNegative(memoryGb) && memoryGb >= minMemoryGb &&
    (gpu === 'none' || fittingGpus(job, provider).length > 0);
}

export function scoreProvider(job: SchedulingJob, provider: AvailableProvider) {
  // headroom: how many times over the tightest requirement this machine is
  const { minVcpus = 1, minMemoryGb = 0, minGpuVramGb = 0 } = job.requirements ?? {};
  const ratios = [provider.machine.vcpus / minVcpus];
  if (minMemoryGb > 0) ratios.push(provider.machine.memoryGb / minMemoryGb);
  const gpu = fittingGpus(job, provider)[0];
  if (gpu && minGpuVramGb > 0) ratios.push(gpu.vramGb / minGpuVramGb);
  return {
    rateWei: parseEthAmount(provider.pricePerHour),
    headroom: Math.min(...ratios),
    lastAssignedAt: provider.lastAssignedAt ?? 0,
    wallet: provider.wallet.toLowerCase(),
  };
}

/** Change ranking here without changing queue/reservation behavior. */
export function compareProviders(job: SchedulingJob, a: AvailableProvider, b: AvailableProvider) {
  const left = scoreProvider(job, a);
  const right = scoreProvider(job, b);
  return compare(left.rateWei, right.rateWei) || compare(right.headroom, left.headroom) ||
    compare(left.lastAssignedAt, right.lastAssignedAt) || compare(left.wallet, right.wallet);
}

export function quoteProviders(job: SchedulingJob, providers: AvailableProvider[]): MatchQuote {
  if (!Number.isSafeInteger(job.window) || job.window <= 0) throw new TypeError('Execution window must be positive integer seconds.');
  const quotes = providers.map(provider => {
    const rateWei = parseEthAmount(provider.pricePerHour);
    const costWei = (rateWei * BigInt(job.window) + 3599n) / 3600n;
    return { wallet: provider.wallet, rateWei: String(rateWei), pricePerHour: provider.pricePerHour, costWei: String(costWei), cost: formatEthAmount(costWei) };
  });
  const total = quotes.reduce((sum, provider) => sum + BigInt(provider.costWei), 0n);
  return { totalWei: String(total), totalPrice: formatEthAmount(total), providers: quotes };
}

export interface MatchingEngineOptions {
  queue: JobQueue;
  pool: ProviderPoolCache;
  onMatched?: MatchCallback;
  now?: () => number;
  enabled?: boolean;
  providerFilter?: (job: SchedulingJob, provider: AvailableProvider) => boolean;
}

/** Internal top-k scheduling; each provider can hold one active assignment. */
export class MatchingEngine {
  #running: Promise<Match[]> | null = null;
  #rescan = false;
  #assignments = new Map<string, Match>();
  queue: JobQueue;
  pool: ProviderPoolCache;
  onMatched: MatchCallback;
  now: () => number;
  enabled: boolean;
  providerFilter: (job: SchedulingJob, provider: AvailableProvider) => boolean;

  constructor({ queue, pool, onMatched = async () => {}, now = () => Date.now(), enabled = true, providerFilter = () => true }: MatchingEngineOptions) {
    this.queue = queue;
    this.pool = pool;
    this.onMatched = onMatched;
    this.now = now;
    this.enabled = enabled;
    this.providerFilter = providerFilter;
  }

  meetsRequirements(job: SchedulingJob, provider: ProviderRecord): boolean { return meetsRequirements(job, provider); }
  scoreProvider(job: SchedulingJob, provider: AvailableProvider) { return scoreProvider(job, provider); }

  findTopK(job: SchedulingJob, k = job.k): AvailableProvider[] {
    if (!Number.isSafeInteger(k) || k <= 0) return [];
    return this.pool.getAvailable().filter(provider => this.providerFilter(job, provider) && this.meetsRequirements(job, provider))
      .sort((a, b) => compareProviders(job, a, b)).slice(0, k);
  }

  async enqueue(job: SchedulingJob) {
    this.queue.add(job);
    return this.matchNext();
  }

  matchNext(): Promise<Match[]> {
    if (!this.enabled) return Promise.resolve([]);
    if (this.#running) { this.#rescan = true; return this.#running; }
    // Defer scanning until the shared promise exists, including reentrant callbacks.
    this.#running = Promise.resolve().then(async () => {
      const matches: Match[] = [];
      do {
        this.#rescan = false;
        for (const job of this.queue.getPending()) {
          const providers = this.findTopK(job);
          if (!providers.length || providers.length !== job.k) continue;
          const quote = quoteProviders(job, providers);
          if (BigInt(quote.totalWei) > parseEthAmount(job.maxPrice)) continue;
          if (!this.pool.reserve(providers.map(provider => provider.wallet), job.id)) continue;
          try {
            await this.onMatched(job, providers, quote);
          } catch (error) {
            this.pool.release(job.id);
            throw error;
          }
          const match = { job, providers, quote };
          this.#assignments.set(job.id, match);
          this.queue.remove(job.id);
          matches.push(match);
        }
      } while (this.#rescan);
      return matches;
    }).finally(() => { this.#running = null; });
    return this.#running;
  }

  async handleProviderFailure(jobId: string, wallet: string) {
    const assignment = this.#assignments.get(jobId);
    if (!assignment || !assignment.providers.some(provider => provider.wallet.toLowerCase() === wallet.toLowerCase())) return [];
    this.#assignments.delete(jobId);
    this.pool.release(jobId);
    this.pool.remove(wallet);
    this.queue.add(assignment.job);
    return this.matchNext();
  }

  forgetAssignment(jobId: string) { return this.#assignments.delete(jobId); }
}

export default MatchingEngine;
