from concurrent.futures import ThreadPoolExecutor
import hashlib
import math
import os
import statistics
import threading
import time
from benchmark.Scores import Scores

CPU_PAYLOAD = bytes(8 * 1024)
MEMORY_BUFFER_BYTES = 16 * 1024 * 1024
MAX_CPU_WORKERS = 32



class BenchmarkManager:
    def __init__(self, sample_seconds: float = 0.5, repetitions: int = 3):
        if not math.isfinite(sample_seconds) or sample_seconds <= 0:
            raise ValueError("sample_seconds must be a finite positive number")
        if repetitions < 1:
            raise ValueError("repetitions must be at least 1")

        self.sample_seconds = sample_seconds
        self.repetitions = repetitions
        self.logical_cpu_count = os.cpu_count()
        self.cpu_workers = min(self.logical_cpu_count or 1, MAX_CPU_WORKERS)
        self.scores: Scores | None = None

    # driver method
    def do_benchmark(self) -> Scores:
        cpu = self._cpu_benchmark()
        gpu = self._gpu_benchmark()
        memory = self._mem_benchmark()

        self.scores = Scores(
            cpu=cpu,
            gpu=gpu,
            memory=memory,
        )
        return self.scores

    # performs cpu benchmark
    def _cpu_benchmark(self) -> float:
        self._measure_cpu_sample(min(self.sample_seconds, 0.2))
        samples = [
            self._measure_cpu_sample(self.sample_seconds)
            for _ in range(self.repetitions)
        ]
        return statistics.median(samples)

    def _measure_cpu_sample(self, duration: float) -> float:
        start_barrier = threading.Barrier(self.cpu_workers + 1)
        deadline = time.perf_counter() + duration

        def hash_until_deadline() -> int:
            start_barrier.wait()
            count = 0
            while time.perf_counter() < deadline:
                hasher = hashlib.sha256()
                hasher.update(CPU_PAYLOAD)
                hasher.digest()
                count += 1
            return count

        with ThreadPoolExecutor(max_workers=self.cpu_workers) as executor:
            futures = [
                executor.submit(hash_until_deadline)
                for _ in range(self.cpu_workers)
            ]
            start_barrier.wait()
            started_at = time.perf_counter()
            hashes = sum(future.result() for future in futures)

        elapsed = time.perf_counter() - started_at
        return hashes / elapsed

    def _gpu_benchmark(self) -> None:
        return None

    def _mem_benchmark(self) -> float:
        source = bytes(range(256)) * (MEMORY_BUFFER_BYTES // 256)
        buffer = bytearray(MEMORY_BUFFER_BYTES)

        self._measure_memory_sample(source, buffer, min(self.sample_seconds, 0.2))
        samples = [
            self._measure_memory_sample(source, buffer, self.sample_seconds)
            for _ in range(self.repetitions)
        ]
        return statistics.median(samples)

    @staticmethod
    def _measure_memory_sample(
        source: bytes,
        buffer: bytearray,
        duration: float,
    ) -> float:
        started_at = time.perf_counter()
        deadline = started_at + duration
        iterations = 0

        while time.perf_counter() < deadline:
            buffer[:] = source
            copied = bytes(buffer)
            if copied[0] != source[0] or copied[-1] != source[-1]:
                raise RuntimeError("memory benchmark copy verification failed")
            iterations += 1

        elapsed = time.perf_counter() - started_at
        bytes_copied = iterations * MEMORY_BUFFER_BYTES * 2
        return bytes_copied / elapsed / (1024 * 1024)
