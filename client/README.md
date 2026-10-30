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
python3 -m pip install requests docker web3 pycryptodome
python3 -m unittest discover -s test -v
```

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

## Restart recovery

The provider keeps a private journal under `~/.offbalance/providers/<identity>/`.
The identity includes chain ID, genesis block hash, contract address and provider
signer address. A fresh local chain receives a separate journal automatically.
`OFFBALANCE_STATE_DIR` changes its root. A signer-wide lock permits one provider
process per chain/genesis across contracts under that stable state root;
transactions sent concurrently by a different program using that signer are unsupported.
The journal contains result hashes, per-job reveal salts and signed transactions;
keep the directory private and preserve it together with the unchanged commitment
seed. Startup rejects a different seed, another process holding the identity lock,
or a nonce consumed by a transaction absent from the journal.

On first use the client scans from block zero in bounded batches. Set
`OFFBALANCE_START_BLOCK` to the contract's deployment block to shorten that scan.
The saved cursor advances only after the entire ordered batch has persisted its
work. Changing the start block does not override an existing cursor. A canonical
block hash checkpoint detects reorganizations and rewinds to a retained matching
checkpoint (or the configured start block); job actions are checked against the
current contract phase, assignments and commitments before execution or reveal.

Results and reveal salts are fsynced before transaction construction; signed bytes
and their nonce are fsynced before broadcast. Restart reconciles receipts and
rebroadcasts identical pending bytes. Reverted receipts are recorded as failures;
a new attempt can use the next nonce while its phase remains open. A failed reveal
retains its opening. Confirmed commitments are reconciled with the chain instead
of rerunning the computation. Retain the journal after settlement; deleting it
while funds or jobs are outstanding destroys recovery information.

Docker jobs have a deterministic container name and ownership labels. The journal
records that identity and an absolute execution expiry before creation. After a
crash, the provider reconnects to its existing container; it does not start a second
one writing the same directory. Completed output is journaled before removal and
can be hashed after restart. Expired containers are stopped and removed, including
when the job has already advanced or settled. If a container is absent and no
completed output was recorded, a fresh attempt clears the old output first.
Outputs now live under the provider identity directory to separate chains and signers.

Recovery requires the journal disk and the same Docker daemon/output storage to
survive. A changed Docker daemon ID is rejected before execution recovery.
A reset local chain using the same addresses receives a separate genesis-bound
journal. A live RPC genesis change stops the old process before it can replay
signed transactions. Old journals remain intact for their original chains.
Recovery does not extend on-chain windows; an outage longer than the commit or
reveal window can still lose the stake. Pending transactions are rebroadcast at
their original fees; fee replacement, remote-daemon migration, artifact delivery
and automatic result upload remain outside this recovery implementation. Graceful
shutdown pauses container polling and hashing promptly, leaving owned detached
containers available for reconnection. Image downloads may continue in Docker but
cannot create a container or touch the journal after their controller stops.
Transaction RPC calls have bounded waits; workers finish before the signer lock is
released. An abrupt kill is recovered on the next start.

Run the recovery and existing client tests in a clean environment with `requests`,
`docker`, `web3` and `pycryptodome` installed:

```bash
python3 -m unittest discover -s client/test -v
```

The recovery tests use temporary journal directories and fake RPC/Docker boundaries;
they exercise restart before/after broadcast, lost responses, pending/reverted
receipts, reveal retries, nonce conflicts, reorganization, failed journal fsync,
and detached-container reconnection. They do not establish full artifact delivery
or production sandbox qualification.
