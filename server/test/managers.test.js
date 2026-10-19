import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import { MatchManager, AgentManager, BlockchainMonitor } from '../index.js';

test('the three managers integrate through owner-supplied ports without a database or chain writer', async () => {
  const now = 1_000_000;
  const wallet = '0x1111111111111111111111111111111111111111';
  const address = '0x2222222222222222222222222222222222222222';
  const job = { id: 'job-1', owner: 'buyer', k: 1, quorum: 1, window: 60, maxPrice: '1',
    requirements: { minCpuScore: 1, minGpuScore: 0, minMemoryScore: 1 }, createdAt: '2026-10-18T12:00:00Z' };
  const provider = { id: 'provider-1', accountId: 'provider-1', wallet, registered: true, pricePerHour: '0.001',
    machine: { cpuScore: 100, gpuScore: null, memoryScore: 100 } };
  const assignments = new Map();
  const repository = {
    async getJob(id) { return id === job.id && !assignments.has(id) ? job : null; },
    async listProviders() { return [provider]; },
    async getAssignedJob(id, providerId) {
      const assigned = assignments.get(id);
      return assigned?.providers.includes(providerId) ? assigned : null;
    },
  };
  const matcher = new MatchManager({ repository, now: () => now,
    onMatched: async (selectedJob, providers) => assignments.set(selectedJob.id,
      { ...selectedJob, providers: providers.map(item => item.accountId), providerWallets: providers.map(item => item.wallet) }) });
  assert.deepEqual(await matcher.onJobSubmitted(job.id), []);
  assert.equal(assignments.size, 0, 'repository records do not establish a live session');
  // Explicitly simulate the authenticated transport's liveness notification.
  matcher.pool.register({ ...provider, lastHeartbeat: now });
  assert.equal((await matcher.onProviderUpdated(wallet)).length, 1);

  const bytes = Buffer.from('provider output\n');
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const uploaded = [];
  const agent = new AgentManager({ repository,
    providerTransport: { async requestOutput(id, target) {
      assert.equal(id, job.id); assert.equal(target, wallet);
      return { bytes, sha256: expectedHash, filename: 'output.txt', providerId: provider.id, wallet };
    } },
    objectStorage: {
      async put(output, metadata) { uploaded.push({ bytes: output, metadata }); return { key: 'fixture/output.txt' }; },
      async get() { return bytes; },
    },
  });
  const abi = ['event DELIVERY_PHASE_START(uint256 jobId)'];
  const iface = new Interface(abi);
  const encoded = iface.encodeEventLog(iface.getEvent('DELIVERY_PHASE_START'), [1n]);
  const blockHash = `0x${'a'.repeat(64)}`;
  let checkpoint = null;
  const observations = [];
  const monitor = new BlockchainMonitor({ address, abi, chainId: 31337, startBlock: 1, confirmations: 0,
    provider: {
      async getBlockNumber() { return 1; },
      async getBlock(number) { return { number, hash: blockHash }; },
      async getLogs() { return [{ address, blockNumber: 1, blockHash, transactionHash: `0x${'b'.repeat(64)}`,
        transactionIndex: 0, index: 0, ...encoded }]; },
    },
    checkpointStore: { async load() { return checkpoint; }, async save(value) { checkpoint = value; } },
    onEvent: async event => {
      observations.push(event);
      assert.equal(event.args.jobId, 1n);
      // Mapping chain IDs and obtaining the expected hash belong to the integrating application.
      await agent.collectOutput({ jobId: job.id, providerId: provider.id, wallet, expectedHash });
    },
  });
  assert.equal((await monitor.pollOnce()).processed, 1);
  assert.equal((await monitor.pollOnce()).processed, 0);
  assert.equal(observations.length, 1);
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0].bytes, bytes);
  assert.equal(uploaded[0].metadata.hash, expectedHash);
  assert.equal(checkpoint.blockNumber, 1);
  assert.equal(matcher.pool.get(wallet).busyJobId, job.id, 'delivery observation does not invent job completion or release a running worker');
});
