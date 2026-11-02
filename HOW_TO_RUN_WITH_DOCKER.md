# How to run OffBalance with Docker

Everything runs in containers, and the whole system can span several machines on the same network:

- **One host machine** runs the blockchain, the server, the database and a UI.
- **Any number of client machines** each run a provider client and their own UI, which talk to the host.

A single machine can also be both. See [Provider on the host](#a-provider-on-the-host-machine).

| Mode | Command | What it starts |
|---|---|---|
| Host | `docker compose --profile host up --build` | Hardhat chain (`:8545`), server (`https://HOST_ADDRESS:5000`), MongoDB (internal only), UI (`http://localhost:5173`) |
| Client | `PROVIDER=2 docker compose --profile client up --build` | UI (`http://localhost:5173`) and provider client N, both talking to the host |

## 1. Prerequisites (every machine)

- **Docker** with Compose v2: Docker Desktop on macOS/Windows, or Docker Engine plus the compose plugin on Linux. Check with `docker compose version`.
- **This repo**, on the same branch on every machine. The host and the clients must run the same contract code.
- **The same network** as the host, or at least able to reach the host's IP.
- **MetaMask**, only if you'll use the UI. See [§5](#5-metamask).

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

On each client machine, after the host is up:

```bash
PROVIDER=2 docker compose --profile client up --build
```

- `PROVIDER` picks the dev provider account from `dev.env` (`1`–`4`). **Every machine must use a different number.** Two clients on the same account clash on transaction nonces.
- First a one-off `fetch-cert` container waits for the host's server and trusts its TLS certificate. Then the provider client and the UI start.
- The client benchmarks the machine, registers with the server and starts watching the chain for jobs.
- The UI is at `http://localhost:5173`. It proxies API calls to the host.

### A provider on the host machine

The host can also run a provider. Use a number no client machine is using:

```bash
PROVIDER=1 docker compose --profile host --profile host-provider run --rm host-client
```

`--profile host-provider` is required. The comment at the top of `docker-compose.yml` leaves it out, and the command fails without it.

### Contract controller shell (host)

To make contract calls by hand, for example moving chain time forward or reading a job:

```bash
docker compose --profile host --profile host-provider run --rm --no-deps \
  --entrypoint python host-client dev/contract_controller.py
```

## 5. MetaMask

Follow [frontend/METAMASK_SETUP.md](frontend/METAMASK_SETUP.md), with one change on **client machines**.

**Set the network's RPC URL to `http://HOST_ADDRESS:8545`**, for example `http://10.18.30.31:8545`. Don't use `http://127.0.0.1:8545`: that only works on the host itself. With the wrong RPC, MetaMask reads a different chain (or none). The chain ID (31337) matches either way, so nothing warns you; calls just come back empty, with errors like `Cannot decode zero data ("0x")`.

Which account to import:

| You want to… | Import |
|---|---|
| Submit jobs (buyer) | `BUYER_PRIVATE_KEY` |
| See and collect a provider's earnings | `PROVIDER_N_PRIVATE_KEY` for the `PROVIDER=N` that machine runs. Earnings are paid to the provider client's address, so **Collect funds** only works from that account. |

**Recommended on the dev chain:** in MetaMask, under Settings → Security & privacy, turn off **Security alerts** and **Estimate balance changes**. Those features run on MetaMask's servers, which can't simulate a local chain. With them on, MetaMask shows a vague "An error occurred" even though the transaction succeeds.

## 6. Restarting and updating

**Every host start is a fresh chain and a fresh database.** Previous jobs, accounts and balances are gone. After restarting the host:

1. **Restart every client.** Clients from before the restart watch a chain that no longer exists.
2. **In MetaMask, clear the activity data** on each machine: Settings → Advanced → Clear activity tab data. MetaMask remembers old transaction counts; without this you get nonce errors or "Internal JSON-RPC error".

**After pulling code changes, always rebuild with `--build`.** The contract is compiled when the image is built. Without `--build`, the host keeps serving the old contract, and the clients fail with errors like `KeyError: 'deadline'` or `function selector was not recognized`. Rebuild the host first, then the clients:

```bash
git pull
docker compose --profile host down
docker compose --profile host up --build      # host
PROVIDER=2 docker compose --profile client up --build   # each client, after the host
```

Stop with `docker compose --profile host down`, or `--profile client down` on clients.

## 7. How a job runs

What to expect, so you can tell when something is stuck:

1. The buyer submits a job in the UI, and MetaMask escrows the price.
2. The server matches idle providers and assigns them on chain.
3. **Commit.** Providers run the container and commit a hash of the result. This lasts the job's execution time.
4. **Reveal,** about 15 s. Providers reveal their results, and the contract checks for agreement.
5. **Delivery,** about 30 s. Providers upload the result to the server.
6. **Settlement.** Winners are paid their share and get their stake back as credits, collected with **Collect funds** in the provider view. With no quorum, the buyer and every provider that committed are refunded.

The server moves each job through these phases by itself. Its logs show `Job N: startRevealPhase in Xs` and `… done` for each step.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Client: `KeyError: 'deadline'`; UI: `function selector was not recognized` | The host is running an older contract than the code | Pull on the host and run `up --build` there, then restart the clients |
| `fetch-cert` keeps printing `waiting for https://…:5000` | Host isn't up, `HOST_ADDRESS` is wrong, or a firewall is blocking port 5000 | Check host mode is running, check `.env`, and open the ports (§3) |
| Client can't reach the chain (timeouts on `:8545`) | Port 8545 is closed on the host, or the host's IP changed | Open the port, and check the host's IP (below) |
| `Cannot decode zero data ("0x")` in the UI | MetaMask's RPC points at the wrong chain | Set its RPC URL to `http://HOST_ADDRESS:8545` (§5) |
| "Internal JSON-RPC error" / nonce errors in MetaMask | The chain was restarted, but MetaMask kept old transaction counts | Settings → Advanced → Clear activity tab data |
| Collect funds is disabled with "Earnings are paid to your provider client's address…" | The connected account isn't the provider's | Import and switch to `PROVIDER_N_PRIVATE_KEY` (§5) |
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
