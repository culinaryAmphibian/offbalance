import { EventFragment, Interface, getAddress, type InterfaceAbi, type Result } from 'ethers';

type Awaitable<T> = T | PromiseLike<T>;

export interface Checkpoint {
  blockNumber: number;
  blockHash: string | null;
}

export interface CheckpointStore {
  load(): Awaitable<Checkpoint | null>;
  save(checkpoint: Checkpoint): Awaitable<void>;
}

export interface RpcBlock {
  number: number;
  hash: string | null;
}

export interface RpcLog {
  address: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  index?: number;
  logIndex?: number;
  removed?: boolean;
  topics: readonly string[];
  data: string;
}

export interface LogFilter { address: string; fromBlock: number; toBlock: number }

/** Compatible with ethers providers without granting any signing or write capability. */
export interface ReadonlyProvider {
  getBlockNumber(): Awaitable<number>;
  getBlock(number: number): Awaitable<RpcBlock | null>;
  getLogs(filter: LogFilter): Awaitable<readonly RpcLog[]>;
}

export interface MonitorEvent {
  id: string;
  chainId: string;
  address: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  name: string;
  signature: string;
  args: Result;
}

export interface ReorgDetails { checkpoint: Checkpoint; actualBlockHash: string }
export interface ReorgPolicy { rewindTo: number }
export interface PollResult {
  checkpoint: Checkpoint | null;
  processed: number;
  fromBlock?: number;
  toBlock?: number;
  rewound?: boolean;
}

export interface MonitorOptions {
  provider: ReadonlyProvider;
  address: string;
  abi: InterfaceAbi;
  chainId: string | number | bigint;
  checkpointStore: CheckpointStore;
  onEvent(event: MonitorEvent): Awaitable<void>;
  startBlock?: number;
  confirmations?: number;
  batchSize?: number;
  maxLogs?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  onError?(error: Error): Awaitable<void>;
  onReorg?(details: ReorgDetails): Awaitable<ReorgPolicy>;
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
function checkpointCopy(checkpoint: Checkpoint): Checkpoint;
function checkpointCopy(checkpoint: Checkpoint | null): Checkpoint | null;
function checkpointCopy(checkpoint: Checkpoint | null): Checkpoint | null {
  return checkpoint ? { ...checkpoint } : null;
}

function readonlyProvider(provider: ReadonlyProvider): ReadonlyProvider {
  if (!provider || typeof provider.getBlockNumber !== 'function' || typeof provider.getLogs !== 'function' || typeof provider.getBlock !== 'function') {
    throw new TypeError('A read-only provider with getBlockNumber, getLogs, and getBlock is required.');
  }
  return provider;
}

export class ReorgError extends Error {
  readonly checkpoint: Checkpoint;
  readonly actualBlockHash: string;

  constructor(message: string, details: ReorgDetails) {
    super(message);
    this.name = 'ReorgError';
    this.checkpoint = checkpointCopy(details.checkpoint);
    this.actualBlockHash = details.actualBlockHash;
  }
}

/** Read-only, single-process event monitor. Persistence and event effects belong to the caller. */
export class BlockchainMonitor {
  #tail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #running = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #checkpoint: Checkpoint | null = null;

  provider: ReadonlyProvider;
  readonly address: string;
  readonly interface: Interface;
  readonly chainId: string;
  readonly checkpointStore: CheckpointStore;
  readonly onEvent: MonitorOptions['onEvent'];
  readonly startBlock: number;
  readonly confirmations: number;
  readonly batchSize: number;
  readonly maxLogs: number;
  readonly pollIntervalMs: number;
  readonly maxBackoffMs: number;
  onError: NonNullable<MonitorOptions['onError']>;
  readonly onReorg: MonitorOptions['onReorg'];
  lastError: Error | null = null;

  constructor({ provider, address, abi, chainId, checkpointStore, onEvent, startBlock = 0,
    confirmations = 6, batchSize = 500, maxLogs = 10_000, pollIntervalMs = 1000,
    maxBackoffMs = 30_000, onError = () => {}, onReorg }: MonitorOptions) {
    this.provider = readonlyProvider(provider);
    this.address = getAddress(address);
    this.interface = new Interface(abi);
    if (!this.interface.fragments.some(fragment => fragment instanceof EventFragment && !fragment.anonymous)) {
      throw new TypeError('The contract owner must supply a nonanonymous event ABI.');
    }
    if (!/^[1-9]\d*$/.test(String(chainId)) || typeof chainId === 'number' && !integer(chainId, 1)) {
      throw new TypeError('An explicit positive chain ID is required.');
    }
    if (!checkpointStore || (typeof checkpointStore.load !== 'function' || typeof checkpointStore.save !== 'function') ||
      typeof onEvent !== 'function' || typeof onError !== 'function' || onReorg !== undefined && typeof onReorg !== 'function') {
      throw new TypeError('Provide checkpoint load/save functions and an event callback.');
    }
    if (!integer(startBlock) || !integer(confirmations) || !integer(batchSize, 1) || batchSize > 10_000 ||
      !integer(maxLogs, 1) || !integer(pollIntervalMs, 1) || !integer(maxBackoffMs, pollIntervalMs) || maxBackoffMs > 2_147_483_647) {
      throw new TypeError('Invalid monitor range, confirmation, or polling limits.');
    }
    this.chainId = String(chainId);
    this.checkpointStore = checkpointStore;
    this.onEvent = onEvent;
    this.startBlock = startBlock;
    this.confirmations = confirmations;
    this.batchSize = batchSize;
    this.maxLogs = maxLogs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.onError = onError;
    this.onReorg = onReorg;
  }

  get running() { return this.#running; }
  get checkpoint() { return checkpointCopy(this.#checkpoint); }

  reconnect(provider: ReadonlyProvider) { this.provider = readonlyProvider(provider); return this; }

  #check(generation: number, signal?: AbortSignal) {
    if (generation !== this.#generation || signal?.aborted) throw new DOMException('Monitoring stopped.', 'AbortError');
  }

  pollOnce({ signal }: { signal?: AbortSignal } = {}): Promise<PollResult> {
    const generation = this.#generation;
    const pending = this.#tail.then(() => this.#poll(generation, signal));
    this.#tail = pending.catch(() => {});
    return pending;
  }

  async #poll(generation: number, signal?: AbortSignal): Promise<PollResult> {
    const check = () => this.#check(generation, signal);
    check();
    const provider = this.provider; // Reconnects affect the next poll, never half of a range.
    const readBlock = async (number: number) => {
      const block = await provider.getBlock(number);
      check();
      if (!block || block.number !== number || !hash(block.hash)) throw new Error(`RPC did not return a valid block ${number}.`);
      return { ...block, hash: block.hash.toLowerCase() };
    };
    const saved = await this.checkpointStore.load();
    check();
    if (saved != null && (!integer(saved.blockNumber, this.startBlock - 1) ||
      saved.blockNumber >= 0 && !hash(saved.blockHash) || saved.blockNumber === -1 && saved.blockHash !== null)) {
      throw new TypeError('Invalid saved checkpoint.');
    }
    const cursor = saved == null ? { blockNumber: this.startBlock - 1, blockHash: null } :
      { blockNumber: saved.blockNumber, blockHash: saved.blockHash?.toLowerCase() ?? null };
    this.#checkpoint = checkpointCopy(saved == null ? null : cursor);
    if (cursor.blockHash) {
      const actual = await readBlock(cursor.blockNumber);
      if (actual.hash !== cursor.blockHash) {
        const details = { checkpoint: checkpointCopy(cursor), actualBlockHash: actual.hash };
        if (!this.onReorg) throw new ReorgError('Saved checkpoint is no longer canonical; explicit reconciliation is required.', details);
        const policy = await this.onReorg(details);
        check();
        if (!integer(policy?.rewindTo, this.startBlock - 1) || policy.rewindTo >= cursor.blockNumber) {
          throw new ReorgError('Reorg policy must explicitly rewind below the saved checkpoint.', details);
        }
        const rewind = { blockNumber: policy.rewindTo, blockHash: policy.rewindTo < 0 ? null : (await readBlock(policy.rewindTo)).hash };
        check();
        await this.checkpointStore.save(checkpointCopy(rewind));
        this.#checkpoint = rewind;
        return { checkpoint: checkpointCopy(rewind), processed: 0, rewound: true };
      }
    }
    const head = await provider.getBlockNumber();
    check();
    if (!integer(head) || saved != null && head < cursor.blockNumber) throw new Error('RPC head is invalid or behind the saved checkpoint.');
    const fromBlock = cursor.blockNumber + 1;
    const toBlock = Math.min(head - this.confirmations, fromBlock + this.batchSize - 1);
    if (toBlock < fromBlock) return { checkpoint: checkpointCopy(this.#checkpoint), processed: 0 };
    const boundary = await readBlock(toBlock);
    const logs = await provider.getLogs({ address: this.address, fromBlock, toBlock });
    check();
    if (!Array.isArray(logs) || logs.length > this.maxLogs) throw new Error('RPC log response exceeds the configured bounded range.');
    const blocks = new Map([[toBlock, boundary]]);
    const events = new Map<string, MonitorEvent>();
    for (const log of logs) {
      if (typeof log?.address !== 'string' || log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      const logIndex = log.index ?? log.logIndex;
      if (!integer(log.blockNumber) || log.blockNumber < fromBlock || log.blockNumber > toBlock ||
        !integer(log.transactionIndex) || !integer(logIndex) || !hash(log.blockHash) || !hash(log.transactionHash) || log.removed) {
        throw new Error('RPC returned a malformed or noncanonical contract log.');
      }
      if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, await readBlock(log.blockNumber));
      if (blocks.get(log.blockNumber)?.hash !== log.blockHash.toLowerCase()) throw new Error('RPC logs changed chain while reading; retry the uncommitted range.');
      const decoded = this.interface.parseLog({ topics: log.topics, data: log.data });
      if (!decoded) continue; // The supplied ABI defines the events owned by this integration.
      const id = [this.chainId, this.address.toLowerCase(), log.blockHash.toLowerCase(), log.transactionHash.toLowerCase(), logIndex].join(':');
      events.set(id, { id, chainId: this.chainId, address: this.address, blockNumber: log.blockNumber,
        blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(),
        transactionIndex: log.transactionIndex, logIndex, name: decoded.name, signature: decoded.signature, args: decoded.args });
    }
    if ((await readBlock(toBlock)).hash !== boundary.hash) throw new Error('RPC chain changed before callbacks; retry the uncommitted range.');
    const sorted = [...events.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
    for (const event of sorted) {
      check();
      await this.onEvent(event);
      check();
    }
    if ((await readBlock(toBlock)).hash !== boundary.hash) throw new Error('RPC chain changed during callbacks; reconcile and replay the uncommitted range.');
    const checkpoint = { blockNumber: toBlock, blockHash: boundary.hash };
    check();
    await this.checkpointStore.save(checkpointCopy(checkpoint));
    this.#checkpoint = checkpoint;
    return { checkpoint: checkpointCopy(checkpoint), fromBlock, toBlock, processed: sorted.length };
  }

  start() {
    if (this.#running) return this;
    this.#running = true;
    const generation = this.#generation;
    this.#loop = this.#run(generation);
    return this;
  }

  async #run(generation: number): Promise<void> {
    let failures = 0;
    try {
      while (this.#running && generation === this.#generation) {
        try { await this.pollOnce(); failures = 0; this.lastError = null; }
        catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          if (error.name === 'AbortError') break;
          this.lastError = error;
          try { await this.onError(error); } catch { /* Reporting cannot commit a failed range. */ }
          if (error instanceof ReorgError) break;
          failures += 1;
        }
        if (!this.#running || generation !== this.#generation) break;
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => { this.#wake = null; resolve(); }, Math.min(this.maxBackoffMs, this.pollIntervalMs * 2 ** Math.min(failures, 20)));
          this.#wake = () => { clearTimeout(timeout); this.#wake = null; resolve(); };
        });
      }
    } finally { if (generation === this.#generation) this.#running = false; }
  }

  async stop() {
    this.#running = false;
    this.#generation += 1;
    this.#wake?.();
    await Promise.allSettled([this.#loop, this.#tail]);
  }
}

export { BlockchainMonitor as ServerBlockchainManager };
export default BlockchainMonitor;
