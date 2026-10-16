# OffBalance

## Repo layout

| Path | What it is |
|---|---|
| `blockchain/` | Hardhat 3 project: the `OffBalance` contract, a dev-only event mock, and deploy scripts |
| `client/` | Python provider client: benchmarks the machine, listens for contract events, and will run jobs |
| `client/dev/` | Dev tools for the client (the event controller) |
| `server/` | Backend API (not wired up yet) |
| `frontend/` | React dashboard |
| `dev.env` | Fixed local-dev addresses and private keys, shared by every part of the app |

## Prerequisites

- Node.js 22+ (Hardhat 3 requirement), then `cd blockchain && npm install`
- Python 3.12 with a venv in `client/.venv`:
  ```bash
  cd client && python3 -m venv .venv && source .venv/bin/activate
  pip install web3 requests
  ```

## Quick start: local chain + client + event controller

Use three terminals:

```bash
# 1. Start a fresh local chain and deploy the contracts
cd blockchain && npm run dev

# 2. Run a provider client against the event mock (start this BEFORE firing events)
cd client && python3 main.py --dev --mock

# 3. Fire events at it
cd client && python3 dev/event_controller.py
events> assign 1 p1        # client prints "I was selected!"
events> flow 2 p1 p2       # whole job lifecycle, with pauses between phases
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

This is the source of truth for local addresses and ABIs. The client reads it in `--dev` mode, so it stays correct even when the addresses have shifted.

## Provider client (`client/`)

```bash
python3 main.py                                  # real flow: prompts for API key + session key, asks server for contract
python3 main.py --dev                            # local chain, provider 1, listens to the real OffBalance, no server
python3 main.py --dev --mock                     # same, but listens to OffBalanceEventMock
python3 main.py --dev --mock --provider 2        # run as provider 2 (start several to simulate many providers)
```

`--dev` means:
- the key is `PROVIDER_N_PRIVATE_KEY` from `dev.env`;
- the contract address and ABI come from `deployments/localhost.json`;
- there's no server, so the benchmark is printed instead of posted.

Outside `--dev`, any prompt can be skipped with an env var: `OFFBALANCE_API_KEY`, `PROVIDER_PRIVATE_KEY`, `OFFBALANCE_ADDRESS` (skips the server lookup), `OFFBALANCE_SERVER_URL`, `RPC_URL`.

The client polls for new blocks every second. It only sees events from blocks mined **after** it starts, so start the client before firing events.

## Event mocking and the event controller

**Why.** The client is driven entirely by contract events (`PROVIDER_SELECTED`, `REVEAL_PHASE_START`, …). The real contract can't easily produce them on demand. Most of its state-transition functions are currently `private`, and they're guarded by deadlines, caller checks and job state, so reaching the reveal phase would mean playing out an entire job.

**What.** [`OffBalanceEventMock.sol`](blockchain/contracts/OffBalanceEventMock.sol) is a dev-only contract with the **exact same event declarations** as `OffBalance`, plus one function per event that just emits it, with no state or checks. An event log is identified by the hash of its signature plus its encoded arguments, so the client can't tell a mock event from a real one. The only difference is the emitting address, which is why the client needs `--mock`.

```
dev/event_controller.py ──tx──▶ OffBalanceEventMock ──emits──▶ REVEAL_PHASE_START(42)
                                                                      │
                          main.py --dev --mock  ◀──polls logs─────────┘
```

**Controller commands.** `JOB` is a job ID number. `WHO` is `p1`–`p4`, `server`, `buyer`, or a `0x` address. Type `help` in the shell for the full list. You can also run one command at a time: `python3 dev/event_controller.py flow 1 p1`.

| Command | Emits |
|---|---|
| `submit JOB` | `JOB_SUBMITTED` |
| `select JOB WHO..` | `PROVIDER_SELECTED` for each provider |
| `assign JOB WHO..` | `PROVIDER_SELECTED` for each, then `COMMIT_PHASE_START` (like `assignProviders`) |
| `commit` / `reveal` / `consensus` / `delivery` / `delivered` / `cancel` / `noquorum JOB` | The matching single event |
| `paid JOB WHO` / `slashed JOB WHO` | `PAID` / `SLASHED` |
| `flow JOB WHO.. [--delay S]` | Full happy path, pausing `S` seconds between phases (default 3) |
| `advance SECONDS` | Moves chain time forward and mines a block, for the real contract's deadlines |
| `mine` | Mines an empty block (emits nothing) |
| `accounts` | Lists aliases |

**What the mock tests, and what it doesn't.** It tests whether the client reacts correctly to any event, in any order, including orders the real contract would never produce. It does **not** test that `OffBalance` emits the right events at the right time; that belongs in Hardhat tests (`npm test`).

**Keeping it in sync.** When you change an event in `OffBalance.sol`, make the same change in `OffBalanceEventMock.sol`. The controller compares the two ABIs' events on startup and refuses to run if they differ.

## Known gaps

- `BlockchainManager.event_types` doesn't subscribe to `JOB_SUBMITTED`, `CONSENSUS_VERIFICATION_START`, `PAID`, `SLASHED` or `NO_QUORUM`. Those events are silently ignored until they're added there and to `event_class_factory`.
- On startup, the client's first poll includes the current block, so it can replay that block's events.
- Most `OffBalance` functions are `private`, so they can't be called from outside the contract yet.
- `server/` has no `/contract_address` or `/scores` routes yet, so the non-`--dev` client flow can't complete.

## TODO

1. One script that starts every part of the app: local chain, server, MongoDB, frontend. `blockchain/scripts/dev.sh` covers the chain.
