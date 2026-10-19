const WEI_PER_ETH = 10n ** 18n;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const requirementFields = [['minCpuScore', 'cpuScore'], ['minGpuScore', 'gpuScore'], ['minMemoryScore', 'memoryScore']];

export function parseEthAmount(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(value)) {
    throw new TypeError('ETH amounts must be nonnegative decimal strings with at most 18 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * WEI_PER_ETH + BigInt(fraction.padEnd(18, '0'));
}

export function formatEthAmount(wei) {
  const fraction = String(wei % WEI_PER_ETH).padStart(18, '0').replace(/0+$/, '');
  return `${wei / WEI_PER_ETH}${fraction ? `.${fraction}` : ''}`;
}

export function meetsRequirements(job, provider) {
  if (!provider.machine || String(provider.accountId) === String(job.owner)) return false;
  return requirementFields.every(([required, hardware]) => {
    const minimum = job.requirements?.[required] ?? 0;
    const measured = provider.machine[hardware];
    if (!Number.isSafeInteger(minimum) || minimum < 0) return false;
    if (hardware === 'gpuScore' && measured === null) return minimum === 0;
    return Number.isFinite(measured) && measured <= Number.MAX_SAFE_INTEGER && measured >= minimum;
  });
}

export function scoreProvider(job, provider) {
  const ratios = requirementFields.filter(([required]) => (job.requirements?.[required] ?? 0) > 0)
    .map(([required, hardware]) => provider.machine[hardware] / job.requirements[required]);
  return {
    rateWei: parseEthAmount(provider.pricePerHour),
    headroom: ratios.length ? Math.min(...ratios) : 0,
    lastAssignedAt: provider.lastAssignedAt ?? 0,
    wallet: provider.wallet.toLowerCase(),
  };
}

/** Change ranking here without changing queue/reservation behavior. */
export function compareProviders(job, a, b) {
  const left = scoreProvider(job, a);
  const right = scoreProvider(job, b);
  return compare(left.rateWei, right.rateWei) || compare(right.headroom, left.headroom) ||
    compare(left.lastAssignedAt, right.lastAssignedAt) || compare(left.wallet, right.wallet);
}

export function quoteProviders(job, providers) {
  if (!Number.isSafeInteger(job.window) || job.window <= 0) throw new TypeError('Execution window must be positive integer seconds.');
  const quotes = providers.map(provider => {
    const rateWei = parseEthAmount(provider.pricePerHour);
    const costWei = (rateWei * BigInt(job.window) + 3599n) / 3600n;
    return { wallet: provider.wallet, rateWei: String(rateWei), pricePerHour: provider.pricePerHour, costWei: String(costWei), cost: formatEthAmount(costWei) };
  });
  const total = quotes.reduce((sum, provider) => sum + BigInt(provider.costWei), 0n);
  return { totalWei: String(total), totalPrice: formatEthAmount(total), providers: quotes };
}

/** Internal top-k scheduling; each provider can hold one active assignment. */
export class MatchingEngine {
  #running = null;
  #rescan = false;
  #assignments = new Map();

  constructor({ queue, pool, onMatched = async () => {}, now = () => Date.now(), enabled = true, providerFilter = () => true }) {
    this.queue = queue;
    this.pool = pool;
    this.onMatched = onMatched;
    this.now = now;
    this.enabled = enabled;
    this.providerFilter = providerFilter;
  }

  meetsRequirements(job, provider) { return meetsRequirements(job, provider); }
  scoreProvider(job, provider) { return scoreProvider(job, provider); }

  findTopK(job, k = job.k) {
    if (!Number.isSafeInteger(k) || k <= 0) return [];
    return this.pool.getAvailable().filter(provider => this.providerFilter(job, provider) && this.meetsRequirements(job, provider))
      .sort((a, b) => compareProviders(job, a, b)).slice(0, k);
  }

  async enqueue(job) {
    this.queue.add(job);
    return this.matchNext();
  }

  matchNext() {
    if (!this.enabled) return Promise.resolve([]);
    if (this.#running) { this.#rescan = true; return this.#running; }
    // Defer scanning until the shared promise exists, including reentrant callbacks.
    this.#running = Promise.resolve().then(async () => {
      const matches = [];
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

  async handleProviderFailure(jobId, wallet) {
    const assignment = this.#assignments.get(jobId);
    if (!assignment || !assignment.providers.some(provider => provider.wallet.toLowerCase() === wallet.toLowerCase())) return [];
    this.#assignments.delete(jobId);
    this.pool.release(jobId);
    this.pool.remove(wallet);
    this.queue.add(assignment.job);
    return this.matchNext();
  }

  forgetAssignment(jobId) { return this.#assignments.delete(jobId); }
}

export default MatchingEngine;
