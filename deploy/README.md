# Shared server: Docker Compose + Tailscale

Runs the chain, the real server, the frontend and MongoDB on one machine (a home server, say) so providers and users on other machines can connect. Every service listens on `127.0.0.1` only, the same addresses `startup.py` uses. [Tailscale](https://tailscale.com) forwards them to the machines in your tailnet, over HTTPS with real certificates. Nothing is put on the public internet.

| Service | On the host | Through Tailscale | What it is |
|---|---|---|---|
| `chain` | `http://127.0.0.1:8545` | `https://<host>.<tailnet>.ts.net:8545` | Hardhat node with `OffBalance` deployed at `0x5FbD…0aa3` (dev.env), chain ID 31337 |
| `server` | `https://127.0.0.1:5000` | `https://<host>.<tailnet>.ts.net:5000` | The real HTTPS API, seeded with the dev accounts (`dev`, `dev2`–`dev4`, `dev-buyer`) |
| `frontend` | `http://127.0.0.1:5173` | `https://<host>.<tailnet>.ts.net` | The React app; `/api` is proxied to the server |
| `mongo` | not published | — | MongoDB, used only by the server |

## 1. Start it on the server machine

Needs Docker Engine with the Compose plugin (`docker compose version`; v2.20 or newer).

```bash
git clone <repo> offbalance && cd offbalance
docker compose up -d --build        # first build takes a few minutes
docker compose ps                   # chain, server, mongo: (healthy)
curl http://127.0.0.1:5173/api/config
# {"executionMode":"chain","chain":{"chainId":31337,"address":"0x5FbDB2315678afecb367f032d93F642f64180aa3"}}
```

Every service restarts by itself (`restart: unless-stopped`), including after a reboot.

| Task | Command |
|---|---|
| Follow logs | `docker compose logs -f server` (or `chain`, `frontend`) |
| Update after `git pull` | `docker compose up -d --build` |
| Start over with an empty chain | `docker compose restart chain` |
| Stop | `docker compose down` (`down -v` also deletes the databases and certificate) |

**Restarts reset the chain.** The Hardhat node keeps the chain in memory, so a restart (of the `chain` container, Docker, or the machine) starts an empty chain and redeploys the contract at the same address. The server notices the new chain and switches to a fresh database (`offbalance_<genesis hash>`), so jobs and accounts from before don't carry over. The dev accounts are seeded again. Old databases stay in the `mongo-data` volume until `docker compose down -v`.

**Port clashes.** If `startup.py` or another dev setup runs on the same machine, move the published ports in a `.env` file next to `docker-compose.yml`:

```bash
CHAIN_PORT=8546
SERVER_PORT=5001
FRONTEND_PORT=5174
```

## 2. Share it over Tailscale

On the server machine:

1. Install Tailscale and log in: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
2. In the [admin console](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**.
3. Forward the three ports (they persist across reboots):
   ```bash
   sudo tailscale serve --bg 5173                                         # frontend at https://<host>.<tailnet>.ts.net
   sudo tailscale serve --bg --https=5000 https+insecure://127.0.0.1:5000 # server (its own certificate is self-signed)
   sudo tailscale serve --bg --https=8545 http://127.0.0.1:8545           # chain RPC
   tailscale serve status                                                 # shows the URLs
   ```
   If you changed ports in `.env`, use those on the right-hand side. `sudo tailscale serve reset` removes all three.

Each teammate or provider installs Tailscale and logs in to the same tailnet. You can also [share the machine](https://tailscale.com/kb/1084/sharing) with people on another tailnet. Check from their machine with `curl https://<host>.<tailnet>.ts.net/api/config`.

> **Keep this off the public internet.** Don't use `tailscale funnel` (or any other public tunnel) for these ports. The dev private keys in `dev.env` are public, and the Hardhat node signs transactions for its dev accounts and accepts admin calls such as `hardhat_reset`, so anyone who can reach port 8545 can act as the server account or wipe the chain. Everyone in your tailnet is trusted with that.

## 3. Connect a provider from another machine

On the provider's machine, with the client set up as in the root [README](../README.md#prerequisites) (Python venv and Docker):

```bash
cd client
export OFFBALANCE_SERVER_URL=https://<host>.<tailnet>.ts.net:5000
export RPC_URL=https://<host>.<tailnet>.ts.net:8545
python3 main.py --dev --provider 2
```

- No certificate setup is needed: Tailscale's certificates are publicly trusted, so `REQUESTS_CA_BUNDLE` stays unset.
- The client gets the contract address and ABI from the server, so it needs no `blockchain/deployments/` file.
- `--dev --provider N` uses dev provider N (1–4) from `dev.env`. Give each machine its own N: two clients with the same wallet clash on transaction nonces.
- To use a wallet of your own instead, sign in on the website with it and copy the API key from the provider page. Then run `python3 main.py` without `--dev`, which prompts for the key and the wallet's private key. The wallet needs ETH on this chain for stakes and gas: send some from a dev account in MetaMask.
- If the client stops with `… is chain X, but the server uses chain 31337`, `RPC_URL` points at a different chain from the server's.

## 4. Use the website

Open `https://<host>.<tailnet>.ts.net`. In MetaMask, add the network as in [frontend/METAMASK_SETUP.md](../frontend/METAMASK_SETUP.md), but with RPC URL `https://<host>.<tailnet>.ts.net:8545` (chain ID 31337). After the chain restarts, clear MetaMask's activity data, as that guide explains.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ports are not available` on `docker compose up` | Something on the host already uses the port: move it in `.env` (above). |
| The page says `Blocked request. This host is not allowed` | You opened the frontend under a name other than `localhost` or `*.ts.net`: add it with `ALLOWED_HOSTS=.ts.net,myname.example` in `.env`. |
| `server` keeps restarting | `docker compose logs server`. It waits for the contract on the chain, then needs MongoDB. |
| Job images built from a Dockerfile fail | Builds are off in this setup (the server image has no Docker CLI); submit jobs with a pinned image digest. |
