# Provider client

---

Has the following responsibilities:

1. Listen for blockchain events
2. Call server's api to obtain docker image
3. Run docker image
4. Hash docker response
5. Post response to blockchain
6. Post nonce to blockchain
7. Run benchmark
8. Provide benchmark
9. Save provider's private key

---

## Hardware benchmark scores

`BenchmarkManager` measures resources from inside the provider VM, so results reflect the VM allocation rather than the host's advertised hardware. It returns only three raw throughput scores: CPU SHA-256 operations per second, GPU score, and memory-copy throughput in MiB per second. CPU and memory scores use the median of repeated samples.

GPU is reported as unavailable (`null`) until a GPU benchmark backend is implemented; it must not be interpreted as a measured zero. Compare scores only when the benchmark implementation and settings match. Re-run the benchmark after changing the VM's CPU or memory allocation. These client-reported measurements help with provider matching but do not prove hardware identity or guarantee job performance.

## Provider availability

After uploading benchmarks, the client immediately sends an authenticated
`POST /provider/heartbeat`, then repeats every 10 seconds on a dedicated worker.
Slow chain requests and container execution do not stop the heartbeats.
The server stops considering the provider online after 30 seconds
without a heartbeat. Existing assignments are retained when a provider goes offline.

With the real HTTPS server, from `client/`:

```bash
OFFBALANCE_SERVER_URL=https://localhost:5000 \
REQUESTS_CA_BUNDLE=../server/.local/tls/cert.pem \
python3 main.py --dev --provider 1
```

The local launcher sets the URL and certificate trust automatically. `--dev`
uses the seeded token `dev` for provider 1, and `dev2`–`dev4` for providers 2–4;
`OFFBALANCE_API_KEY` overrides it. For ordinary sign-in, use the API key shown
in the frontend's provider setup and its corresponding wallet private key.
Set a positive hourly price in the frontend after the machine's benchmark appears.
Benchmarks and pricing alone do not establish availability; matching also requires
a live heartbeat and hardware that meets the job's requirements.

Temporary network/server errors retry at the next heartbeat. Invalid/revoked
credentials (401/403) and TLS trust failures stop the client. When the client
stops or loses connectivity, availability expires automatically.

Test availability and execution handling without a running Docker daemon or blockchain node:

```bash
source .venv/bin/activate
python -m pip install requests docker pytest
python -m pytest              # or: python -m unittest discover -s test -v
```

Run pytest as `python -m pytest` from the venv. A bare `pytest` may resolve to the
system install (`/usr/bin/pytest`), which can't import `docker` and fails while
collecting `test_execution.py`.

## Adding providers alongside `startup.py`

`startup.py --shell` starts one client as provider 1. To add more, start each
extra client yourself, with a different `--provider` number:

```bash
OFFBALANCE_SERVER_URL=https://localhost:5000 \
REQUESTS_CA_BUNDLE=/path/to/offbalance/server/.local/tls/cert.pem \
/path/to/offbalance/client/.venv/bin/python \
  /path/to/offbalance/client/main.py --dev --provider 2
```

This works from any directory. Things that break it:

- **Missing environment variables.** `startup.py` passes `OFFBALANCE_SERVER_URL` and
  `REQUESTS_CA_BUNDLE` only to the client it launches. Without them, `main.py`
  falls back to `http://localhost:5000`, which the HTTPS server rejects. The
  certificate is self-signed, so `REQUESTS_CA_BUNDLE` must point at it. Give it
  as an absolute path, or as a path relative to the directory you run from.
- **No `--provider`.** `--dev` alone means provider 1, the same wallet and API
  key (`dev`) as the launcher's client. Use `--provider 2`, `3` or `4`, which the
  seed set up with API keys `dev2`–`dev4`.
- **System Python.** A plain `python3` doesn't have `web3` or `docker`. Use
  `client/.venv/bin/python`.

`main.py` finds `dev.env` and `blockchain/deployments/localhost.json` relative
to its own location, so the directory you run it from doesn't matter otherwise.

Every client on a machine writes job output to the same folder,
`~/.offbalance/jobs/<jobId>/output`. If two local providers are assigned the
same job, they overwrite each other's output.

## Docker output and failures

The runner reads the daemon's security options before launching a job. Rootless
Docker uses container UID/GID `0:0`, which maps to the ordinary daemon user's
host identity; ordinary Docker uses the provider process's host UID/GID. The
provider process and rootless daemon should run as the same local user, and the
output directory must be available on the daemon's host. Set `DOCKER_HOST` when
using a nondefault socket. Existing directory permissions are preserved.

A failed container reports its exit code and recent logs to the authenticated
`POST /provider/jobs/:jobId/error` endpoint. Timeouts, OOM kills, preparation,
Docker and commitment errors are also reported. Containers are removed after
execution, including on failure or timeout. If the error report cannot reach the
server, the client prints that failure locally. Reporting an error does not
release an unfinished blockchain assignment. Unassigned commit-phase broadcasts
are ignored.

---

## Example flow

1. Provider installs the client
2. Provider puts in the private key and _verifies_ it (_tbd on what this means, the private key must be valid, and authorized to call the blockchain methods_)
3. Provider runs the benchmark
   a. Once finished, the benchmark calls ServerManager's POST benchmark route, which posts the benchmark and identifies

**---At this point, we are ready to receive and do job---**

4. Blockchain manager then sits in a forever while loop that listens for blockchain events
5. If the event is PROVIDER_ASSIGNED, and it's me, then BCM (blockchain manager) asks the SM (Server Manager) to fetch the job
6. Then, job manager starts the job, and is responsible for hashing the output and handing it off to the BCM
7. BCM then posts the hashed (encrypted) output to the blockchain.
8. Then, when the REVEAL phase starts, BCM posts the decoding, which the blockchain uses to verify
9. Blockchain manager then listens for CONSENSUS events to hear whether its a part of the consensus, and then if it is sets a flag such that when:
10. a DELIVERY event gets posted, we send the computation output to the server

TODO:

- [ ] write tests for server to make sure the contract between client and server is enforced.
