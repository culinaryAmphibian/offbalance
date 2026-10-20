# MetaMask setup for the local dev chain

How to connect a browser wallet to the local Hardhat chain so you can use the frontend (or send transactions by hand) as one of the dev accounts. The frontend uses whatever wallet is injected as `window.ethereum`, so these steps work for MetaMask and, with minor differences, Rabby.

## 1. Use a separate browser profile

Install MetaMask in a fresh Chrome or Firefox profile that holds no real accounts. The keys below are public Hardhat test keys; keeping them in their own profile means you never sign with a real wallet by mistake.

## 2. Add the Hardhat network

Start the chain first (`python3 startup.py --shell` from the repo root, or `cd blockchain && npm run dev`). MetaMask checks the chain ID when you save the network, so the node must be running.

In MetaMask: network menu → **Add a custom network**:

| Field | Value |
|---|---|
| Network name | Hardhat local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | `ETH` |

These match `RPC_URL` and `CHAIN_ID` in [`../dev.env`](../dev.env).

## 3. Import a dev account

Account menu → **Add account or hardware wallet** → **Import account**, then paste a private key from [`../dev.env`](../dev.env):

| Role | Key in `dev.env` | Address | Notes |
|---|---|---|---|
| Buyer | `BUYER_PRIVATE_KEY` | `0x7099…79C8` | Submits jobs. `contract_controller.py` uses it as `buyer`. |
| Provider 2–4 | `PROVIDER_2..4_PRIVATE_KEY` | see `dev.env` | Provider 1 is used by the client that `startup.py` runs, so pick another one to avoid nonce clashes. |
| Server | `SERVER_PRIVATE_KEY` | `0xf39F…2266` | Deploys the contract and is its `server`. Only import it to test server-only calls. |

Each account starts with 10,000 ETH. The keys are the same on every machine and every node restart, so you only import them once.

> **Never use these keys on a real network.** They are published in Hardhat's docs; anything sent to them on a real chain is taken immediately.

## 4. After every chain restart: clear activity data

`startup.py` and `npm run dev` start a fresh chain each time, but MetaMask remembers each account's old transaction count. Symptoms: `nonce too high` errors, or transactions stuck as pending.

Fix: **Settings → Advanced → Clear activity tab data**. This resets the transaction history only; accounts and the network stay.

## Current limitation: frontend sign-in

The wallet connects and signs the sign-in message, but sign-in then fails: the frontend sends `/auth/nonce`, `/auth/verify` and the job routes to an API on `127.0.0.1:3001` (see [README.md](README.md)), and nothing serves that yet. The dev mock server on port 5000 (`server/dev-server.ts`) only implements the three routes the provider client calls.

Until the server is wired up, either:

- send transactions from MetaMask, or with `client/dev/contract_controller.py`, or
- explore the UI with `npm run dev:demo`, which needs no wallet or backend.
