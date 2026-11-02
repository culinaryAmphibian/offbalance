from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import math
import multiprocessing
import os
import random
import statistics
import threading
import time
import zlib

from benchmark import gpu as gpus
from benchmark import system
from benchmark.HardwareProfile import CpuInfo, HardwareProfile, MemoryInfo

# CPU: zlib level-6 compression of 1 MiB of text-like data, the same kind of workload as
# the 7-Zip benchmark. zlib releases the GIL, so threads run in parallel.
CPU_CHUNK_BYTES = 1024 * 1024
# memory: each process copies between two buffers this size, 1 GiB in all with 8 processes,
# which is larger than any desktop CPU cache, so it measures RAM and not cache
MEMORY_BUFFER_BYTES = 64 * 1024 * 1024
MAX_MEMORY_PROCESSES = 8  # one desktop memory controller is saturated well before this


def _text_like_chunk(size: int) -> bytes:
    # deterministic, so every provider compresses identical bytes (about 2.7:1)
    rng = random.Random(0)
    letters = b'abcdefghijklmnopqrstuvwxyz'
    words = [bytes(rng.choice(letters) for _ in range(rng.randint(2, 9))) for _ in range(2000)]
    data = bytearray()
    while len(data) < size:
        data += rng.choice(words) + b' '
    return bytes(data[:size])


def _copy_worker(buffer_bytes: int, duration: float, ready, start, results) -> None:
    # module level so `spawn` (macOS, Windows) can import it in the child
    source = bytes(range(256)) * (buffer_bytes // 256)
    target = bytearray(buffer_bytes)
    target[:] = source  # fault every page in before timing
    ready.put(True)
    start.wait()
    started = time.perf_counter()
    copies = 0
    while time.perf_counter() - started < duration:
        target[:] = source
        copies += 1
    results.put(copies * 2 * buffer_bytes / (time.perf_counter() - started))


class BenchmarkManager:
    def __init__(self, sample_seconds: float = 0.5, repetitions: int = 3, docker_client=None,
                 gpu_benchmarks: bool = True, notify=print):
        if not math.isfinite(sample_seconds) or sample_seconds <= 0:
            raise ValueError("sample_seconds must be a finite positive number")
        if repetitions < 1:
            raise ValueError("repetitions must be at least 1")

        self.sample_seconds = sample_seconds
        self.repetitions = repetitions
        self.docker_client = docker_client
        self.gpu_benchmarks = gpu_benchmarks
        self.notify = notify
        self.cpu_chunk = _text_like_chunk(CPU_CHUNK_BYTES)
        self.profile: HardwareProfile | None = None

    # driver method
    def do_benchmark(self) -> HardwareProfile:
        model, cores, threads = system.cpu_specs()
        total_gb = system.total_memory_gib()
        self.notify(f"Benchmarking {model} ({cores} cores / {threads} threads, {total_gb:.1f} GB)...")

        cpu = CpuInfo(model=model, cores=cores, threads=threads,
                      single_thread_mbps=self._cpu_benchmark(1),
                      multi_thread_mbps=self._cpu_benchmark(threads))
        memory = MemoryInfo(total_gb=total_gb, bandwidth_gbps=self._mem_benchmark(cores, total_gb))
        self.profile = HardwareProfile(cpu=cpu, memory=memory, gpus=tuple(self._gpu_benchmark()))
        self.notify(self.profile.summary())
        return self.profile

    def _cpu_benchmark(self, threads: int) -> float:
        self._measure_cpu_sample(threads, min(self.sample_seconds, 0.2))  # warm-up
        return statistics.median(
            self._measure_cpu_sample(threads, self.sample_seconds) for _ in range(self.repetitions))

    def _measure_cpu_sample(self, threads: int, duration: float) -> float:
        """MB/s of input compressed by `threads` threads at once."""
        start_barrier = threading.Barrier(threads + 1)
        chunk = self.cpu_chunk

        def compress_for_duration() -> int:
            start_barrier.wait()
            deadline = time.perf_counter() + duration
            count = 0
            while time.perf_counter() < deadline:
                zlib.compress(chunk, 6)
                count += 1
            return count

        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = [executor.submit(compress_for_duration) for _ in range(threads)]
            start_barrier.wait()
            started_at = time.perf_counter()
            chunks = sum(future.result() for future in futures)
        elapsed = time.perf_counter() - started_at
        return chunks * len(chunk) / elapsed / 1e6

    def _mem_benchmark(self, cores: int, total_gb: float) -> float:
        """GB/s copied by several processes at once (bytes read + written)."""
        # keep the working set under a quarter of RAM on small machines
        affordable = int(total_gb * system.GIB / 4 // (2 * MEMORY_BUFFER_BYTES))
        processes = max(1, min(cores, MAX_MEMORY_PROCESSES, affordable))
        duration = self.sample_seconds * self.repetitions
        context = multiprocessing.get_context()
        ready, start, results = context.Queue(), context.Event(), context.Queue()
        workers = [context.Process(target=_copy_worker, daemon=True,
                                   args=(MEMORY_BUFFER_BYTES, duration, ready, start, results))
                   for _ in range(processes)]
        for worker in workers:
            worker.start()
        try:
            # every worker has its buffers before any starts timing, so the copies overlap
            for _ in workers:
                ready.get(timeout=60)
            start.set()
            total = sum(results.get(timeout=60 + duration) for _ in workers)
        finally:
            for worker in workers:
                worker.join(timeout=5)
                if worker.is_alive():
                    worker.terminate()
        return total / 1e9

    def _gpu_benchmark(self):
        detected = gpus.detect_gpus()
        if not detected:
            return []
        if not self.gpu_benchmarks:
            return [replace(gpu, error='GPU benchmark skipped (OFFBALANCE_SKIP_GPU_BENCHMARK)') for gpu in detected]
        if self.docker_client is None:
            import docker
            try:
                self.docker_client = docker.from_env()
            except docker.errors.DockerException as error:
                # the client still starts; its GPUs just aren't offered until Docker works
                return [replace(gpu, error=f"Docker isn't reachable ({error})") for gpu in detected]
        return [gpus.benchmark_gpu(self.docker_client, gpu, self.notify) for gpu in detected]


def gpu_benchmarks_enabled() -> bool:
    return os.environ.get('OFFBALANCE_SKIP_GPU_BENCHMARK', '') not in ('1', 'true', 'yes')
