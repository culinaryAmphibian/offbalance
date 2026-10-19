const wallet = '0x71C0000000000000000000000000000000009A2F';
const stamp = new Date().toISOString();
const defaults = { dockerImage: 'ghcr.io/example/compute:latest', maxPrice: '0.008', k: 3, quorum: 2, window: 3600, requirements: { minCpuScore: 0, minGpuScore: 0, minMemoryScore: 0 }, createdAt: stamp, providerCount: 3 };

export function createDemoApi() {
  let provider = { registered: true, online: true, lastSeen: stamp, currentStake: '0.050', pricePerHour: '0.002', suggestedPricePerHour: '0.002', machine: { cpuScore: 8420, gpuScore: 12680, memoryScore: 6240, updatedAt: stamp } };
  let jobs = [
    { ...defaults, id: 'demo-024', name: 'Image processing', status: 'COMMIT_PHASE', startedAt: stamp, runtimeSeconds: 124, consensus: { agreeing: 0, required: 2 } },
    { ...defaults, id: 'demo-023', name: 'Simulation batch', status: 'DELIVERY_RECEIPT_VALIDATION', runtimeSeconds: 92, consensus: { agreeing: 3, required: 2 }, delivery: { status: 'RECEIVED', receivedAt: stamp }, payment: { status: 'PENDING' } },
    { ...defaults, id: 'demo-021', name: 'Matrix computation', status: 'COMPLETED', spent: '0.004', earnings: '0.003', runtimeSeconds: 68, consensus: { agreeing: 3, required: 2 }, consensusResultHash: 'demo-result-hash', delivery: { status: 'VERIFIED', receivedAt: stamp, verifiedAt: stamp }, payment: { status: 'PAID', settledAt: stamp }, result: { available: true, filename: 'matrix-result.json' } },
  ];
  const submissions = new Map();
  return {
    setToken() {},
    demoLogin: async () => ({ token: 'local-demo-only', expiresAt: new Date(Date.now() + 3600000).toISOString(), account: { id: 'demo', wallet } }),
    listJobs: async view => ({ jobs: structuredClone(view === 'provider' ? jobs.filter(job => job.providerCount) : jobs), summary: view === 'buyer' ? { activeJobs: jobs.filter(job => job.status !== 'COMPLETED').length, completedJobs: 1, totalSpent: '0.004' } : { activeJobs: 2, completedJobs: 1, totalEarned: '0.003', currentStake: provider.currentStake } }),
    createJob: async (input, key) => {
      if (submissions.has(key)) return structuredClone(submissions.get(key));
      const job = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'PENDING', providerCount: 0 };
      jobs = [job, ...jobs];
      const response = { job };
      submissions.set(key, response);
      return structuredClone(response);
    },
    getJob: async id => {
      const job = jobs.find(item => item.id === id);
      if (!job) throw new Error('Job not found.');
      return { job: structuredClone(job) };
    },
    getResult: async id => {
      if (!jobs.find(job => job.id === id)?.result?.available) throw new Error('The result is not ready.');
      return new Blob([JSON.stringify({ matrix: [[1, 0], [0, 1]], mode: 'demo' }, null, 2)], { type: 'application/json' });
    },
    getProvider: async () => ({ provider: structuredClone(provider) }),
    getProviderTutorial: async () => ({ tutorial: { title: 'Client setup', steps: ['Install the provider client when a release is available.', 'Configure your wallet, coordinator address, and VM resources in the client.', 'Start the client to register and report benchmark scores.', 'Set an hourly price here. The coordinator assigns jobs automatically.'] } }),
    saveProviderPricing: async ({ pricePerHour }) => {
      provider = { ...provider, pricePerHour };
      return { provider: structuredClone(provider) };
    },
  };
}
