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

Test the availability loop without Docker or a blockchain node:

```bash
python3 -m unittest discover -s test -v
```

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
