// Randomized property tests for the matching engine. Each scenario builds a random pool of
// providers (some offline, busy, unregistered, unpriced, owned by a buyer, with and without GPUs)
// and a queue of random jobs, runs one matching pass, and checks the result against rules
// written out independently here rather than with the engine's own helpers:
//   1. a provider is in at most one match, and never one it was already busy with
//   2. a match has exactly k distinct providers
//   3. nobody is matched to their own job
//   4. every matched provider is available and has the hardware the job asks for
//   5. the quote is the sum of ceil(rate x window / 3600) and fits the job's budget
//   6. no cheaper provider that fit the job was left idle
//   7. a job left unmatched really couldn't be matched from the providers left idle
// The seed is fixed so failures reproduce; a failing scenario prints its seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../matching/JobQueue.ts';
import { ProviderPoolCache } from '../matching/ProviderPoolCache.ts';
import { MatchingEngine } from '../matching/MatchingEngine.ts';

const NOW = 5_000_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const SCENARIOS = 400;

// mulberry32: small, seedable PRNG
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: xs => xs[Math.floor(next() * xs.length)], chance: p => next() < p };
}

const WEI = 10n ** 18n;
const toWei = eth => { const [w, f = ''] = eth.split('.'); return BigInt(w) * WEI + BigInt(f.padEnd(18, '0')); };
const costWei = (rateEth, window) => (toWei(rateEth) * BigInt(window) + 3599n) / 3600n;

function scenario(seed) {
  const r = rng(seed);
  const buyers = ['buyer-a', 'buyer-b'];
  const providers = Array.from({ length: r.int(3, 14) }, (_, i) => {
    const gpus = r.chance(0.4) ? Array.from({ length: r.int(1, 2) }, (_, g) => ({ vendor: r.pick(['nvidia', 'amd']), index: g, vramGb: r.pick([4, 8, 12, 24]) })) : [];
    return {
      wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      // some providers are also buyers
      accountId: r.chance(0.15) ? r.pick(buyers) : `acct-${i}`,
      registered: r.chance(0.92),
      pricePerHour: r.chance(0.08) ? undefined : r.pick(['0.001', '0.002', '0.005', '0.01', '0.02', '0.05']),
      machine: { vcpus: r.pick([1, 2, 4, 8, 16]), memoryGb: r.pick([2, 4, 8, 16, 32]), gpus },
      lastHeartbeat: r.chance(0.85) ? NOW - r.int(0, HEARTBEAT_TIMEOUT_MS - 1) : NOW - HEARTBEAT_TIMEOUT_MS - r.int(1, 100_000),
      busyJobId: r.chance(0.1) ? 'older-job' : null,
      lastAssignedAt: r.int(0, 10) * 1000,
    };
  });
  const jobs = Array.from({ length: r.int(1, 5) }, (_, j) => {
    const gpu = r.pick(['none', 'none', 'none', 'any', 'nvidia', 'amd']);
    return {
      id: `job-${j}`, owner: r.pick(buyers), k: r.int(1, 3), quorum: 1, window: r.pick([60, 600, 3600, 7200]),
      maxPrice: r.pick(['0.0001', '0.001', '0.01', '0.1', '1']),
      requirements: { minVcpus: r.pick([1, 2, 4, 8]), minMemoryGb: r.pick([0, 1, 4, 8, 16]), gpu, minGpuVramGb: gpu === 'none' ? 0 : r.pick([0, 4, 8, 16]) },
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, j)).toISOString(),
    };
  });
  return { providers, jobs };
}

// the rules, written independently of MatchingEngine's helpers
const available = p => p.registered && p.accountId && p.pricePerHour !== undefined && toWei(p.pricePerHour) > 0n &&
  p.lastHeartbeat <= NOW && NOW - p.lastHeartbeat <= HEARTBEAT_TIMEOUT_MS && !p.busyJobId;
const fits = (job, p) => {
  const q = job.requirements;
  if (String(p.accountId) === String(job.owner)) return false;
  if (p.machine.vcpus < q.minVcpus || p.machine.memoryGb < q.minMemoryGb) return false;
  if (q.gpu === 'none') return true;
  return p.machine.gpus.some(g => (q.gpu === 'any' || g.vendor === q.gpu) && g.vramGb >= q.minGpuVramGb);
};

async function run(seed) {
  const { providers, jobs } = scenario(seed);
  const queue = new JobQueue();
  const pool = new ProviderPoolCache({ now: () => NOW });
  for (const p of providers) pool.add(structuredClone(p));
  const matches = [];
  const engine = new MatchingEngine({ queue, pool, now: () => NOW, onMatched: async (job, chosen, quote) => { matches.push({ job, chosen, quote }); } });
  for (const job of jobs) queue.add(job);
  await engine.matchNext();
  return { providers, jobs, matches };
}

test(`matching keeps its rules across ${SCENARIOS} random pools and queues`, async () => {
  let matchedJobs = 0, unmatchedJobs = 0;
  for (let seed = 1; seed <= SCENARIOS; seed++) {
    const { providers, jobs, matches } = await run(seed);
    const byWallet = new Map(providers.map(p => [p.wallet, p]));
    const used = new Set();
    const why = `seed ${seed}`;

    for (const { job, chosen, quote } of matches) {
      matchedJobs++;
      const wallets = chosen.map(p => p.wallet);
      assert.equal(wallets.length, job.k, `${why}: ${job.id} has k providers`);
      assert.equal(new Set(wallets).size, job.k, `${why}: ${job.id}'s providers are distinct`);
      let total = 0n;
      for (const w of wallets) {
        const p = byWallet.get(w);
        assert.ok(!used.has(w), `${why}: ${w} is in two matches`);
        used.add(w);
        assert.ok(available(p), `${why}: ${w} wasn't available (offline, busy, unregistered or unpriced)`);
        assert.ok(fits(job, p), `${why}: ${w} doesn't fit ${job.id} (hardware, or it's the buyer's own account)`);
        total += costWei(p.pricePerHour, job.window);
      }
      assert.equal(BigInt(quote.totalWei), total, `${why}: ${job.id}'s quote is the sum of ceil(rate x window / 3600)`);
      assert.ok(total <= toWei(job.maxPrice), `${why}: ${job.id} is over budget`);
    }

    // providers nobody was matched to, that could have worked
    const idle = providers.filter(p => available(p) && !used.has(p.wallet));
    for (const { job, chosen } of matches) {
      const priciest = chosen.reduce((max, p) => { const w = toWei(p.pricePerHour); return w > max ? w : max; }, 0n);
      const cheaper = idle.filter(p => fits(job, p) && toWei(p.pricePerHour) < priciest);
      assert.deepEqual(cheaper.map(p => p.wallet), [], `${why}: ${job.id} left a cheaper fitting provider idle`);
    }
    const matched = new Set(matches.map(m => m.job.id));
    for (const job of jobs.filter(j => !matched.has(j.id))) {
      unmatchedJobs++;
      const candidates = idle.filter(p => fits(job, p)).map(p => costWei(p.pricePerHour, job.window)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const cheapest = candidates.slice(0, job.k).reduce((a, b) => a + b, 0n);
      assert.ok(candidates.length < job.k || cheapest > toWei(job.maxPrice),
        `${why}: ${job.id} stayed unmatched although ${candidates.length} idle providers fit within budget`);
    }
  }
  // the generator must produce both outcomes, or the properties above prove little
  assert.ok(matchedJobs > SCENARIOS / 4, `only ${matchedJobs} jobs matched`);
  assert.ok(unmatchedJobs > SCENARIOS / 4, `only ${unmatchedJobs} jobs stayed unmatched`);
});

test('the same pool and queue always produce the same matches', async () => {
  for (const seed of [3, 17, 42, 99]) {
    const a = await run(seed);
    const b = await run(seed);
    const summary = r => r.matches.map(m => [m.job.id, m.chosen.map(p => p.wallet)]);
    assert.deepEqual(summary(a), summary(b), `seed ${seed}`);
  }
});
