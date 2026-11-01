# OffBalance frontend

React/Vite UI connected to the repository's HTTPS API and MongoDB. Buyers save workloads, inspect assigned providers and delivery records, and submit saved jobs through their wallet when a real contract is configured. Providers inspect their benchmarked machine and set an hourly rate. Matching remains internal; there is no public marketplace browser.

## Run with the real server

Use Node 22.18+ and a running MongoDB instance. First start the backend:

```sh
cd server
npm ci
cp .env.example .env
npm run cert:dev
npm run seed
npm start
```

In another terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open the Vite URL and sign in with an injected Ethereum wallet. Vite sends `/api/*` requests to `https://localhost:5000/*`, removing the `/api` prefix and verifying the backend certificate against `server/.local/tls/cert.pem`. Generate the certificate before starting Vite. Neither credentials nor MongoDB connection strings belong in frontend configuration.

`VITE_API_BASE_URL` defaults to `/api`. For another backend set `API_PROXY_TARGET=https://...` and, for a private/local CA, `API_CA_FILE=/absolute/path/to/ca.pem` in the frontend's `.env.local` or shell environment. The proxy requires HTTPS and retains certificate verification. A deployed static frontend needs its host/reverse proxy to forward `/api`, or a public HTTPS `VITE_API_BASE_URL` with the frontend origin permitted by the server's `CORS_ORIGINS`. Vite's development proxy is not included in a static production build.

The example backend configuration uses database-only mode (`CHAIN=off`). Jobs persist and providers can be matched, but this mode does not run blockchain execution or settlement. For the local chain, configure the real server as described in [server/README.md](../server/README.md). The root `startup.py` now starts the real HTTPS API, seeds a fresh development database for its fresh Hardhat chain, and configures the frontend proxy and provider client to trust the local certificate. MongoDB and all Node/Python dependencies must already be installed. Each launcher database is retained after shutdown; its name is printed so it can be inspected or removed later. `MONGODB_URI` selects its Mongo host/authentication; the launcher uses a new database name on that host for each fresh chain.

## Connected workflows

- Wallet sign-in signs the exact server-issued OffBalance challenge and exchanges `{ wallet, signature }` at `POST /auth`. Tokens stay in memory. Signing out revokes the server token; account/network changes and authenticated 401s clear the session. The server's current tokens have no automatic expiry; the UI does not invent one.
- Buyer/provider lists use `/jobs?role=...`; dashboard totals come from `/account/me/dashboard`, without replacing the full jobs list with the dashboard's 20 recent jobs.
- **Save job** persists its name, image, hourly cap, provider/quorum counts, execution window and hardware requirements. The server honors `Idempotency-Key` per account and payload, including concurrent retries. Registry tags are resolved to pinned image digests; a supplied `repo@sha256:...` is already pinned and needs no registry lookup.
- The price is the maximum **ETH per hour per provider**, not a total job budget. USD entry converts that hourly cap using a public ETH/USD quote with exact integer arithmetic. Quotes expire before a first save; retries preserve the original conversion/payload/key. Minutes are converted to API seconds.
- With a configured real contract, the owner's saved job has a separate **Submit to blockchain** action. It verifies the authenticated wallet and chain, then asks the wallet to call `submitJob` with zero ETH transferred. The UI waits for the server's chain observation before reporting submission. A wallet rejection leaves the database job available to retry. Navigation or identity changes cancel preparation before a transaction is requested.
- Provider setup offers a masked, copyable client API key for the active session (sign-out revokes it), reads `/provider/hardware`, including current heartbeat state, and writes `/provider/price`. An account without benchmarks sees an unregistered machine state. Stored machine rates use the database's numeric representation; unsupported precision is rejected rather than silently rounded. Benchmark reports alone do not establish liveness. The Python execution loop still needs periodic calls to the heartbeat endpoint.
- Provider Overview shows available funds and a **Collect funds** action. The demo collects a sample 0.003 ETH once without transferring money; reloading resets it. API mode uses the collection integration contract below. Lifetime earnings and stake remain separate from the collectible balance.
- Delivery records come from `/jobs/:id/result` as JSON. Each record shows its provider, reported hash, output location and receipt verification state. HTTP(S) output links open separately without forwarding the session token. A reported location is not proof of verified computation or payment. Non-web locations remain visible as text; the server does not stream artifact bytes.

Full commit/reveal/consensus/payment execution still depends on unfinished client and contract work. This integration does not simulate or claim successful settlement.

## Demo and tests

`npm run dev:demo` remains a visibly labeled in-memory demo. It needs no backend or wallet and never falls back silently from API mode. Reloading resets demo data.

```sh
npm test
npm run build
npx playwright install chromium
# Start demo on port 5173 for the standalone demo smoke checks:
npm run dev:demo -- --port 5173 --strictPort
npm run test:browser
# Real browser test orchestrates its own Vite/HTTPS server and isolated database:
MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:integration
```

The real integration runner requires `npm ci` in both `frontend/` and `server/`, OpenSSL, MongoDB and Playwright's Chromium. It uses a wallet fixture that signs real challenges with public development keys; API requests are not mocked. It checks wallet rejection/identity changes, persisted named jobs, provider pricing, delivery metadata and revoked-token logout. The delivery test explicitly sets a lifecycle fixture in its isolated database; it does not execute a blockchain job. The temporary database, certificates and child services are cleaned up. Screenshots go to ignored `frontend/.local/screens/`; `BROWSER_ARTIFACTS` overrides that location.

`test:browser` covers the independent demo, validation, navigation, USD quote expiry and mobile widths. It also starts a temporary Vite server with funds API fixtures to check failures, retries and pending collection; these checks do not perform payouts. `test:integration` covers the actual API. CI runs both plus frontend unit/build and the server's TypeScript/MongoDB/HTTPS contract suites.

## Provider funds integration contract

The on-chain contract exposes `credits(address)` and `withdraw()`, but the coordinator does not yet expose provider funds HTTP routes. This frontend adds an API adapter and a local demo, not that backend bridge. API mode shows collection as unavailable until the coordinator implements the following account-scoped routes backed by actual payout execution:

| Method | Path | Response |
| --- | --- | --- |
| GET | `/provider/funds` | `{ "funds": { "available": "0.003", "currency": "ETH", "collectionEnabled": true } }`; includes the latest `collection` when pending |
| POST | `/provider/funds/collect` | No request body; receives `Idempotency-Key`, returns `{ "collection": Collection, "funds": Funds }` |

Both routes use the authenticated wallet. `funds.available` must be an authoritative, nonnegative ETH decimal string with up to 18 fractional digits; never derive it from lifetime earnings, job completion, or stake. `collectionEnabled` must be explicitly `true` to enable collection. The browser supplies neither a recipient nor an amount. The bridge must validate authorization, available funds and payout configuration, and authorize the actual withdrawal for the authenticated provider. Contract `withdraw()` uses the transaction sender's credits; an HTTP session alone does not authorize an on-chain transaction.

Example confirmed collection response:

```json
{
  "collection": { "status": "COLLECTED", "amount": "0.003", "transactionHash": "0x…" },
  "funds": { "available": "0", "currency": "ETH", "collectionEnabled": true }
}
```

`COLLECTED` means the backend has confirmed transfer. Use `PENDING` for an accepted request whose transfer remains unconfirmed; a transaction hash alone does not establish confirmation. `transactionHash` is optional. While pending, GET must report the latest collection and reserved funds as unavailable, then report confirmation when known. The frontend polls reads without resending the collection POST and blocks further collection while pending. An ambiguous failure retains the original request key for retry.

The bridge must durably honor collection idempotency per wallet/key/payload: replaying an accepted request returns its original result without another transfer, including after timeouts or lost responses. Atomic balance reservation and at most one pending collection per authenticated wallet must prevent duplicates across reloads, tabs and concurrent requests. Unsupported/unconfigured collection, insufficient funds and other errors must return non-2xx JSON `{ "error": "…" }` or `{ "message": "…" }`. `collectionEnabled: false` can disable submission in advance. Missing/unavailable funds never fall back to demo values.
