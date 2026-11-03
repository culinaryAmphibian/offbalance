# How to run OffBalance with Docker

Everything runs in containers, and the whole system can span several machines on the same network:

- **One host machine** runs the blockchain, the server, the database and a UI.
- **Any number of client machines** each run a provider client and their own UI, which talk to the host.

A single machine can also be both. See [Provider on the host](#a-provider-on-the-host-machine).

| Mode | Commands | What it starts |
|---|---|---|
| Host | `docker compose --profile host down`<br>`docker compose --profile host up --build` | Hardhat chain (`:8545`), server (`https://HOST_ADDRESS:5000`), MongoDB (internal only), UI (`http://localhost:5173`) |
| Client | `docker compose --profile client down`<br>`docker compose --profile client run --build --rm client` | UI (`http://localhost:5173`) and the provider client, which asks for your API key and session key. Both talk to the host |

Always run the `down` first. If nothing is running it does nothing; if something is, it clears out containers left over from before (see [§6](#6-restarting-and-updating)).

## 1. Prerequisites (every machine)

- **Docker** with Compose v2: Docker Desktop on macOS/Windows, or Docker Engine plus the compose plugin on Linux. Check with `docker compose version`.
- **This repo**, on the same branch on every machine. The host and the clients must run the same contract code.
- **The same network** as the host, or at least able to reach the host's IP.
- **MetaMask**. Providers need it too: the UI is where you get the API key and authorize the client's session key. See [§5](#5-metamask).

## 2. Configure `.env` (every machine)

Every machine, **the host included**, needs a `.env` file in the repo root containing the **host's current LAN IP**.

**1. Find the host's IP.** Run this **on the host**:

| OS | Command |
|---|---|
| Linux | `hostname -I` (first address), or `ip -br addr` and use the interface that's `UP` and isn't `lo` |
| macOS | `ipconfig getifaddr en0` |

**2. Create `.env` on every machine** and set `HOST_ADDRESS` to that IP:

```bash
cp .env.example .env
```

```bash
# .env, identical on the host and on every client
HOST_ADDRESS=10.26.75.38      # ← the IP from step 1, not this example
```

That's the only required line. Clients can optionally save their keys here too ([§4](#4-start-a-client-provider-machine), step 5).

**Why the host needs it too:** when the server starts, it writes `HOST_ADDRESS` into its TLS certificate. If the host's `.env` has an old IP, the server presents a certificate for that old address. Every client then fails with `certificate verify failed: IP address mismatch`, even when the clients' own `.env` files are correct.

**The host's IP can change** (DHCP, see [below](#the-hosts-ip-address)). Check it each time before you start the host ([§3](#3-start-the-host), step 1).

`dev.env`, already in the repo, holds the public Hardhat dev keys and addresses. You don't need to change it.

## 3. Start the host

On the host machine:

**1. Check that `.env` matches the current IP.** The two outputs must agree:

```bash
grep HOST_ADDRESS .env
hostname -I          # macOS: ipconfig getifaddr en0
```

If they don't, update `HOST_ADDRESS` on **every** machine before continuing.

**2. Start it:**

```bash
docker compose --profile host down
docker compose --profile host up --build
```

The services start in order: MongoDB, then the chain (which deploys the contract), then the server, then the UI. The server is ready once its logs stop showing startup messages and `https://HOST_ADDRESS:5000` answers.

**3. Open ports 5000 (server) and 8545 (chain) to the network**, or other machines can't connect. On Ubuntu with ufw:

```bash
sudo ufw allow 5000/tcp
sudo ufw allow 8545/tcp
```

**4. Check the certificate** from any machine that has `openssl` (a client is the best test). Replace the IP with yours:

```bash
echo | openssl s_client -connect 10.26.75.38:5000 2>/dev/null | openssl x509 -noout -ext subjectAltName
```

The output must include `IP Address:<HOST_ADDRESS>`. If it shows a different IP, the host's `.env` is out of date: fix it and redo step 2. If it prints nothing, the server isn't reachable (step 3).

The host's own UI is at `http://localhost:5173`.

## 4. Start a client (provider) machine

Before you start: the host is up and its certificate check passes ([§3](#3-start-the-host), step 4), this machine's `.env` has the right `HOST_ADDRESS` ([§2](#2-configure-env-every-machine)), and MetaMask is set up ([§5](#5-metamask)).

**1. Start everything:**

```bash
docker compose --profile client down
docker compose --profile client run --build --rm client
```

The `down` matters. The UI loads the host's certificate only when it starts, and keeps running in the background after the client exits. A UI left over from an earlier run can still hold an old certificate, and sign-in then fails with a 502.

In order, the `run` command:
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

**4. Set your hourly price** in Provider setup once the machine's benchmark appears. Machines without a price aren't matched to jobs.

**5. Optional: save the keys** to skip the prompts on later runs. Add them to this machine's `.env`:

```bash
HOST_ADDRESS=10.26.75.38
OFFBALANCE_API_KEY=<Client API key>
OFFBALANCE_SESSION_KEY=<session key>
```

They work only until the host restarts. After that, the old API key gets `401 Unauthorized` and the old session key gets `isn't authorized for any wallet`. **Delete both lines after every host restart** ([§6](#6-restarting-and-updating)), and either let the client prompt you or save the new keys.

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

**Set the network's RPC URL to `http://HOST_ADDRESS:8545`**, for example `http://10.26.75.38:8545`. Don't use `http://127.0.0.1:8545`: that only works on the host itself. With the wrong RPC, MetaMask reads a different chain (or none). The chain ID (31337) matches either way, so nothing warns you; calls just come back empty, with errors like `Cannot decode zero data ("0x")`.

Which account to import:

| You want to… | Import |
|---|---|
| Submit jobs (buyer) | `BUYER_PRIVATE_KEY` |
| Run a provider, and see and collect its earnings | One of the `PROVIDER_N_PRIVATE_KEY`s, a different one on each machine. This is the wallet you authorize the session key with; earnings are paid to it, so **Collect funds** works from it. |

**Recommended on the dev chain:** in MetaMask, under Settings → Security & privacy, turn off **Security alerts** and **Estimate balance changes**. Those features run on MetaMask's servers, which can't simulate a local chain. With them on, MetaMask shows a vague "An error occurred" even though the transaction succeeds.

## 6. Restarting and updating

**Every host start is a fresh chain and a fresh database.** Previous jobs, accounts, API keys, session keys and balances are gone. The host also makes a new TLS certificate whenever its IP changes or the old certificate expires (after 30 days).

**After the host restarts, on every client machine:**

1. **Delete `OFFBALANCE_API_KEY` and `OFFBALANCE_SESSION_KEY` from `.env`**, if you saved them. Leave `HOST_ADDRESS`, and update it if the host's IP changed.
2. **Clear MetaMask's activity data:** Settings → Advanced → Clear activity tab data. MetaMask remembers old transaction counts; without this you get nonce errors or "Internal JSON-RPC error".
3. **Restart the client side completely**, with `down` first. This also restarts the UI, so it picks up the host's current certificate:
   ```bash
   docker compose --profile client down
   docker compose --profile client run --build --rm client
   ```
4. **Get new keys** from the UI and paste them ([§4](#4-start-a-client-provider-machine), steps 2–3). The new chain has forgotten the old ones.

**After pulling code changes, always rebuild with `--build`.** The contract is compiled when the image is built. Without `--build`, the host keeps serving the old contract, and the clients fail with errors like `KeyError: 'deadline'` or `function selector was not recognized`. Rebuild the host first, then the clients:

```bash
git pull

# on the host
docker compose --profile host down
docker compose --profile host up --build

# then on each client, after the host is up (and the steps above: clear old keys, clear MetaMask, new keys)
docker compose --profile client down
docker compose --profile client run --build --rm client
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
| Client: `CERTIFICATE_VERIFY_FAILED … IP address mismatch, certificate is not valid for '<ip>'` | The **host's** `.env` has an old `HOST_ADDRESS`, so its certificate names a different IP. Confirm with the certificate check in [§3](#3-start-the-host), step 4 | On the host: set `HOST_ADDRESS` to its current IP, then `down` and `up --build`. Then restart each client ([§6](#6-restarting-and-updating)) |
| Client: `401 Client Error: Unauthorized for url: …/contract_address` | The API key is from before the host restarted, usually an `OFFBALANCE_API_KEY` saved in `.env` | Delete it from `.env` and get a new key from Provider setup ([§4](#4-start-a-client-provider-machine)) |
| UI: **Connect wallet** / **Sign in** fails with 502. `docker compose --profile client logs remote-frontend` shows `self-signed certificate` | The UI started before the host's certificate changed, and still trusts the old one | `docker compose --profile client down`, then `run` again |
| Client: `KeyError: 'deadline'`; UI: `function selector was not recognized` | The host is running an older contract than the code | Pull on the host and run `up --build` there, then restart the clients |
| `fetch-cert` keeps printing `waiting for https://…:5000` | Host isn't up, `HOST_ADDRESS` is wrong, or a firewall is blocking port 5000 | Check host mode is running, check `.env`, and open the ports ([§3](#3-start-the-host)) |
| Client can't reach the chain (timeouts on `:8545`) | Port 8545 is closed on the host, or the host's IP changed | Open the port, and check the host's IP (below) |
| `Cannot decode zero data ("0x")` in the UI | MetaMask's RPC points at the wrong chain | Set its RPC URL to `http://HOST_ADDRESS:8545` ([§5](#5-metamask)) |
| "Internal JSON-RPC error" / nonce errors in MetaMask | The chain was restarted, but MetaMask kept old transaction counts | Settings → Advanced → Clear activity tab data |
| Collect funds is disabled with "Earnings are paid to 0x…, the wallet your provider client's session key acts for" | MetaMask is on a different account than the one that authorized the session key | Switch MetaMask to that account |
| Client: `Session key … isn't authorized for any wallet, or it has expired` | The key was never authorized, it expired, or the host restarted (a fresh chain forgets every key). Often an `OFFBALANCE_SESSION_KEY` saved in `.env` | Delete it from `.env`, authorize a new key in Provider setup ([§4](#4-start-a-client-provider-machine)) and paste it |
| Client: `The API key belongs to wallet X, but the session key acts for Y` | The two keys came from different sign-ins | Sign in with one wallet and copy both keys from it |
| Client: `No input; run the container with -it…` | The provider was started with `up`, which can't prompt | Start it with `docker compose --profile client run --build --rm client` |
| Client: `WARNING: session key has … ETH` / `Staking failed` | The session key can't cover a stake plus gas | Authorize a new key with more funding |
| MetaMask says "An error occurred" but the money arrives | MetaMask's transaction preview can't simulate a local chain | Turn off the two settings in [§5](#5-metamask). MetaMask's balance also updates with a delay. |
| Client: `result delivery not accepted yet …; retrying` | Normal at the start of delivery: the server hasn't opened the job yet | It retries for about 25 s. Any other message names the real reason. |
| Everything worked, then clients suddenly can't connect | The host's IP changed (DHCP) | See below |

### The host's IP address

The network hands out IPs on **4-hour DHCP leases**. A connected machine renews automatically and normally keeps its IP. It can change after the host has been offline or asleep for a while. To check on the host:

```bash
ip -br addr                                                 # current IP (Linux)
ip -4 addr show | grep valid_lft                            # seconds left on the lease
nmcli -f DHCP4 device show <interface> | grep -i lease_time # full lease length (NetworkManager)
```

If the IP changed:

1. Update `HOST_ADDRESS` in `.env` on **every** machine, the host first.
2. Restart the host: `docker compose --profile host down`, then `up --build`. It makes a new certificate for the new IP; check it ([§3](#3-start-the-host), step 4).
3. On each client: update MetaMask's RPC URL to the new IP, then follow [§6](#6-restarting-and-updating).

For a permanent address, ask whoever runs the network for a DHCP reservation for the host's MAC address.
