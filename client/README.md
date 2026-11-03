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

## Hardware profile

On startup `BenchmarkManager` (in [`benchmark/`](benchmark/)) reports the machine to `POST /scores` as specs plus benchmarks in real units. It takes about 6 seconds, plus the GPU benchmark if there is a GPU. It measures what this process can use, so inside a VM or a CPU-pinned container it reports that allocation, not the host's.

| | Detected | Measured |
|---|---|---|
| CPU | model, physical cores, vCPUs (logical CPUs this process may use) | zlib compression throughput, MB/s of input, on one thread and on every thread at once (the same kind of workload as the 7-Zip benchmark) |
| Memory | GB the OS can use (`/proc/meminfo`; a 16 GB machine reports about 15.5) | copy bandwidth in GB/s, read + write, from up to 8 processes over a 1 GiB working set, which is larger than CPU caches |
| GPU | NVIDIA via `nvidia-smi`, AMD via `rocm-smi`: model, VRAM, driver, CUDA/ROCm version | FP32 matmul TFLOPS and device memory bandwidth, measured in a container (below) |

The server shows each measurement as a multiple of a reference machine (1.0× = Intel Core i7-9700K limited to 4 cores, 16 GB dual-channel DDR4, NVIDIA RTX 2070), and suggests an hourly price from the specs. Matching uses the specs: a job asks for vCPUs, GB of memory, and optionally a GPU with a minimum of VRAM, and its container gets exactly that (Docker `--cpus`, `--memory` with no extra swap, and one GPU).

### GPU benchmark

Each detected GPU is benchmarked by [`benchmark/gpu_benchmark.py`](benchmark/gpu_benchmark.py) inside a PyTorch container, given the GPU the same way a GPU job is. A GPU that benchmarks is one jobs can use. The images are pinned by digest in [`benchmark/gpu.py`](benchmark/gpu.py) and pulled once, on the first run (several GB):

- NVIDIA: `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`, run with `--gpus device=N`. Needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and a driver that supports CUDA 12.
- AMD: `rocm/pytorch:rocm6.3_ubuntu22.04_py3.10_pytorch_release_2.4.0`, run with `/dev/kfd`, `/dev/dri`, the `video` group and `HIP_VISIBLE_DEVICES=N`. Needs ROCm on the host. The AMD path has only been tested with mocked tools and Docker, not on AMD hardware.

If Docker can't use a GPU, the profile still lists it, with the reason (for example a missing toolkit), and it isn't offered for jobs. `OFFBALANCE_SKIP_GPU_BENCHMARK=1` skips the GPU benchmark; detected GPUs are then reported as not usable.

These are self-reported measurements: they help match jobs and price machines, but don't prove what hardware a provider has. Restart the client after changing the machine's or VM's hardware.

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
in the frontend's provider setup and a session key authorized for the same wallet
(see [Credentials](../README.md#credentials)).
Set a positive hourly price in the frontend after the machine's benchmark appears.
Benchmarks and pricing alone do not establish availability; matching also requires
a live heartbeat and hardware that meets the job's requirements.

Temporary network/server errors retry at the next heartbeat. Invalid/revoked
credentials (401/403) and TLS trust failures stop the client. When the client
stops or loses connectivity, availability expires automatically.

Test availability and execution handling without a running Docker daemon or blockchain node:

```bash
python3 -m pip install requests docker
python3 -m unittest discover -s test -v
```

The GPU benchmark test is skipped unless you ask for it. On a machine with a GPU and Docker GPU support, it runs the real benchmark container for each detected GPU (the first run pulls the image):

```bash
OFFBALANCE_GPU_TEST=1 python3 -m unittest discover -s test -p test_benchmark.py -k RealGpu -v
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
