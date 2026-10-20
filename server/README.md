# OffBalance server

The server runs directly as TypeScript on Node **22.18+**. `index.ts` exports the matching, agent and blockchain managers without opening listeners. `server.ts` starts a single HTTPS API and connects it to MongoDB, matching and the blockchain listener.

All database models, authentication, routes, image resolution/build services and seed fixtures from the `database` branch are included here. The managers use those models through typed adapters rather than running a second matching or event-monitor implementation.

## Local development

Run MongoDB locally or provide a reachable MongoDB URI. From this directory:

```sh
npm ci
cp .env.example .env
npm run cert:dev
npm run seed
npm start
```

The example uses `mongodb://127.0.0.1:27017/offbalance`, **https://localhost:5000**, and `CHAIN=off`. `cert:dev` generates a localhost/127.0.0.1 certificate and private key under ignored `.local/tls/` (key permissions 0600). For a deployed hostname, set both `TLS_KEY_FILE` and `TLS_CERT_FILE` to the private key and certificate/full chain issued for that hostname. Missing, invalid or incomplete certificate configuration stops startup; the real server never falls back to plaintext HTTP. Database-only mode supports accounts, jobs, pricing, manifests and matching; it does not simulate blockchain execution or settlement. The default seed creates development accounts, tokens `dev`–`dev4` and `dev-buyer`, and the tutorial. It creates no jobs, reserves no providers, and consumes no job IDs. For manual mock demonstrations or fixture tests only, `npm run seed -- --fixtures` also creates the job-1 manifest assigned to provider 1. Neither mode invents live providers. Seeding preserves existing jobs; it does not remove old fixture assignments from a reused database. Use only a development database when seeding.

To use the deployed contract, remove `CHAIN=off`, start/deploy the local chain using the blockchain project's existing workflow, and set `SERVER_PRIVATE_KEY` from the public local-development values in `../dev.env`. `RPC_URL` defaults to `http://127.0.0.1:8545`; `DEPLOYMENT_FILE` defaults to `../blockchain/deployments/localhost.json`. Restart after changing deployments. The real contract requires the deployer's signing key for assignments and receipts. A missing deployment or unreachable chain logs a warning and runs database-only, matching the database branch's behavior.

## Database adapters

- `adapters/repository.ts` maps Mongo jobs/hardware to `MatchManager`, checks assignment ownership for `AgentManager` and HTTPS requests, and restores active assignments on reconnect. Database reservations survive server restarts; live capacity does not.
- `services/matcher.ts` serializes scheduling and persists assignments before broadcasting them. If assignment fails, it restores the job and account histories and the engine releases its reservations. Run one coordinator process: reservations are not a distributed scheduling lock.
- The database API's `maxPrice` is each provider's hourly ceiling, and `runningPrice` is the highest selected hourly rate. The repository filters each provider by that ceiling and translates it into the matching engine's aggregate execution budget using integer wei arithmetic. This preserves the database branch's pricing contract.
- `adapters/checkpoints.ts` persists block number and hash under a chain/contract namespace. The monitor retries failed callbacks without advancing the cursor; payment/reputation effects deduplicate stable event IDs in MongoDB. Reorgs stop the monitor until explicitly reconciled. Local development chains default to zero confirmations; other chains default to six (`CHAIN_CONFIRMATIONS` overrides this).

## Providers and liveness

The existing Python HTTP endpoints remain available:

- `GET /contract_address`
- `POST /scores` (form-encoded `cpu`, optional `gpu`, `mem`)
- `GET /jobManifest/:jobId` (assigned providers only)

Authenticate with `Authorization: Bearer <token>`. Wallet sign-in is `GET /auth/nonce?wallet=...` followed by `POST /auth {wallet, signature}`; its token is also the provider API key. Report benchmarks and set a positive rate with `POST /provider/price {"price": 1}`. The Python client sends authenticated `POST /provider/heartbeat` immediately after benchmarking and every **10 seconds** while polling (timeout: 30 seconds). Neither saved benchmarks nor pricing establishes liveness. Stopping the client lets availability expire without releasing unfinished assignments.

Provider control shares the HTTPS listener:

- `GET /provider/assignment` returns the current MongoDB assignment or `null`, including after reconnect/restart.
- `POST /provider/jobs/:jobId/accept` returns the authorized assignment; retries are safe.
- `POST /provider/jobs/:jobId/idle` and `/error` acknowledge provider reports while retaining unfinished assignments. `/error` takes `{ "message": "..." }`.

Blockchain events still trigger execution. Polling an assignment does not authorize starting ahead of the contract. Every authenticated request rechecks token revocation, account existence and linked-wallet membership. There is no custom socket listener, separate provider port, or socket message format.

### Connect the existing Python client

The Python client's existing `OFFBALANCE_SERVER_URL` override and Requests certificate support are sufficient for HTTPS. From `server/`, using a Python environment with the client's dependencies:

```sh
OFFBALANCE_SERVER_URL=https://localhost:5000 \
REQUESTS_CA_BUNDLE="$PWD/.local/tls/cert.pem" \
python ../client/main.py --dev
```

Keep certificate verification enabled. The local certificate must also be trusted by browser/Node clients: for Node commands use `NODE_EXTRA_CA_CERTS="$PWD/.local/tls/cert.pem"`. Publicly trusted production certificates ordinarily need no custom CA setting. Generate a replacement local certificate with `npm run cert:dev -- --force` after expiry. The provider client's blockchain connection is still required by its existing execution workflow.

`dev:mock` remains an independent HTTP development mock and accepts provider heartbeats after a benchmark upload. The root launcher starts the real HTTPS server with a fresh development database for each fresh local chain. `npm start` always starts the real HTTPS server.

Agent output collection still requires an expected SHA-256 plus a caller-supplied object storage adapter. Providers may post existing output locations through `/provider/results/:jobId`; receipt verification depends on the contract. The Python directory hash and agent byte hash still require an agreed output format for direct output collection.

The database branch's other job, provider, account and build routes are retained. `POST /jobs` additionally persists names and binds optional idempotency keys to the account and original payload. `GET /config` exposes execution mode and the public contract address/chain ID; job responses provide owner-specific submission/result capabilities. The frontend uses these routes through its verified HTTPS development proxy. See [frontend/README.md](../frontend/README.md) for the connected browser workflow.

## Validation

```sh
npm test                         # typecheck, managers, schemas, registry, mock HTTP, optional DB tests
MONGODB_URI=mongodb://127.0.0.1:27017 npm test
npm run test:real                # real HTTPS + unchanged client contracts; MongoDB must be reachable
```

MongoDB integration tests create and drop uniquely named databases, covering HTTP authentication/lifecycle, provider polling/reconnect, scheduler rollback/liveness/restart, and durable chain-event replay. Without `MONGODB_URI`, DB tests are visibly skipped. HTTPS tests require OpenSSL and a Python interpreter with `requests`. Set `TEST_PYTHON` to the interpreter used by the client when it is not `python3`:

```sh
MONGODB_URI=mongodb://127.0.0.1:27017 \
TEST_PYTHON=/absolute/path/to/python \
npm test
```

`test:https` runs against an isolated, seeded MongoDB database and starts the actual `server.ts`. It executes Sergey's unchanged `test/client-contract.test.ts` (nine tests) over HTTPS, then imports the real Python `ServerManager` to upload benchmarks and fetch its manifest. It also runs the Python provider loop with fixture benchmark/chain inputs, proving that its heartbeat makes the provider online and matches a waiting job; this does not execute Docker or a real blockchain. Clients explicitly trust a temporary test CA; separate tests reject untrusted certificates, hostname mismatches and plaintext connections. `test:real` runs this same acceptance suite, defaulting MongoDB to localhost when `MONGODB_URI` is unset. Chain integration tests use an explicit RPC fixture; they do not claim a live deployed-contract or Docker execution test. Docker registry resolution/builds require network/registry access and Docker respectively; builds remain off until `REGISTRY_NAMESPACE` is set.
