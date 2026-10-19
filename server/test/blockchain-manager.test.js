import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { BlockchainMonitor, ServerBlockchainManager, ReorgError } from '../blockchain-manager/index.js';

// Event declarations are supplied by the contract owner; no contract/wallet/RPC is deployed here.
const abi = [
  'event JobAssigned(uint256 indexed jobId, address indexed provider)',
  'event JobStatusChanged(uint256 indexed jobId, uint8 status)',
];
const address = '0x1111111111111111111111111111111111111111';
const otherAddress = '0x2222222222222222222222222222222222222222';
const iface = new Interface(abi);
const hash = number => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(options = {}) {
  let checkpoint = options.checkpoint ?? null;
  const delivered = [];
  const queries = [];
  const saves = [];
  const blocks = new Map(Array.from({ length: 30 }, (_, number) => [number, { number, hash: hash(number + 1) }]));
  const logs = [];
  const provider = {
    async getBlockNumber() { return options.head ?? 8; },
    async getBlock(number) { return blocks.get(number) ?? null; },
    async getLogs(query) { queries.push(query); return logs.filter(log => log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock); },
  };
  const checkpointStore = {
    async load() { return checkpoint && { ...checkpoint }; },
    async save(value) { checkpoint = { ...value }; saves.push({ ...value }); },
  };
  const monitor = new BlockchainMonitor({ provider, address, abi, chainId: 31337, checkpointStore,
    onEvent: event => { delivered.push(event); }, confirmations: 2, batchSize: 3, ...options });
  function event(blockNumber, logIndex = 0, eventName = 'JobAssigned') {
    const encoded = iface.encodeEventLog(iface.getEvent(eventName), eventName === 'JobAssigned' ? [42n, otherAddress] : [42n, 3]);
    return { address, blockNumber, blockHash: blocks.get(blockNumber).hash, transactionHash: hash(1000 + blockNumber),
      transactionIndex: 0, index: logIndex, removed: false, ...encoded };
  }
  return { monitor, provider, checkpointStore, delivered, queries, saves, blocks, logs, event, checkpoint: () => checkpoint };
}

test('construction is inert and exposes only a read-only monitor, including its compatibility export', () => {
  const f = fixture();
  assert.equal(ServerBlockchainManager, BlockchainMonitor);
  assert.equal(f.monitor.running, false);
  assert.equal(f.monitor.checkpoint, null);
  assert.deepEqual(f.queries, []);
  for (const method of ['submitJob', 'assignProviders', 'validateReceipt', 'signReceipt', 'settle']) {
    assert.equal(f.monitor[method], undefined);
  }
});

test('confirmed bounded backfill sorts, decodes and deduplicates contract-owner event ABI logs', async () => {
  const f = fixture({ startBlock: 2 });
  const early = f.event(2, 2);
  const later = f.event(4, 0, 'JobStatusChanged');
  f.logs.push(later, early, { ...early }, f.event(6), f.event(7));
  const first = await f.monitor.pollOnce();
  assert.deepEqual(f.queries, [{ address, fromBlock: 2, toBlock: 4 }]);
  assert.equal(first.processed, 2);
  assert.deepEqual(f.delivered.map(event => [event.blockNumber, event.logIndex]), [[2, 2], [4, 0]]);
  assert.equal(f.delivered[0].name, 'JobAssigned');
  assert.equal(f.delivered[0].args.jobId, 42n);
  assert.equal(f.delivered[1].args.status, 3n);
  assert.equal(f.delivered[0].id, `31337:${address}:${early.blockHash}:${early.transactionHash}:2`);
  assert.deepEqual(f.checkpoint(), { blockNumber: 4, blockHash: hash(5) });
  const second = await f.monitor.pollOnce();
  assert.equal(second.processed, 1);
  assert.deepEqual(f.queries[1], { address, fromBlock: 5, toBlock: 6 });
  assert.equal((await f.monitor.pollOnce()).processed, 0);
  assert.equal(f.queries.length, 2, 'unconfirmed head is not queried');
});

test('saved cursor resumes on a new instance and empty ranges still advance', async () => {
  const f = fixture({ checkpoint: { blockNumber: 3, blockHash: hash(4) } });
  const first = await f.monitor.pollOnce();
  assert.equal(first.fromBlock, 4);
  assert.equal(first.toBlock, 6);
  const resumed = new BlockchainMonitor({ provider: f.provider, address, abi, chainId: 31337,
    checkpointStore: f.checkpointStore, onEvent() {}, confirmations: 0, batchSize: 1 });
  assert.equal((await resumed.pollOnce()).fromBlock, 7);
  assert.equal(f.checkpoint().blockNumber, 7);
  const copy = resumed.checkpoint;
  copy.blockNumber = 900;
  assert.equal(resumed.checkpoint.blockNumber, 7);
});

test('unknown ABI events and unrelated addresses are not delivered; malformed owned logs fail closed', async () => {
  const f = fixture();
  const owned = f.event(1);
  f.logs.push(owned, { ...owned, address: otherAddress, topics: null, data: 'invalid' },
    { ...f.event(2), topics: [hash(9999)], data: '0x' });
  assert.equal((await f.monitor.pollOnce()).processed, 1);
  assert.equal(f.delivered.length, 1);
  const broken = fixture();
  broken.logs.push({ ...broken.event(0), blockHash: hash(999) });
  await assert.rejects(broken.monitor.pollOnce(), /changed chain/);
  assert.equal(broken.checkpoint(), null);
  assert.deepEqual(broken.delivered, []);
});

test('callback failures never commit the range and replay uses stable event IDs', async () => {
  const seen = [];
  let fail = true;
  const f = fixture({ onEvent: event => {
    seen.push(event.id);
    if (event.logIndex === 1 && fail) { fail = false; throw new Error('Persistence temporarily unavailable.'); }
  } });
  f.logs.push(f.event(1, 1), f.event(1, 0));
  await assert.rejects(f.monitor.pollOnce(), /Persistence temporarily/);
  assert.equal(f.checkpoint(), null);
  assert.equal((await f.monitor.pollOnce()).processed, 2);
  assert.equal(seen[0], seen[2]);
  assert.equal(seen[1], seen[3]);
  assert.equal(f.saves.length, 1);
});

test('failed checkpoint persistence also replays callbacks rather than skipping events', async () => {
  const f = fixture();
  f.logs.push(f.event(1));
  const save = f.checkpointStore.save;
  f.checkpointStore.save = async () => { throw new Error('Checkpoint store unavailable.'); };
  await assert.rejects(f.monitor.pollOnce(), /Checkpoint store/);
  assert.equal(f.monitor.checkpoint, null);
  f.checkpointStore.save = save;
  await f.monitor.pollOnce();
  assert.equal(f.delivered.length, 2);
  assert.equal(f.delivered[0].id, f.delivered[1].id);
});

test('concurrent polls serialize cursor access and never overlap scanned ranges', async () => {
  const f = fixture({ confirmations: 0, batchSize: 2 });
  let active = 0;
  let peak = 0;
  const getLogs = f.provider.getLogs;
  f.provider.getLogs = async query => {
    active += 1; peak = Math.max(peak, active);
    await Promise.resolve();
    const logs = await getLogs(query);
    active -= 1;
    return logs;
  };
  await Promise.all([f.monitor.pollOnce(), f.monitor.pollOnce(), f.monitor.pollOnce()]);
  assert.equal(peak, 1);
  assert.deepEqual(f.queries.map(query => [query.fromBlock, query.toBlock]), [[0, 1], [2, 3], [4, 5]]);
});

test('checkpoint reorg halts by default without delivering events or changing persistence', async () => {
  const previous = { blockNumber: 3, blockHash: hash(400) };
  const f = fixture({ checkpoint: previous });
  await assert.rejects(f.monitor.pollOnce(), error => error instanceof ReorgError &&
    error.checkpoint.blockHash === hash(400) && error.actualBlockHash === hash(4));
  assert.deepEqual(f.checkpoint(), previous);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.delivered, []);
});

test('explicit external reconciliation can rewind and replay a reorg range', async () => {
  const reorgs = [];
  const f = fixture({ checkpoint: { blockNumber: 3, blockHash: hash(400) }, onReorg: async details => {
    reorgs.push(details); return { rewindTo: 1 };
  } });
  f.logs.push(f.event(2), f.event(3));
  const rewound = await f.monitor.pollOnce();
  assert.equal(rewound.rewound, true);
  assert.deepEqual(f.checkpoint(), { blockNumber: 1, blockHash: hash(2) });
  assert.deepEqual(f.delivered, []);
  assert.equal((await f.monitor.pollOnce()).processed, 2);
  assert.equal(reorgs.length, 1);
  assert.equal(f.delivered[0].blockNumber, 2);
  assert.equal(f.checkpoint().blockNumber, 4);
});

test('reorg callback must authorize an actual rewind rather than accepting a changed hash', async () => {
  const f = fixture({ checkpoint: { blockNumber: 3, blockHash: hash(400) }, onReorg: () => ({ rewindTo: 3 }) });
  await assert.rejects(f.monitor.pollOnce(), ReorgError);
  assert.deepEqual(f.saves, []);
});

test('provider errors preserve cursor and reconnect only affects subsequent polls', async () => {
  const f = fixture();
  const healthy = { ...f.provider };
  f.provider.getBlockNumber = async () => { throw new Error('RPC disconnected.'); };
  await assert.rejects(f.monitor.pollOnce(), /RPC disconnected/);
  assert.equal(f.checkpoint(), null);
  f.monitor.reconnect(healthy);
  assert.equal((await f.monitor.pollOnce()).toBlock, 2);
  assert.throws(() => f.monitor.reconnect({}), /read-only provider/);
});

test('polling bounds reject oversized responses and future deployment blocks remain idle', async () => {
  const f = fixture({ maxLogs: 1 });
  f.logs.push(f.event(0), f.event(1));
  await assert.rejects(f.monitor.pollOnce(), /bounded range/);
  assert.deepEqual(f.delivered, []);
  assert.equal(f.checkpoint(), null);
  const future = fixture({ startBlock: 20 });
  assert.equal((await future.monitor.pollOnce()).processed, 0);
  assert.deepEqual(future.queries, []);
});

test('stop cancels an outstanding read before callbacks and checkpoint advancement', async () => {
  const f = fixture();
  f.logs.push(f.event(1));
  const entered = deferred();
  const release = deferred();
  const getLogs = f.provider.getLogs;
  f.provider.getLogs = async query => { entered.resolve(); await release.promise; return getLogs(query); };
  const poll = f.monitor.pollOnce();
  await entered.promise;
  const stopped = f.monitor.stop();
  release.resolve();
  await assert.rejects(poll, { name: 'AbortError' });
  await stopped;
  assert.deepEqual(f.delivered, []);
  assert.equal(f.checkpoint(), null);
  assert.equal((await f.monitor.pollOnce()).processed, 1, 'an explicit later poll can resume');
});

test('abort during an event callback prevents later callbacks and committing the range', async () => {
  const controller = new AbortController();
  const seen = [];
  const f = fixture({ onEvent: event => { seen.push(event); controller.abort(); } });
  f.logs.push(f.event(1, 0), f.event(1, 1));
  await assert.rejects(f.monitor.pollOnce({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(seen.length, 1);
  assert.equal(f.checkpoint(), null);
});

test('start retries transient failures with a bounded delay and stop releases its timer', async t => {
  const f = fixture({ pollIntervalMs: 1, maxBackoffMs: 4 });
  t.after(() => f.monitor.stop());
  const committed = deferred();
  const errors = [];
  f.monitor.onError = error => { errors.push(error.message); };
  let attempts = 0;
  f.provider.getBlockNumber = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Transient RPC error.');
    return 8;
  };
  const save = f.checkpointStore.save;
  f.checkpointStore.save = async value => { await save(value); committed.resolve(); };
  f.monitor.start();
  await committed.promise;
  await f.monitor.stop();
  assert.ok(attempts >= 2);
  assert.deepEqual(errors, ['Transient RPC error.']);
  assert.equal(f.monitor.running, false);
  assert.equal(f.checkpoint().blockNumber, 2);
});

test('background reorg errors fail closed instead of retrying indefinitely', async () => {
  const f = fixture({ checkpoint: { blockNumber: 3, blockHash: hash(400) }, pollIntervalMs: 1 });
  const reported = deferred();
  f.monitor.onError = error => { reported.resolve(error); };
  f.monitor.start();
  assert.ok(await reported.promise instanceof ReorgError);
  await Promise.resolve();
  assert.equal(f.monitor.running, false);
  await f.monitor.stop();
  assert.deepEqual(f.saves, []);
});
