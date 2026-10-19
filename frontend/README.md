# Offbalance frontend

Minimal React/Vite frontend for wallet sign-in, buyer/provider job lists, job submission, job details/results, and provider setup/pricing. Provider selection and matching belong to the coordinator; there is no marketplace browser.

Requires Node.js 20.19+ or 22.12+.

```sh
cd frontend
npm ci
npm run dev:demo
```

Open the URL printed by Vite and choose **Enter demo**. Demo mode is explicitly labeled, uses an in-memory adapter, and never connects a wallet, funds a job, or runs a container. New jobs remain pending; the included completed job has a downloadable sample result. Provider setup shows sample hardware/rates/stake; saved rates persist only until reload. The client download is unavailable until a real release URL is supplied. Reloading resets the data.

For the real API:

```sh
npm run dev
```

API mode expects a backend implementing the contract below. Vite proxies `/api` to `http://127.0.0.1:3001`; no frontend environment file is needed when a compatible API listens there. To use another local API address, copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL` (including any API prefix). The full coordinator implementation is maintained separately from this frontend change; demo mode works independently.

Normal mode uses an injected Ethereum wallet (`window.ethereum`). It requests accounts and a signature only when the user clicks sign in. The frontend signs a SIWE message, exchanges it for a bearer token, and keeps the token in memory. Reloading requires signing in again. Sign out discards the local session; account/chain changes, wallet disconnects, token expiry, and authenticated 401 responses also clear it. A sign-in signature does not transfer funds.

`VITE_API_BASE_URL` defaults to `/api`; a cross-origin backend must allow the frontend origin, `Authorization`, `Content-Type`, and `Idempotency-Key` in CORS. `VITE_` variables are public build configuration and must not contain secrets. `.env.demo` enables the local adapter only for `--mode demo`; there is no automatic fallback to sample data when the API fails.

```sh
npm test
npm run build
npm run preview
```

`npm test` uses Node's built-in test runner. Browser regression checks are in `test/browser-smoke.cjs`: start demo mode on port 5173 and API mode on port 5174, then run `npx playwright install chromium` once and `npm run test:browser`. Playwright is included as a development dependency. If using an external Playwright installation or system Chrome, set `PLAYWRIGHT_MODULE` to its package path and `BROWSER_EXECUTABLE` to the Chrome executable. The checks inject a test wallet and intercept localhost API requests; they do not use a real account or backend. Screenshots go to the temporary `offbalance-browser` directory (`BROWSER_ARTIFACTS` overrides it).

Hash routes (`#/`, `#/jobs/new`, `#/jobs/:id`, `#/provider`) support refresh and browser history without server-side route rewrites. Overview refreshes every 10 seconds; job details every 5 seconds. Provider setup has a manual status refresh that preserves an edited price. Leaving a page cancels its reads. Forms preserve input on errors; unchanged job submissions reuse their idempotency key on retry.

## API integration contract

These are the frontend integration contracts. `src/api.js` adapts and normalizes responses; no backend implementation is included in this frontend change. Existing UML establishes nonce/verify, submission, and job detail; listing and result download complete the browser integration. Error responses use `{ "message": "Human-readable error" }` with a non-2xx status. API mode requires a compatible server rather than falling back to sample data.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/auth/nonce?wallet=0x…&chainId=1&origin=http%3A%2F%2F127.0.0.1%3A5174` | `{ "nonce": "alphanumericNonce", "address": "0x…", "issuedAt": "ISO timestamp", "expiresAt": "ISO timestamp" }`; the Origin header can supply the origin instead |
| POST | `/auth/verify` | `{ "token": "JWT", "expiresAt": "ISO timestamp", "account": { "id": "account-id", "wallet": "0x…" } }` |
| GET | `/jobs?view=buyer` or `provider` | `{ "jobs": [Job], "summary": { "activeJobs": 1, "completedJobs": 2, "totalSpent": "0.004", "totalEarned": "0.003" } }` |
| POST | `/jobs` | `{ "job": Job }`; receives an `Idempotency-Key` header |
| GET | `/jobs/:id` | `{ "job": Job }` |
| GET | `/jobs/:id/result` | Authenticated binary/text artifact bytes; errors remain non-2xx JSON |
| GET | `/provider/profile` | `{ "provider": Provider }`, scoped to the signed-in account |
| GET | `/provider/tutorial` | `{ "tutorial": { "title": "Client setup", "steps": ["…"], "downloadUrl": "https://…", "sourceUrl": "https://…" } }`; URLs optional |
| POST | `/provider/pricing` | Receives `{ "pricePerHour": "0.002" }`, returns `{ "provider": Provider }` |

`POST /auth/verify` receives `{ "message": "full SIWE message", "signature": "0x…" }`. The message binds the wallet to the browser host/origin, current wallet chain, nonce, and issue time. A nonce response can supply the EIP-55 checksummed `address` for strict SIWE verifiers; it must match the connected account, ignoring case. Otherwise the frontend preserves the address supplied by the wallet. The server must verify the signature and message fields, enforce allowed domains/chains and nonce expiry/single use, and issue a session for that wallet. It must authorize every job/result request against the session; the view query is not an authorization rule. The frontend does not select or switch a production chain. Server-side chain restrictions remain required.

`POST /jobs` receives:

```json
{
  "name": "Matrix computation",
  "dockerImage": "ghcr.io/your-team/workload:latest",
  "maxPrice": "0.008",
  "k": 3,
  "quorum": 2,
  "window": 3600,
  "requirements": {
    "minCpuScore": 0,
    "minGpuScore": 0,
    "minMemoryScore": 0
  }
}
```

`maxPrice` is a positive decimal string, currently displayed in ETH, with up to 18 fractional digits. Counts, scores, and the window in seconds are safe integers; `1 <= quorum <= k <= 255` matches the UML's uint8 counts; zero hardware scores mean no minimum. The backend must validate these independently. Honor the idempotency key per wallet/payload to avoid creating duplicate jobs after an uncertain response.

Image input is a registry reference, not an archive upload. Rates and budgets are displayed in ETH. Provider transport and matching belong to the coordinator. Submission creates a job request; this frontend does not submit an escrow or staking transaction.

Example `Job` (the list can omit detail-only fields):

```json
{
  "id": "job-024",
  "name": "Matrix computation",
  "status": "COMPLETED",
  "createdAt": "2026-10-18T16:00:00Z",
  "dockerImage": "ghcr.io/your-team/workload:latest",
  "maxPrice": "0.008",
  "spent": "0.004",
  "earnings": "0.003",
  "k": 3,
  "quorum": 2,
  "window": 3600,
  "providerCount": 3,
  "runtimeSeconds": 68,
  "requirements": { "minCpuScore": 0, "minGpuScore": 0, "minMemoryScore": 0 },
  "consensus": { "agreeing": 3, "required": 2 },
  "consensusResultHash": "0x…",
  "result": { "available": true, "filename": "result.json" }
}
```

Use string IDs, ISO dates, and decimal strings for money. Summary totals come from the API; absent values display as a dash. Provider summary may also include `currentStake`. Failed jobs may include an `error` string. The server should expose `result.available` only when the authorized result can be retrieved. The frontend downloads artifact bytes through the API and does not render arbitrary result HTML or follow result-location URLs.

The read adapter accepts Lucidchart job fields alongside the canonical names above: `_id` (including Mongo extended JSON `$oid`) → `id`, `dockerImageDigest` → `dockerImage`, `minNodesToRunOn` → `k`, `minNodesToAgree` → `quorum`, `timeWindow` → `window`, `providers.length` → `providerCount`, `result.hash` → result hash, and `result.deliveryTime` → output-received time. Explicit canonical values win. These aliases do not infer a downloadable result, successful receipt, payment, or consensus from a stored location/hash.

Job statuses support both the repository UML and the Lucidchart phases: `PENDING`, `PICKED_UP`, `RUNNING`, `COMMIT_PHASE`, `REVEAL_PHASE`, `VERIFYING`, `CONSENSUS_VERIFICATION`, `AWAITING_DELIVERY`, `DELIVERY_RECEIPT_VALIDATION`, `PAYOUT`, `COMPLETED`, `CANCELED`, and `NO_QUORUM`/`FAILED`. Unknown names remain visible. There is no invented linear state machine or automatic claim that `COMPLETED`/`PAYOUT` means money was paid.

Optional job evidence fields are displayed independently:

```json
{
  "onChainJobId": 24,
  "delivery": { "status": "VERIFIED", "receivedAt": "2026-10-18T16:02:00Z", "verifiedAt": "2026-10-18T16:03:00Z" },
  "payment": { "status": "PAID", "settledAt": "2026-10-18T16:04:00Z" },
  "result": { "available": true, "filename": "result.json", "retainedUntil": "2026-10-25T16:02:00Z" }
}
```

Delivery/payment statuses and timestamps must come from the backend's actual evidence. Either object may include an `error` string. `STORED` and `NOT_CONFIGURED` are supported for local-only delivery/payment. The `VERIFIED`/`PAID` example above illustrates reported evidence; neither is inferred from job completion. Receipt schema and result retention remain backend decisions.

Example `Provider`:

```json
{
  "registered": true,
  "online": true,
  "lastSeen": "2026-10-18T16:00:00Z",
  "currentStake": "0.050",
  "pricePerHour": "0.002",
  "suggestedPricePerHour": "0.002",
  "machine": { "cpuScore": 8420, "gpuScore": 12680, "memoryScore": 6240, "updatedAt": "2026-10-18T16:00:00Z" }
}
```

Profile/pricing routes must be scoped to the authenticated account. Machine registration, session keys, VM resource configuration, benchmarks and container execution belong to the provider client/coordinator. The browser reads their reported state and changes one hourly price; it does not register an on-chain provider or place stake. Unknown stake/suggested pricing should be `null`; the numeric values above are illustrative. A tutorial can supply public HTTP(S) release/source links; absent links remain unavailable. No client binary is bundled with this frontend.
