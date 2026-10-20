import type { AvailableProvider, LiveProvider, MachineScores, ProviderRecord } from './types.ts';

const key = (wallet: string): string => String(wallet).toLowerCase();
const copy = (provider: LiveProvider | undefined): LiveProvider | null => provider ? structuredClone(provider) : null;
const priced = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value);
const validScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const machineReady = (machine: ProviderRecord['machine']): machine is MachineScores => Boolean(machine &&
  validScore(machine.cpuScore) && (validScore(machine.gpuScore) || machine.gpuScore === null) && validScore(machine.memoryScore));

export interface ProviderPoolOptions {
  now?: () => number;
  heartbeatTimeoutMs?: number;
}

/** A single coordinator's live provider sessions and atomic reservations. */
export class ProviderPoolCache {
  #providers = new Map<string, LiveProvider>();
  now: () => number;
  heartbeatTimeoutMs: number;

  constructor({ now = () => Date.now(), heartbeatTimeoutMs = 30_000 }: ProviderPoolOptions = {}) {
    this.now = now;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  register(provider: ProviderRecord): LiveProvider {
    if (!provider?.wallet) throw new TypeError('A provider needs a wallet.');
    const previous = this.#providers.get(key(provider.wallet));
    const next = {
      ...previous, ...structuredClone(provider),
      lastHeartbeat: provider.lastHeartbeat ?? this.now(),
      lastAssignedAt: previous?.lastAssignedAt ?? provider.lastAssignedAt ?? 0,
      // Reconnecting or reporting specs never silently abandons an assignment.
      busyJobId: previous?.busyJobId ?? provider.busyJobId ?? null,
    };
    this.#providers.set(key(provider.wallet), next);
    return structuredClone(next);
  }

  add(provider: ProviderRecord) { return this.register(provider); }
  get(wallet: string) { return copy(this.#providers.get(key(wallet))); }
  remove(wallet: string) { return this.#providers.delete(key(wallet)); }

  heartbeat(wallet: string) {
    const provider = this.#providers.get(key(wallet));
    if (!provider) return null;
    provider.lastHeartbeat = this.now();
    return copy(provider);
  }

  #available(provider: LiveProvider | undefined, now: number): provider is AvailableProvider {
    return provider !== undefined && provider.registered === true && Boolean(provider.accountId) && !provider.busyJobId &&
      priced(provider.pricePerHour) && machineReady(provider.machine) &&
      Number.isFinite(provider.lastHeartbeat) && provider.lastHeartbeat > 0 && provider.lastHeartbeat <= now &&
      now - provider.lastHeartbeat <= this.heartbeatTimeoutMs;
  }

  getAvailable() {
    const now = this.now();
    return [...this.#providers.values()].filter(provider => this.#available(provider, now)).map(provider => structuredClone(provider));
  }

  reserve(wallets: string[], jobId: string) {
    const keys = wallets.map(key);
    const now = this.now();
    if (!jobId || !keys.length || new Set(keys).size !== keys.length ||
        keys.some(wallet => !this.#available(this.#providers.get(wallet), now))) return false;
    for (const wallet of keys) {
      const provider = this.#providers.get(wallet)!;
      provider.busyJobId = jobId;
      provider.lastAssignedAt = now;
    }
    return true;
  }

  release(jobId: string) {
    let released = 0;
    for (const provider of this.#providers.values()) {
      if (provider.busyJobId === jobId) { provider.busyJobId = null; released += 1; }
    }
    return released;
  }

  markIdle(wallet: string) {
    const provider = this.#providers.get(key(wallet));
    if (!provider) return false;
    provider.busyJobId = null;
    return true;
  }

  markBusy(wallet: string, jobId: string) {
    const provider = this.#providers.get(key(wallet));
    if (!jobId || !provider || (provider.busyJobId && provider.busyJobId !== jobId)) return false;
    provider.busyJobId = jobId;
    provider.lastAssignedAt = this.now();
    return true;
  }
}

export default ProviderPoolCache;
