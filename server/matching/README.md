# Match Manager

`MatchManager` implements internal selection using the diagram's Match Manager boundary. It does not create database collections, implement account/login APIs, run containers, calculate result consensus, or submit blockchain transactions.

## Required ports

```js
import { MatchManager } from './matching/MatchManager.js';

const matching = new MatchManager({
  repository: {
    getJob: id => jobRepository.getSchedulableJob(id),
    listProviders: job => providerRepository.listCandidates(job),
  },
  onMatched: (job, providers, quote) => assignmentPort.recordOrForward(job, providers, quote),
});
```

The example names external integrations, not built-in implementations. Construction requires both repository methods and the assignment callback. Missing ports fail with descriptive errors. Repository failures propagate; there is no fallback database or fabricated production data. Test doubles live in the tests.

`getJob(id)` returns a schedulable job or `null` when the job is missing or no longer eligible. The external adapter owns lifecycle eligibility. Records contain string `id`/`owner`, positive integer `k` and `window` in seconds, decimal ETH string `maxPrice`, canonical ISO `createdAt`, and minimum hardware requirements. Requirements remain nonnegative integers. Rehydrating pending job IDs belongs to the external adapter; the manager does not discover jobs by creating or querying its own schema.

`listProviders(job)` returns the provider records permitted for that job. Each has `wallet`, `accountId`, optional provider `id`, `registered`, `pricePerHour`, and `machine: {cpuScore, gpuScore, memoryScore}`. Scores are finite nonnegative numbers no greater than `Number.MAX_SAFE_INTEGER`; fractional throughput is preserved. `gpuScore: null` means unavailable, not measured zero. The repository's job-specific candidate list is enforced even when the shared live cache contains other providers.

`onMatched(job, providers, quote)` must persist or reliably forward an assignment before resolving. Rejection releases all reservations and keeps the job queued. The callback must be idempotent for a job ID, including after coordinator restarts. It must not await a recursive call to this manager. A successful call does not imply on-chain acceptance, execution, funds, or payment.

## Calls and live sessions

- `findMatchingScores(jobId)` loads the repository and returns ordered **top-k provider IDs**, using `provider.id` or `provider.accountId`. It does not queue or assign a job, and can return fewer than `k` when capacity is insufficient.
- `onJobSubmitted(jobId)` loads a job, queues it, and attempts matching.
- `onProviderUpdated(wallet)` and `onMachineSpecsUpdated(wallet)` refresh all queued jobs and attempt matching. The wallet is a trigger hint; matching remains a full pending scan.
- `matchNext()` refreshes all pending records before scanning. Repository removal drops the queued entry.
- `forgetAssignment(jobId)` removes retry/deduplication bookkeeping without releasing a provider. The external lifecycle owner decides when reuse is safe.

The authenticated provider transport owns `matching.pool` heartbeats and connection status. Repository metadata cannot establish liveness: newly loaded providers receive heartbeat sentinel `0`, which is always unavailable. Metadata refresh preserves an existing session heartbeat and busy reservation. A cache/register call by the trusted transport can establish liveness; no HTTP/authentication endpoint is supplied here. Use the facade triggers instead of calling `matching.engine` directly, so repository eligibility is refreshed.

The RAM queue and live cache are scheduler internals, not the team's persistent database. A provider holds one assignment at a time. A missed heartbeat stops new eligibility but does not free an in-progress assignment. Reservations are atomic within one coordinator process only; multiple schedulers require an external shared reservation/leadership design.

## Selection policy

Scan jobs by `createdAt`, then ID; skip currently unmatchable jobs. Exclude the buyer's own account and providers that are unregistered, unpriced, stale/offline, busy, or below any required benchmark. Unknown GPU qualifies only when its minimum is zero.

Rank eligible providers by lower hourly rate, greater bottleneck hardware headroom, older last-assignment timestamp, and case-insensitive lexical wallet. Headroom is the smallest measured/minimum ratio across nonzero requirements, or zero if none are required.

Select `k` and quote each provider as `ceil(hourlyRateWei × windowSeconds / 3600)`. Reserve all providers together only if enough qualify and their summed quotes fit `maxPrice`. Prices use exact integer wei arithmetic and decimal strings. This is a budget estimate, not funding, billing, escrow, or settlement. There is no reputation score, identity/Sybil guarantee, or public marketplace.

The lower-level `MatchingEngine.handleProviderFailure(jobId, wallet)` helper remains available for an externally approved **preexecution** retry. It releases the group, removes the failed session, requeues the job and scans. It must not automatically restart running work; its caller must establish retry safety and refresh repository eligibility through the facade. It does not know blockchain state or reconstruct past assignments after restart.

Run `node --test server/test/matching.test.js server/test/match-manager.test.js` from the repository root.
