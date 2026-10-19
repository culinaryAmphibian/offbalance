import { JobQueue } from './JobQueue.js';
import { ProviderPoolCache } from './ProviderPoolCache.js';
import { MatchingEngine, parseEthAmount } from './MatchingEngine.js';

const key = wallet => wallet.toLowerCase();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requirePort = (value, name) => {
  if (typeof value !== 'function') throw new TypeError(`MatchManager requires ${name}.`);
};

/** Repository-backed scheduling; persistence and chain transactions belong to callers. */
export class MatchManager {
  #tail = Promise.resolve();
  #candidates = new Map();
  #assigned = new Set();

  constructor({ repository, onMatched, pool, queue, now = () => Date.now(), heartbeatTimeoutMs = 30_000, enabled = true } = {}) {
    requirePort(repository?.getJob, 'repository.getJob(jobId)');
    requirePort(repository?.listProviders, 'repository.listProviders(job)');
    requirePort(onMatched, 'onMatched(job, providers, quote)');
    this.repository = repository;
    this.pool = pool ?? new ProviderPoolCache({ now, heartbeatTimeoutMs });
    this.queue = queue ?? new JobQueue();
    this.engine = new MatchingEngine({ queue: this.queue, pool: this.pool, now, enabled,
      onMatched: async (...args) => { await onMatched(...args); this.#assigned.add(args[0].id); },
      providerFilter: (job, provider) => this.#candidates.get(job.id)?.has(key(provider.wallet)) === true });
  }

  #exclusive(action) {
    const pending = this.#tail.catch(() => {}).then(action);
    this.#tail = pending;
    return pending;
  }

  async #load(id) {
    const job = await this.repository.getJob(id);
    if (job == null) return null;
    if (!object(job) || job.id !== id || typeof job.owner !== 'string' ||
        !Number.isSafeInteger(job.k) || job.k <= 0 || !Number.isSafeInteger(job.window) || job.window <= 0 ||
        typeof job.createdAt !== 'string' || !Number.isFinite(Date.parse(job.createdAt))) {
      throw new TypeError('MatchManager repository.getJob must return a scheduling job with matching id, owner, positive k/window, and ISO createdAt.');
    }
    parseEthAmount(job.maxPrice);
    const providers = await this.repository.listProviders(job);
    if (!Array.isArray(providers) || providers.some(provider => !object(provider) ||
        typeof provider.wallet !== 'string' || !provider.wallet ||
        typeof provider.accountId !== 'string' || !provider.accountId ||
        typeof (provider.id ?? provider.accountId) !== 'string' || !(provider.id ?? provider.accountId))) {
      throw new TypeError('MatchManager repository.listProviders must return provider records with wallet, accountId, and optional id.');
    }
    return { job: structuredClone(job), providers: structuredClone(providers) };
  }

  #apply({ job, providers }) {
    this.#candidates.set(job.id, new Set(providers.map(provider => key(provider.wallet))));
    for (const provider of providers) {
      const live = this.pool.get(provider.wallet);
      this.pool.register({ ...provider, registered: provider.registered === true,
        // A database record or a fresh benchmark report cannot establish liveness.
        lastHeartbeat: live?.lastHeartbeat ?? 0,
        busyJobId: live?.busyJobId ?? provider.busyJobId ?? null });
    }
  }

  async findMatchingScores(jobId) {
    return this.#exclusive(async () => {
      const snapshot = await this.#load(jobId);
      if (!snapshot) throw new Error(`MatchManager job not found: ${jobId}`);
      this.#apply(snapshot);
      return this.engine.findTopK(snapshot.job).map(provider => provider.id ?? provider.accountId);
    });
  }

  async #scan() {
    // Load all snapshots first: repository failures cannot dispatch stale cache data.
    const snapshots = [];
    for (const queued of this.queue.getPending()) snapshots.push({ id: queued.id,
      snapshot: this.#assigned.has(queued.id) ? null : await this.#load(queued.id) });
    for (const { id, snapshot } of snapshots) {
      this.queue.remove(id);
      if (snapshot) { this.#apply(snapshot); this.queue.add(snapshot.job); }
      else this.#candidates.delete(id);
    }
    return this.engine.matchNext();
  }

  onJobSubmitted(jobId) {
    return this.#exclusive(async () => {
      if (this.#assigned.has(jobId)) return [];
      const snapshot = await this.#load(jobId);
      if (!snapshot) throw new Error(`MatchManager job not found: ${jobId}`);
      this.#apply(snapshot);
      this.queue.remove(jobId);
      this.queue.add(snapshot.job);
      return this.#scan();
    });
  }

  matchNext() { return this.#exclusive(() => this.#scan()); }
  onProviderUpdated(_wallet) { return this.matchNext(); }
  onMachineSpecsUpdated(wallet) { return this.onProviderUpdated(wallet); }
  forgetAssignment(jobId) {
    this.#assigned.delete(jobId);
    this.#candidates.delete(jobId);
    return this.engine.forgetAssignment(jobId);
  }
}

export default MatchManager;
