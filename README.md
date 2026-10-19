# OffBalance

## Repo layout

| Path | What it is |
|---|---|
| `blockchain/` | Hardhat 3 project: the `OffBalance` contract, a dev-only event mock, and deploy scripts |
| `client/` | Python provider client: benchmarks the machine, listens for contract events, runs jobs in Docker and commits the result hash |
| `client/dev/` | Dev tools for the client: the event controller (drives the mock) and the contract controller (drives the real contract) |
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
The existing mock workflows below remain available through `server/npm run dev:mock`.

`startup.py --shell` now launches the real HTTPS API instead of the mock. It needs
MongoDB running and the existing Node/Python prerequisites. Each launch creates a
fresh, retained development database to match its newly started local blockchain;
`MONGODB_URI` selects the MongoDB host. The launcher generates the local certificate
before starting Vite and configures trusted HTTPS for the Python client. Full
reveal/consensus/delivery/payment behavior remains unfinished in the client/contract.

## Quick start

There are two ways to drive a client locally. Both use the same chain and mock server; the mock server's `CONTRACT` setting decides which contract the client listens to.

| | Mock contract (default) | Real contract |
|---|---|---|
| Mock server | `npm run dev:mock` | `CONTRACT=real npm run dev:mock` |
| Client listens to | `OffBalanceEventMock` (`0xe7f1…0512`) | `OffBalance` (`0x5FbD…0aa3`) |
| You drive it with | `dev/event_controller.py` | `dev/contract_controller.py` |
| Good for | Any event in any order, instantly; testing how the client reacts | The full job: the client's transactions (`submitCommitment`, …) actually hit the contract |
| Client transactions | **Fail**: the mock has no `submitCommitment` etc. | Work, subject to the contract's `require`s |

### Mock contract: fire events at the client

Use four terminals:

```bash
# 1. Start a fresh local chain and deploy the contracts
cd blockchain && npm run dev

# 2. Start the mock server (hands out the event mock's address by default)
cd server && npm run dev:mock

# 3. Run a provider client (start this BEFORE firing events)
cd client && python3 main.py --dev

# 4. Fire events at it
cd client && python3 dev/event_controller.py
events> assign 1 p1        # client prints "I was selected!"
events> flow 2 p1 p2       # whole job lifecycle, with pauses between phases
```

### Real contract: play the buyer and the server yourself

```bash
# 1. Fresh chain + deploy (restart it after any contract change)
cd blockchain && npm run dev

# 2. Mock server handing out the real OffBalance
cd server && CONTRACT=real npm run dev:mock

# 3. Provider client
cd client && python3 main.py --dev

# 4. Call contract functions as any account
cd client && python3 dev/contract_controller.py
offbalance> submitJob 1 100 3 2 60     # as buyer
offbalance> assignProviders 1 p1       # as server: client fetches the manifest, runs the job, commits
offbalance> advance 61                 # past the commit deadline
offbalance> startRevealPhase 1
```

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
{ "chainId": 31337, "address": "0x5FbD…", "deployer": "0xf39F…", "abi": [...],
  "eventMock": { "address": "0xe7f1…", "abi": [...] } }
```

This is the source of truth for local addresses and ABIs. The mock server reads the address from it on every request, and the client reads the ABI from it, so both stay correct even when the addresses have shifted.

## Provider client (`client/`)

```bash
python3 main.py                          # prompts for API key + session key
python3 main.py --dev                    # provider 1, keys from dev.env
python3 main.py --dev --provider 2       # run as provider 2 (start several to simulate many providers)
```

The client always needs a server: it gets the contract address from `GET /contract_address` and posts its benchmark to `POST /scores`. Locally, that's the mock server in `server/` (`npm run dev:mock`, port 5000). It hands out `OffBalanceEventMock` by default; start it with `CONTRACT=real` to hand out `OffBalance` instead. The client picks the matching ABI from `deployments/localhost.json`.

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
3. On success, `RunManager.hash_dir` hashes the output folder (sha256 over sorted relative paths and file contents; symlinks aren't followed) and `BlockchainManager.commit` sends it with `submitCommitment`. The 32-byte hash is converted to a `uint256`, because `Commitment_t` is a `uint256`.

The mock server returns the same manifest for every job: alpine running `echo "result for job N" > /output/result.txt`. Edit it in `server/dev-server.ts`. `npm run dev:mock` doesn't reload on changes, so restart it after editing (or use `node --watch`).

### Contract wrapper

All contract access from the client goes through `ProviderContractWrapper` in [`client/blockchain/Contract.py`](client/blockchain/Contract.py). Nothing else touches `contract.functions` / `contract.events`. web3 resolves those names from the ABI at runtime, so type checkers can't catch a misspelled or missing function; keeping them in one file means there's one place to check against the ABI.

Transactions are signed locally with the session key: build the transaction with `"from": signer.address` and `"nonce": get_transaction_count(...)`, sign, send, then wait for the receipt. The nonce is the account's transaction counter, and each transaction must use the next one. The client only runs one job at a time, so it doesn't need a lock. Nothing else may send from the same key at the same time, though, including the contract controller with `--as p1` or a second client with the same `--provider N`. Otherwise you get "nonce too low".

## Event mocking and the event controller

**Why.** The client is driven entirely by contract events (`PROVIDER_SELECTED`, `REVEAL_PHASE_START`, …). The real contract's state transitions are guarded by deadlines, caller checks and job state, so reaching the reveal phase means playing out an entire job (which the [contract controller](#contract-controller) does). The mock skips all of that.

**What.** [`OffBalanceEventMock.sol`](blockchain/contracts/OffBalanceEventMock.sol) is a dev-only contract with the **exact same event declarations** as `OffBalance`, plus one function per event that just emits it, with no state or checks. An event log is identified by the hash of its signature plus its encoded arguments, so the client can't tell a mock event from a real one. The only difference is the emitting address, which is why the mock server's `CONTRACT` setting decides which contract the client listens to.

```
dev/event_controller.py ──tx──▶ OffBalanceEventMock ──emits──▶ REVEAL_PHASE_START(42)
                                                                      │
                          main.py --dev         ◀──polls logs─────────┘
```

**Controller commands.** `JOB` is a job ID number. `WHO` is `p1`–`p4`, `server`, `buyer`, or a `0x` address. Type `help` in the shell for the full list. You can also run one command at a time: `python3 dev/event_controller.py flow 1 p1`.

| Command | Emits |
|---|---|
| `submit JOB` | `JOB_SUBMITTED` |
| `select JOB WHO..` | `PROVIDER_SELECTED` for each provider |
| `assign JOB WHO..` | `PROVIDER_SELECTED` for each, then `COMMIT_PHASE_START` (like `assignProviders`) |
| `assign JOB WHO.. --deadline D` | Same, with `COMMIT_PHASE_START`'s `deadline` set to `D` (default 60) |
| `commit JOB [DEADLINE]` | `COMMIT_PHASE_START` (deadline defaults to 60) |
| `reveal` / `consensus` / `delivery` / `delivered` / `cancel` / `noquorum JOB` | The matching single event |
| `paid JOB WHO` / `slashed JOB WHO` | `PAID` / `SLASHED` |
| `flow JOB WHO.. [--delay S] [--deadline D]` | Full happy path, pausing `S` seconds between phases (default 3) |
| `advance SECONDS` | Moves chain time forward and mines a block, for the real contract's deadlines |
| `mine` | Mines an empty block (emits nothing) |
| `accounts` | Lists aliases |

**What the mock tests, and what it doesn't.** It tests whether the client reacts correctly to any event, in any order, including orders the real contract would never produce. It does **not** test that `OffBalance` emits the right events at the right time; that belongs in Hardhat tests (`npm test`).

**Keeping it in sync.** When you change an event in `OffBalance.sol`, make the same change in `OffBalanceEventMock.sol`. The controller compares the two ABIs' events on startup and refuses to run if they differ. It compares the ABIs saved in `deployments/localhost.json`, not the source, so after editing either contract you also need to restart `npm run dev` before the check passes.

## Contract controller

[`client/dev/contract_controller.py`](client/dev/contract_controller.py) calls functions on the **real** `OffBalance` on the local node, as any dev account. Its commands are built from the contract's ABI, so every contract function is a command and new or changed functions show up without editing the controller.

```bash
python3 dev/contract_controller.py                          # shell
python3 dev/contract_controller.py submitJob 1 100 3 2 60   # one call, then exit
```

Type the function name and its arguments in contract order:

```
offbalance> functions                      # every function, its arguments, and its default sender
offbalance> submitJob 1 100 3 2 60         # jobId price k quorum executionTime
offbalance> assignProviders 1 p1,p2
offbalance> submitCommitment 1 0xabc --as p2
offbalance> REVEAL_WINDOW                  # views/constants are read, not sent
```

| Solidity type | Type it as |
|---|---|
| `uint` / `JobID_t` / `Commitment_t` | `1` or `0xabc` |
| `address` | `p1`–`p4`, `buyer`, `server`, or `0x…` |
| `address[]` | `p1,p2` (comma-separated, no spaces) |
| struct | its fields comma-separated, e.g. `false,0xabc,false` |
| `bytes32` | `0x…` hex |
| `bool` | `true` / `false` |

**Senders.** `submitJob`/`cancelJob` go from `buyer` and `submitCommitment`/`submitReveal` from `p1`. Everything else goes from `server` (account #0, which deployed the contract and so is `OffBalance.server`). Override with `--as WHO`.

**Output.** Each transaction prints its block and timestamp, then every event it emitted: the same events your client sees.

**Reverts.** A failing `require` prints `reverted` and leaves the shell running. The contract's `require`s have no messages yet, so it can't say which one failed. Usually it's the wrong sender (`--as`), the wrong phase, or a deadline that hasn't passed. Use `advance SECONDS` to move chain time forward. A full job:

```
submitJob 1 100 3 2 60
assignProviders 1 p1     # PROVIDER_SELECTED, COMMIT_PHASE_START
advance 61               # commit deadline = assign time + executionTime
startRevealPhase 1       # REVEAL_PHASE_START
advance 121              # REVEAL_WINDOW
endRevealPhase 1         # DELIVERY_PHASE_START
advance 301              # DELIVERY_WINDOW
endDeliveryPhase 1       # DELIVERED
```

Also: `advance SECONDS`, `mine`, `accounts`, `help`. On startup it warns if `OffBalance` was recompiled after it was deployed; restart `npm run dev` to redeploy.

## Server contract tests (`server/test/`)

The client depends on three server routes. [`server/test/client-contract.test.ts`](server/test/client-contract.test.ts) sends exactly what the client sends and checks what the client reads back. The same suite runs against the dev mock and the real server, so the real server is done when it passes the tests the mock already passes.

```bash
cd server
npm run test:dev     # against dev-server.ts: must always pass
npm run test:real    # real HTTPS API + Python client, isolated MongoDB fixture
npm test             # typecheck, managers, unit, mock, database and HTTPS tests
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
- `OffBalance`'s functions are now `public` so they can be called from outside. `calculateConsensus` and `payWinnersAndSlashLosers` are public too but have no caller check, so anyone can run them. They're only meant to be called from `endRevealPhase` / `endDeliveryPhase`, so they should go back to `private`.
- `submitCommitment` and `submitReveal` don't store anything yet. On the client side, `submitReveal` only builds the call and never sends it.
- `COMMIT_PHASE_START`'s `deadline` is the job's `executionTime` (a duration), not the absolute `commitDeadline` timestamp.
- `require`s have no revert messages.
- `OffBalanceEventMock` has no provider functions, so a client listening to it crashes when it tries to commit. Use `CONTRACT=real` to test commits.
- `Commitment_t` is a `uint256`, so the client converts its 32-byte sha256 to an int. A `bytes32` would fit the hash directly.
- The Python execution loop does not yet send the heartbeats required for automatic provider matching.
- Provider reveal/delivery behavior and contract consensus/payment logic are unfinished; connected API and browser tests do not establish full job settlement.

## TODO

1. Complete provider heartbeat/reveal/delivery and contract consensus/payment behavior. `startup.py` starts the local chain, HTTPS server, frontend and client; MongoDB must already be running.
