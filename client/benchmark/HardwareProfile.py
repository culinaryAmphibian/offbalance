# what the client reports to the server (POST /scores): detected specs plus benchmarks in real units
from dataclasses import dataclass

PROFILE_VERSION = 2


@dataclass(frozen=True, slots=True)
class CpuInfo:
    model: str
    cores: int    # physical cores
    threads: int  # logical CPUs this process may use; Docker's --cpus counts these
    single_thread_mbps: float  # zlib compression throughput of one thread, MB/s of input
    multi_thread_mbps: float   # the same with every thread at once


@dataclass(frozen=True, slots=True)
class MemoryInfo:
    total_gb: float        # GiB the OS can use, slightly less than what's installed
    bandwidth_gbps: float  # copy bandwidth, GB/s of bytes read + written


@dataclass(frozen=True, slots=True)
class GpuInfo:
    vendor: str  # 'nvidia' or 'amd'
    index: int   # the vendor tool's device index, used to hand this GPU to a container
    model: str
    vram_gb: float
    driver: str | None = None
    runtime: str | None = None  # e.g. 'CUDA 12.4', 'ROCm 6.3'
    fp32_tflops: float | None = None
    memory_bandwidth_gbps: float | None = None
    # why the benchmark container couldn't use this GPU; such a GPU isn't offered for jobs
    error: str | None = None

    @property
    def usable(self) -> bool:
        return self.error is None and self.fp32_tflops is not None


@dataclass(frozen=True, slots=True)
class HardwareProfile:
    cpu: CpuInfo
    memory: MemoryInfo
    gpus: tuple[GpuInfo, ...] = ()

    def to_json(self) -> dict:
        return {
            'version': PROFILE_VERSION,
            'cpu': {
                'model': self.cpu.model,
                'cores': self.cpu.cores,
                'threads': self.cpu.threads,
                'singleThreadMBps': round(self.cpu.single_thread_mbps, 2),
                'multiThreadMBps': round(self.cpu.multi_thread_mbps, 2),
            },
            'memory': {
                'totalGb': round(self.memory.total_gb, 2),
                'bandwidthGBps': round(self.memory.bandwidth_gbps, 2),
            },
            'gpus': [{
                'vendor': gpu.vendor,
                'index': gpu.index,
                'model': gpu.model,
                'vramGb': round(gpu.vram_gb, 2),
                'driver': gpu.driver,
                'runtime': gpu.runtime,
                'fp32Tflops': None if gpu.fp32_tflops is None else round(gpu.fp32_tflops, 2),
                'memoryBandwidthGBps': None if gpu.memory_bandwidth_gbps is None else round(gpu.memory_bandwidth_gbps, 1),
                'error': gpu.error,
            } for gpu in self.gpus],
        }

    def summary(self) -> str:
        lines = [
            f"CPU: {self.cpu.model}, {self.cpu.cores} cores / {self.cpu.threads} threads, "
            f"{self.cpu.single_thread_mbps:.0f} MB/s single-thread, {self.cpu.multi_thread_mbps:.0f} MB/s all threads",
            f"Memory: {self.memory.total_gb:.1f} GB, {self.memory.bandwidth_gbps:.1f} GB/s",
        ]
        for gpu in self.gpus:
            measured = (f"{gpu.fp32_tflops:.1f} FP32 TFLOPS, {gpu.memory_bandwidth_gbps:.0f} GB/s"
                        if gpu.usable else f"not usable: {gpu.error}")
            lines.append(f"GPU {gpu.index}: {gpu.model}, {gpu.vram_gb:.1f} GB, {measured}")
        if not self.gpus:
            lines.append("GPU: none detected")
        return '\n'.join(lines)
