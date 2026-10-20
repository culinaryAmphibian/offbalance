# OffBalance

## Repo layout

| Path | What it is |
|---|---|
| `blockchain/` | Hardhat 3 project: the `OffBalance` contract, its tests, and deploy scripts |
| `client/` | Python provider client: benchmarks the machine, listens for contract events, runs jobs in Docker and commits the result hash |
| `client/dev/` | The contract controller: call any `OffBalance` function as any dev account |
| `server/` | TypeScript HTTPS API with MongoDB persistence, plus `dev-server.ts`, a mock of the routes the client calls |
| `frontend/` | React dashboard |
| `dev.env` | Fixed local-dev addresses and private keys, shared by every part of the app |

## Prerequisites

- Node.js 22+ (Hardhat 3 requirement), then `cd blockchain && npm install`
- Python 3.12 with a venv in `client/.venv`:
  ```bash
  cd client && python3 -m venv .venv && source .venv/bin/activate
  pip install web3 requests docker
  ```
- Docker Engine, which the client uses to run jobs. The `docker` pip package is only a client; it needs the daemon running.
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER     # then log out and back in (or `newgrp docker` in one shell)
  docker run --rm hello-world       # check
  ```
  `Permission denied` on `/var/run/docker.sock` means your shell doesn't have the `docker` group yet. `FileNotFoundError` means the daemon isn't installed or isn't running. Don't run the client with `sudo`; that skips the venv.

## Connected frontend and real backend

The frontend now uses the real server's wallet sign-in, persisted jobs, dashboards,
provider pricing and delivery records. Follow [frontend/README.md](frontend/README.md)
for the two-terminal setup, HTTPS certificate trust and database-only development.

`startup.py --shell` now launches the real HTTPS API instead of the mock. It needs
MongoDB running and the existing Node/Python prerequisites. Each launch creates a
fresh, retained development database to match its newly started local blockchain;
`MONGODB_URI` selects the MongoDB host. The launcher generates the local certificate
before starting Vite and configures trusted HTTPS for the Python client. Once a job is
submitted and matched, the server drives it through every phase to payout by itself
(see [Phase orchestration](#phase-orchestration)).

## Quick start

The simplest path is `python3 startup.py --shell`, which starts the chain, the real server, the frontend and a client. To drive the contract by hand instead, playing the buyer yourself:

```bash
# 1. Fresh chain + deploy (restart it after any contract change)
cd blockchain && npm run dev

# 2. Real server: matches providers and drives every phase (needs MongoDB)
cd server && npm run seed && SERVER_PRIVATE_KEY=<from dev.env> npm start

# 3. Provider client
cd client && python3 main.py --dev

# 4. Call contract functions as any account
cd client && python3 dev/contract_controller.py
offbalance> submitJob 1 100 3 2 60 img --value 100     # as buyer: escrows the price
```

`server/dev-server.ts` (`npm run dev:mock`) is still there for client development without MongoDB: it answers the three routes the client calls and hands out the deployed `OffBalance` address, but it doesn't match providers or drive phases.

## Local chain (`blockchain/`)

`npm run dev` starts `hardhat node` on `http://127.0.0.1:8545` (chain ID 31337) and runs `scripts/deploy-local.ts`. Ctrl+C stops it. The script refuses to start if port 8545 is already in use.

| Script | Does |
|---|---|
| `npm run dev` | Fresh node + deploy, in one command |
| `npm run chain` | Node only |
| `npm run deploy:local` | Deploy to a node that's already running |
| `npm test` | Contract tests (`hardhat test`) |

### Same keys and addresses on every start

The node creates its 20 accounts from the public Hardhat mnemonic (`test test ... junk`, set in `hardhat.config.ts` under `networks.node`), with 10,000 ETH each. Contract addresses depend only on the deployer and its nonce. So on a **fresh** node, every machine and every restart gets identical accounts and contract addresses. That's why they can be hardcoded in [`dev.env`](dev.env):

| Alias | Account | Role |
|---|---|---|
| `server` | #0 `0xf39F…2266` | Deploys the contracts, so it becomes `OffBalance.server` |
| `buyer` | #1 `0x7099…79C8` | Submits jobs |
| `p1`–`p4` | #2–#5 | Providers (`PROVIDER_N_PRIVATE_KEY`) |

> ⚠️ These keys are public. Anything sent to them on a real network is stolen within seconds. Local use only.

Deploying onto a node that already has transactions shifts the addresses away from `dev.env`; the deploy script prints a warning when that happens. Restart with `npm run dev` to get the canonical ones back.

### Deployment output

The deploy writes `blockchain/deployments/localhost.json`, which is gitignored and regenerated on every deploy:

```json
{ "chainId": 31337, "address": "0x5FbD…", "deployer": "0xf39F…", "abi": [...] }
```

This is the source of truth for the local address and ABI. The servers read the address from it, and the client reads the ABI from it, so both stay correct even when the address has shifted.

## Provider client (`client/`)

```bash
python3 main.py                          # prompts for API key + session key
python3 main.py --dev                    # provider 1, keys from dev.env
python3 main.py --dev --provider 2       # run as provider 2 (start several to simulate many providers)
```

The client always needs a server: it gets the contract address from `GET /contract_address` and posts its benchmark to `POST /scores`. Locally that's the real server (`npm start`, port 5000) or the route mock (`npm run dev:mock`). The client reads the ABI from `deployments/localhost.json`.

`--dev` only changes where credentials come from:
- the session key is `PROVIDER_N_PRIVATE_KEY` from `dev.env`;
- the API key is `OFFBALANCE_API_KEY` if set, otherwise `dev` for provider 1 and `dev2`–`dev4` for providers 2–4 (seeded by the real server; the mock accepts any token).

Outside `--dev`, any prompt can be skipped with an env var: `OFFBALANCE_API_KEY`, `PROVIDER_PRIVATE_KEY`, `OFFBALANCE_ADDRESS` (skips the server lookup), `OFFBALANCE_SERVER_URL`, `RPC_URL`.

The client polls for new blocks every second. It only sees events from blocks mined **after** it starts, so start the client before firing events.

### Running a job

1. `PROVIDER_SELECTED` for this provider: the client fetches the job manifest from `GET /jobManifest/:jobId` and prepares `~/.offbalance/jobs/<jobId>/output/`.
2. `COMMIT_PHASE_START`: `RunManager` runs the manifest's `image` + `command` in a container, on a background thread. It pulls the image if it's missing.
   - The host output folder is mounted at **`/output`** inside the container. The job must write its result there; stdout is ignored.
   - The container runs as your uid:gid, so the files it writes are yours.
   - Networking is off unless the manifest has an `input_url`.
   - It's killed if it runs past the deadline (`status="timeout"`).
3. On success, `RunManager.hash_dir` hashes the output folder (sha256 over sorted relative paths and file contents; symlinks aren't followed). `BlockchainManager.commit` sends `submitCommitment` with `keccak256(abi.encode(keccak256(resultHash), salt))` and the stake (`stakeFor`). The salt is derived per job from the provider's key seed.
4. `REVEAL_PHASE_START`: `BlockchainManager.reveal` sends `submitReveal(jobId, resultHash, salt)`. Only the 32-byte result hash goes on-chain, never the output.

The mock server returns the same manifest for every job: alpine running `echo "result for job N" > /output/result.txt`. Edit it in `server/dev-server.ts`. `npm run dev:mock` doesn't reload on changes, so restart it after editing (or use `node --watch`).

### Contract wrapper

All contract access from the client goes through `ProviderContractWrapper` in [`client/blockchain/Contract.py`](client/blockchain/Contract.py). Nothing else touches `contract.functions` / `contract.events`. web3 resolves those names from the ABI at runtime, so type checkers can't catch a misspelled or missing function; keeping them in one file means there's one place to check against the ABI.

Transactions are signed locally with the session key: build the transaction with `"from": signer.address` and `"nonce": get_transaction_count(...)`, sign, send, then wait for the receipt. The nonce is the account's transaction counter, and each transaction must use the next one. The client only runs one job at a time, so it doesn't need a lock. Nothing else may send from the same key at the same time, though, including the contract controller with `--as p1` or a second client with the same `--provider N`. Otherwise you get "nonce too low".

## Contract controller

[`client/dev/contract_controller.py`](client/dev/contract_controller.py) calls functions on the **real** `OffBalance` on the local node, as any dev account. Its commands are built from the contract's ABI, so every contract function is a command and new or changed functions show up without editing the controller.

```bash
python3 dev/contract_controller.py                          # shell
python3 dev/contract_controller.py submitJob 1 100 3 2 60 img --value 100   # one call, then exit
```

Type the function name and its arguments in contract order:

```
offbalance> functions                      # every function, its arguments, and its default sender
offbalance> submitJob 1 100 3 2 60 img --value 100   # jobId price k quorum executionTime image, escrowing 100 wei
offbalance> assignProviders 1 p1,p2,p3               # exactly k providers
offbalance> submitCommitment 1 0xabc… --as p2 --value 100000000000000   # with STAKE
offbalance> REVEAL_WINDOW                            # views/constants are read, not sent
```

| Solidity type | Type it as |
|---|---|
| `uint` / `JobID_t` | `1` or `0xabc` |
| `address` | `p1`–`p4`, `buyer`, `server`, or `0x…` |
| `address[]` | `p1,p2` (comma-separated, no spaces) |
| struct | its fields comma-separated, e.g. `false,0xabc,false` |
| `bytes32` | `0x…` hex |
| `bool` | `true` / `false` |

**Senders.** `submitJob`/`cancelJob` go from `buyer` and `submitCommitment`/`submitReveal` from `p1`. Everything else goes from `server` (account #0, which deployed the contract and so is `OffBalance.server`). Override with `--as WHO`. Payable calls take `--value WEI`.

**Output.** Each transaction prints its block and timestamp, then every event it emitted: the same events your client sees.

**Reverts.** A failing `require` prints `reverted` with its message and leaves the shell running. Use `advance SECONDS` to move chain time past a deadline. Without the real server running, you drive the phases yourself; with it, the server calls them for you (see [Phase orchestration](#phase-orchestration)):

```
submitJob 1 100 3 2 60 img --value 100
assignProviders 1 p1,p2,p3   # PROVIDER_SELECTED ×3, COMMIT_PHASE_START
advance 61                   # commit deadline = assign time + executionTime
startRevealPhase 1           # REVEAL_PHASE_START
advance 16                   # REVEAL_WINDOW (15 s)
endRevealPhase 1             # CONSENSUS_REACHED + DELIVERY_PHASE_START, or NO_QUORUM
advance 31                   # DELIVERY_WINDOW (30 s)
endDeliveryPhase 1           # PAID / SLASHED, DELIVERED
```

Also: `advance SECONDS`, `mine`, `accounts`, `help`. On startup it warns if `OffBalance` was recompiled after it was deployed; restart `npm run dev` to redeploy.

## Real server (`server/server.ts`)

Needs MongoDB (`MONGODB_URI`, default `mongodb://127.0.0.1:27017/offbalance`). The chain is optional: if the node or deployment file isn't there it logs a warning and runs database-only (`CHAIN=off` to skip the check).

```bash
cd server
npm run seed                                   # dev accounts + API keys from dev.env, job 1 fixture (idempotent)
SERVER_PRIVATE_KEY=<SERVER_PRIVATE_KEY from dev.env> npm start   # port 5000
```

Seeded API keys: `dev`, `dev2`, `dev3`, `dev4` are providers 1–4 (matching `python3 main.py --dev --provider N`), `dev-buyer` is the buyer.

**Job flow.** `POST /jobs` saves the job and reserves its on-chain id → the buyer's wallet calls `submitJob(id, …)` → on `JOB_SUBMITTED` the matcher picks the cheapest `k` idle providers that meet the requirements and are priced at or under `maxPrice`, saves them, and calls `assignProviders` → phase events (`COMMIT_PHASE_START`, …, `DELIVERED`) update the job's status, and the server drives each phase transition (below) → in the delivery phase providers `POST /provider/results/:jobId` and the server calls `verifyReceipt`. A provider is only matched once it has posted `/scores` (the client does) **and** set a price (`POST /provider/price {"price": 1}`). The matcher also reruns when a provider scores or prices, and when a job finishes.

| Routes | |
|---|---|
| `GET /auth/nonce?wallet=`, `POST /auth {wallet, signature}`, `POST /auth/logout` | Sign in with a wallet (a new wallet signs up). The token is the web session **and** the client's API key |
| `GET /contract_address`, `POST /scores`, `GET /jobManifest/:jobId` | Provider client (manifest: assigned providers only) |
| `POST /jobs`, `GET /jobs[?role=provider]`, `GET /jobs/:jobId`, `POST /jobs/:jobId/cancel`, `GET /jobs/:jobId/result` | Buyers; `:jobId` is the on-chain id |
| `GET /provider/tutorial`, `GET /provider/hardware` (with a suggested price), `POST /provider/price`, `POST /provider/results/:jobId` | Providers |
| `GET /account/:id/dashboard`, `POST /account/:id/wallets`, `DELETE /account/:id/wallets/:wallet`, `DELETE /account/:id` | Own account only; `:id` may be `me` |
| `POST /images/resolve`, `POST /builds`, `GET /builds`, `GET /builds/:buildId` | Job images (below) |

### Phase orchestration

The contract has no timers: its phase transitions are public functions that only succeed once a deadline has passed in chain time. The server calls them ([`server/services/orchestrator.ts`](server/services/orchestrator.ts)). Each phase's start event schedules the next transition:

| Event | Server calls, once chain time passes | Deadline |
|---|---|---|
| `COMMIT_PHASE_START` | `startRevealPhase` | `commitDeadline` = assign time + the job's execution time |
| `REVEAL_PHASE_START` | `endRevealPhase` (consensus; `NO_QUORUM` ends the job) | `revealDeadline` (+`REVEAL_WINDOW`, 15 s) |
| `DELIVERY_PHASE_START` | `endDeliveryPhase` (payout) | `deliveryDeadline` (+`DELIVERY_WINDOW`, 30 s) |

Deadlines come from the contract's `getDeadlines`, so the windows live only in `OffBalance.sol`. The server waits until one second past the deadline in chain time. If the call reverts with "… not ended", chain time hasn't caught up yet and it checks again. "Not in … phase" means someone else already advanced the job (anyone may call these functions), so it leaves the job alone. Any other failure is retried with backoff. Pending timers live in memory, so a server restart forgets them.

### Job images and the Docker registry

Every provider must run byte-identical code, so a job's image is always pinned by digest to one platform (`IMAGE_PLATFORM`, default `linux/amd64`). `POST /jobs` takes exactly one of:

- `image`: any reference (`python:3.12`, `ghcr.io/org/app:v2`). The server looks it up in its registry and pins it (`docker.io/library/python@sha256:…`). It must be public, because providers pull it themselves.
- `buildId`: a finished build. `POST /builds` takes JSON `{"dockerfile": "FROM …"}` (no build context, so no `COPY` of local files) or a tar / tar.gz body with a `Dockerfile` at its root (`Content-Type: application/gzip`, up to `BUILD_MAX_CONTEXT_MB`, default 50). The server builds it with its own `docker` CLI, pushes it to the registry and pins it. It answers `202`; poll `GET /builds/:buildId` until `DONE` (use `build.image`) or `FAILED` (see `error` and `log`).
- `dockerImageDigest`: an already-pinned `repo@sha256:…`, used as is.

Resolving public images needs no credentials. Builds need a registry to push to, and stay off until `REGISTRY_NAMESPACE` is set. Any OCI registry works:

| | `REGISTRY` | `REGISTRY_NAMESPACE` | `REGISTRY_USERNAME` | `REGISTRY_TOKEN` |
|---|---|---|---|---|
| Docker Hub | `docker.io` (default) | your user or org | your user | a personal access token (Read & Write) |
| GitHub | `ghcr.io` | your user or org | your user | a PAT with `write:packages` |
| Local `registry:2` | `localhost:5001` | anything, e.g. `offbalance` | | |

Images go to `<REGISTRY>/<REGISTRY_NAMESPACE>/<REGISTRY_REPOSITORY>:build-<id>` (repository default `offbalance-jobs`). **Make that repository public** (on GHCR, new packages start private), or providers can't pull. The server logs in with its own docker config (`DOCKER_CONFIG_DIR`, default `~/.offbalance/server-docker-config`), so the token never lands in your `~/.docker`. For local dev without an account:

```bash
docker run -d --rm --name registry -p 5001:5000 registry:2
REGISTRY=localhost:5001 REGISTRY_NAMESPACE=offbalance npm start
```

Builds run `RUN` steps from buyers' Dockerfiles on the server machine (inside build containers), so run the server somewhere you're happy to dedicate to that.

`npm run test:real` needs MongoDB running and `npm run seed` done first. [`server/test/api.test.ts`](server/test/api.test.ts) covers the rest of the API. It runs when `MONGODB_URI` is set and uses a throwaway database: `MONGODB_URI=mongodb://127.0.0.1:27017 node --test test/api.test.ts`.

## Server contract tests (`server/test/`)

The client depends on three server routes. [`server/test/client-contract.test.ts`](server/test/client-contract.test.ts) sends exactly what the client sends and checks what the client reads back. The same suite runs against the dev mock and the real server, so the real server is done when it passes the tests the mock already passes.

```bash
cd server
npm run test:dev     # against dev-server.ts: must always pass
npm run test:real    # real HTTPS API + Python client, isolated MongoDB fixture
npm test             # typecheck, managers, unit, mock, database, HTTPS and end-to-end chain tests
npm run test:e2e     # MONGODB_URI=…: real Hardhat node, contract, server orchestrator; about a minute
SERVER_URL=https://localhost:5000 NODE_EXTRA_CA_CERTS="$PWD/.local/tls/cert.pem" node --test test/client-contract.test.ts
```

| Route | The tests require |
|---|---|
| all three | `401` without `Authorization: Bearer <key>` |
| `GET /contract_address` | `200 { "address": "0x…" }` (40 hex chars) |
| `POST /scores` | Form-encoded `cpu`, `gpu`, `mem` (not JSON; that's what python `requests` sends). `gpu` may be missing, because `requests` drops `None`. 2xx on success, `400` if `cpu` or `mem` is missing |
| `GET /jobManifest/:jobId` | `200 { "manifest": { jobId, image, command: string[], env: {string: string} \| null, input_url: string \| null, timeout_s, cpu_limit, mem_limit_mb } }` with positive numbers. `400` for a jobId that isn't a non-negative integer |

The suite starts the server file itself on a free port, so **the server must listen on `process.env.PORT`**. It also sets `DEPLOYMENT_FILE` to a fake deployment, so the dev server doesn't need a running chain. For the real server, `TEST_API_KEY` sets a valid API key (default `dev`) and `TEST_JOB_ID` sets a job that exists (default `1`).

When the client starts calling a new route or reading a new field, add it here first. The dev server then has to match, and so will the real one.

## Known gaps

- `BlockchainManager.event_types` doesn't subscribe to `JOB_SUBMITTED`, `CONSENSUS_VERIFICATION_START`, `PAID`, `SLASHED` or `NO_QUORUM`. Those events are silently ignored until they're added there and to `event_class_factory`.
- On startup, the client's first poll includes the current block, so it can replay that block's events.
- `COMMIT_PHASE_START`'s `deadline` is the job's `executionTime` (a duration), not the absolute `commitDeadline` timestamp.
- The server's phase timers live in memory: after a restart, jobs already in progress aren't driven until someone calls the transition (anyone can, e.g. with the contract controller).
- Every provider stakes the same `STAKE`; `stakeFor` is where reputation will scale it.
- The server's buyer `totalSpent` is booked at the job's `runningPrice`, not from the contract's amounts.
- The server's job statuses (`PENDING`, `COMMIT_PHASE`, …) differ from the contract's `Status` enum. The event → status mapping is in `server/models/JobStatus.ts`.
- Results aren't stored by the server: providers upload to object storage themselves and post the `location`.
- Builds run one at a time with no per-account limit, and a server restart fails builds in progress (they have to be resubmitted). Pushed `build-*` tags are never deleted from the registry.

## TODO

1. Persist phase deadlines so the orchestrator resumes in-progress jobs after a server restart. `startup.py` starts the local chain, HTTPS server, frontend and client; MongoDB must already be running.
