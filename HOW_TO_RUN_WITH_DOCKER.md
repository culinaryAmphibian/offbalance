# How to run OffBalance with Docker

Everything runs in containers, and the whole system can span several machines on the same network:

- **One host machine** runs the blockchain, the server, the database and a UI.
- **Any number of client machines** each run a provider client and their own UI, which talk to the host.

A single machine can also be both. See [Provider on the host](#a-provider-on-the-host-machine).

| Mode | Command | What it starts |
|---|---|---|
| Host | `docker compose --profile host up --build` | Hardhat chain (`:8545`), server (`https://HOST_ADDRESS:5000`), MongoDB (internal only), UI (`http://localhost:5173`) |
| Client | `docker compose --profile client run --build --rm client` | UI (`http://localhost:5173`) and the provider client, which asks for your API key and session key. Both talk to the host |

## 1. Prerequisites (every machine)

- **Docker** with Compose v2: Docker Desktop on macOS/Windows, or Docker Engine plus the compose plugin on Linux. Check with `docker compose version`.
- **This repo**, on the same branch on every machine. The host and the clients must run the same contract code.
- **The same network** as the host, or at least able to reach the host's IP.
- **MetaMask**. Providers need it too: the UI is where you get the API key and authorize the client's session key. See [§5](#5-metamask).

## 2. Configure `.env` (every machine)

Create a `.env` file in the repo root on **every** machine, host included, containing the **host's** LAN IP:

```bash
cp .env.example .env
# then edit it:
HOST_ADDRESS=10.18.30.31
```

To find the host's IP, run this **on the host**:

| OS | Command |
|---|---|
| Linux | `ip -br addr`. Use the interface that's `UP` and isn't `lo`. Or `hostname -I` |
| macOS | `ipconfig getifaddr en0` |

`dev.env`, already in the repo, holds the public Hardhat dev keys and addresses. You don't need to change it.

## 3. Start the host

On the host machine:

```bash
docker compose --profile host up --build
```

The services start in order: MongoDB, then the chain (which deploys the contract), then the server, then the UI. The server is ready once its logs stop showing startup messages and `https://HOST_ADDRESS:5000` answers.

**Open ports 5000 (server) and 8545 (chain) to the network**, or other machines can't connect. On Ubuntu with ufw:

```bash
sudo ufw allow 5000/tcp
sudo ufw allow 8545/tcp
```

The host's own UI is at `http://localhost:5173`.

## 4. Start a client (provider) machine

On each client machine, after the host is up, set up MetaMask ([§5](#5-metamask)), then:

**1. Start everything with one command.**

```bash
docker compose --profile client run --build --rm client
```

In order, this:
1. Runs a one-off `fetch-cert` container, which waits for the host's server and trusts its TLS certificate.
2. Starts the UI at `http://localhost:5173`. It proxies API calls to the host.
3. Starts the provider client, which **waits at a prompt** for your API key.

Leave it waiting and get the keys from the UI.

**2. Get your two keys from the UI:**

1. Sign in at `http://localhost:5173` and open **Provider setup**.
2. Copy the **Client API key**.
3. Under **Provider client session key**, click **Authorize provider client**. Keep the default 30 days and 0.05 ETH, or change them, and confirm in MetaMask. That one transaction registers the key on the contract and sends it the ETH it needs for gas and stakes.
4. Copy the **session key**. It's shown only once; if you lose it, authorize a new one, which replaces the old one.

**3. Paste the keys into the waiting client:** the API key first, then the session key, which isn't echoed. It checks that the session key is authorized and acts for the same wallet as the API key, then benchmarks the machine, registers with the server and starts watching the chain for jobs. Keep the terminal open. Ctrl+C stops the client but leaves the UI running; `docker compose --profile client down` stops both.

To skip the prompts, put `OFFBALANCE_API_KEY=…` and `OFFBALANCE_SESSION_KEY=…` in `.env`.

**4. Set your hourly price** in Provider setup once the machine's benchmark appears. Machines without a price aren't matched to jobs.

What the session key can and can't do: it signs the client's stake, commit and reveal transactions for your wallet. Earnings and returned stakes go to **your wallet**, and only your wallet can withdraw them (**Collect funds**). **Revoke key** in Provider setup stops it immediately.

### A provider on the host machine

The host can also run a provider. Sign in on the host's UI with a wallet no other machine uses, get the two keys as above, then:

```bash
docker compose --profile host run --rm host-client
```

### Contract controller shell (host)

To make contract calls by hand, for example moving chain time forward or reading a job:

```bash
docker compose --profile host run --rm --no-deps \
  --entrypoint python host-client dev/contract_controller.py
```

## 5. MetaMask

Follow [frontend/METAMASK_SETUP.md](frontend/METAMASK_SETUP.md), with one change on **client machines**.

**Set the network's RPC URL to `http://HOST_ADDRESS:8545`**, for example `http://10.18.30.31:8545`. Don't use `http://127.0.0.1:8545`: that only works on the host itself. With the wrong RPC, MetaMask reads a different chain (or none). The chain ID (31337) matches either way, so nothing warns you; calls just come back empty, with errors like `Cannot decode zero data ("0x")`.

Which account to import:

| You want to… | Import |
|---|---|
| Submit jobs (buyer) | `BUYER_PRIVATE_KEY` |
| Run a provider, and see and collect its earnings | One of the `PROVIDER_N_PRIVATE_KEY`s, a different one on each machine. This is the wallet you authorize the session key with; earnings are paid to it, so **Collect funds** works from it. |

**Recommended on the dev chain:** in MetaMask, under Settings → Security & privacy, turn off **Security alerts** and **Estimate balance changes**. Those features run on MetaMask's servers, which can't simulate a local chain. With them on, MetaMask shows a vague "An error occurred" even though the transaction succeeds.

## 6. Restarting and updating

**Every host start is a fresh chain and a fresh database.** Previous jobs, accounts and balances are gone. After restarting the host:

1. **Authorize a new session key on every provider machine, then restart its client.** The new chain has forgotten the old keys, and clients from before the restart watch a chain that no longer exists.
2. **In MetaMask, clear the activity data** on each machine: Settings → Advanced → Clear activity tab data. MetaMask remembers old transaction counts; without this you get nonce errors or "Internal JSON-RPC error".

**After pulling code changes, always rebuild with `--build`.** The contract is compiled when the image is built. Without `--build`, the host keeps serving the old contract, and the clients fail with errors like `KeyError: 'deadline'` or `function selector was not recognized`. Rebuild the host first, then the clients:

```bash
git pull
docker compose --profile host down
docker compose --profile host up --build      # host
docker compose --profile client run --build --rm client   # each client, after the host; get new keys: the new chain forgot the old ones
```

Stop with `docker compose --profile host down`, or `--profile client down` on clients.

## 7. How a job runs

What to expect, so you can tell when something is stuck:

1. The buyer submits a job in the UI, and MetaMask escrows the price.
2. The server matches idle providers and assigns them on chain. The contract fixes each provider's stake at that moment: 0.006 ETH for a new provider, falling toward 0.001 ETH as its reputation grows.
3. **Staking,** up to 30 s. Each provider client deposits its stake. The server closes staking as soon as everyone has staked. Providers that didn't stake in time are dropped, and if fewer than the required number of agreeing providers remain, the job ends with no quorum and everyone is refunded.
4. **Commit.** Providers run the container and commit a hash of the result. This lasts the job's execution time.
5. **Reveal,** about 15 s. Providers reveal their results, and the contract checks for agreement.
6. **Delivery,** about 30 s. Providers upload the result to the server.
7. **Settlement.** Providers who revealed the agreed result get their stake back plus an equal share of the price and of every slashed stake, as credits collected with **Collect funds**. Providers who staked but gave a different result, or never committed or revealed, lose their stake. With no quorum, the buyer gets the price back and every provider gets its stake back.

The server moves each job through these phases by itself. Its logs show `Job N: finalizeProviderSelection done`, `Job N: startRevealPhase in Xs` and `… done` for each step.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Client: `KeyError: 'deadline'`; UI: `function selector was not recognized` | The host is running an older contract than the code | Pull on the host and run `up --build` there, then restart the clients |
| `fetch-cert` keeps printing `waiting for https://…:5000` | Host isn't up, `HOST_ADDRESS` is wrong, or a firewall is blocking port 5000 | Check host mode is running, check `.env`, and open the ports (§3) |
| Client can't reach the chain (timeouts on `:8545`) | Port 8545 is closed on the host, or the host's IP changed | Open the port, and check the host's IP (below) |
| `Cannot decode zero data ("0x")` in the UI | MetaMask's RPC points at the wrong chain | Set its RPC URL to `http://HOST_ADDRESS:8545` (§5) |
| "Internal JSON-RPC error" / nonce errors in MetaMask | The chain was restarted, but MetaMask kept old transaction counts | Settings → Advanced → Clear activity tab data |
| Collect funds is disabled with "Earnings are paid to 0x…, the wallet your provider client's session key acts for" | MetaMask is on a different account than the one that authorized the session key | Switch MetaMask to that account |
| Client: `Session key … isn't authorized for any wallet, or it has expired` | The key was never authorized, it expired, or the host restarted (a fresh chain forgets every key) | Authorize a new key in Provider setup (§4) and paste it |
| Client: `The API key belongs to wallet X, but the session key acts for Y` | The two keys came from different sign-ins | Sign in with one wallet and copy both keys from it |
| Client: `No input; run the container with -it…` | The provider was started with `up`, which can't prompt | Start it with `docker compose --profile client run --build --rm client` |
| Client: `WARNING: session key has … ETH` / `Staking failed` | The session key can't cover a stake plus gas | Authorize a new key with more funding |
| MetaMask says "An error occurred" but the money arrives | MetaMask's transaction preview can't simulate a local chain | Turn off the two settings in §5. MetaMask's balance also updates with a delay. |
| Client: `result delivery not accepted yet …; retrying` | Normal at the start of delivery: the server hasn't opened the job yet | It retries for about 25 s. Any other message names the real reason. |
| Everything worked, then clients suddenly can't connect | The host's IP changed (DHCP) | See below |

### The host's IP address

The network hands out IPs on **4-hour DHCP leases**. A connected machine renews automatically and normally keeps its IP. It can change after the host has been offline or asleep for a while. To check on the host:

```bash
ip -br addr                                                 # current IP (Linux)
ip -4 addr show | grep valid_lft                            # seconds left on the lease
nmcli -f DHCP4 device show <interface> | grep -i lease_time # full lease length (NetworkManager)
```

If the IP changed, update `HOST_ADDRESS` in `.env` on **every** machine and in each client's MetaMask RPC URL, then restart. For a permanent address, ask whoever runs the network for a DHCP reservation for the host's MAC address.
