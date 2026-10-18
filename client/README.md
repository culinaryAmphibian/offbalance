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
