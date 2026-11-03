# GPU detection (nvidia-smi, rocm-smi) and the benchmark container.
#
# The benchmark runs in Docker with the same GPU access a GPU job gets (RunManager.gpu_options),
# so a GPU that benchmarks is one jobs can use. A GPU whose benchmark fails is still reported,
# with the reason, but isn't offered for jobs.
from dataclasses import replace
import json
from pathlib import Path
import re
import subprocess

from benchmark.HardwareProfile import GpuInfo

MIB = 1024 ** 2
GIB = 1024 ** 3

# pinned by digest, like job images, so every provider measures with identical code
BENCHMARK_IMAGES = {
    # pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime; needs a driver that supports CUDA 12
    'nvidia': 'docker.io/pytorch/pytorch@sha256:c8268a92a69bd500f8be0e665b2630ee006dadaf7bfbc24249141b15ff622755',
    # rocm/pytorch:rocm6.3_ubuntu22.04_py3.10_pytorch_release_2.4.0
    'amd': 'docker.io/rocm/pytorch@sha256:402c9b4f1a6b5a81c634a1932b56cbe01abb699cfcc7463d226276997c6cf8ea',
}
BENCHMARK_SCRIPT = (Path(__file__).parent / 'gpu_benchmark.py').read_text()
BENCHMARK_TIMEOUT_S = 300

SETUP_HINTS = {
    'nvidia': 'install the NVIDIA Container Toolkit and restart Docker '
              '(https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)',
    'amd': 'install ROCm and add your user to the video and render groups '
           '(https://rocm.docs.amd.com/projects/install-on-linux/en/latest/)',
}


def _run(command: list[str]) -> str | None:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def parse_nvidia_smi(csv: str, banner: str | None) -> list[GpuInfo]:
    """`nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits`
    plus plain `nvidia-smi`, whose banner names the highest CUDA version the driver supports."""
    # older drivers print "CUDA Version: 12.4", newer ones "CUDA UMD Version: 13.4"
    cuda = re.search(r'CUDA (?:UMD )?Version:\s*([\d.]+)', banner or '')
    gpus = []
    for line in csv.splitlines():
        parts = [part.strip() for part in line.split(',')]
        if len(parts) != 4 or not parts[0].isdigit():
            continue
        index, name, memory_mib, driver = parts
        try:
            vram = float(memory_mib) * MIB / GIB
        except ValueError:
            continue
        gpus.append(GpuInfo(vendor='nvidia', index=int(index), model=name, vram_gb=vram,
                            driver=driver or None, runtime=f'CUDA {cuda.group(1)}' if cuda else None))
    return gpus


def parse_rocm_smi(text: str, rocm_version: str | None) -> list[GpuInfo]:
    """`rocm-smi --showproductname --showmeminfo vram --showdriverversion --json`.
    Key spellings vary between ROCm releases, so each field has a few candidates."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    driver = (data.get('system') or {}).get('Driver version')
    gpus = []
    for key, card in data.items():
        match = re.fullmatch(r'card(\d+)', key)
        if not match or not isinstance(card, dict):
            continue
        model = next((card[k] for k in ('Card Series', 'Card series', 'Card SKU', 'Card Model', 'Card model')
                      if card.get(k)), 'AMD GPU')
        try:
            vram = int(card.get('VRAM Total Memory (B)', 0)) / GIB
        except (TypeError, ValueError):
            vram = 0
        gpus.append(GpuInfo(vendor='amd', index=int(match.group(1)), model=model, vram_gb=vram,
                            driver=driver, runtime=f'ROCm {rocm_version}' if rocm_version else None))
    return gpus


def detect_gpus() -> list[GpuInfo]:
    gpus = []
    csv = _run(['nvidia-smi', '--query-gpu=index,name,memory.total,driver_version',
                '--format=csv,noheader,nounits'])
    if csv:
        gpus += parse_nvidia_smi(csv, _run(['nvidia-smi']))
    rocm = _run(['rocm-smi', '--showproductname', '--showmeminfo', 'vram', '--showdriverversion', '--json'])
    if rocm:
        version_file = Path('/opt/rocm/.info/version')
        version = version_file.read_text().strip().split('-')[0] if version_file.exists() else None
        gpus += parse_rocm_smi(rocm, version)
    return gpus


def container_gpu_options(vendor: str, index: int) -> dict:
    """docker-py `containers.run` arguments that give a container exactly one GPU."""
    import docker  # imported here so detection works without the docker package
    if vendor == 'nvidia':
        return {'device_requests': [docker.types.DeviceRequest(device_ids=[str(index)], capabilities=[['gpu']])]}
    if vendor == 'amd':
        # ROCm needs the compute (kfd) and render (dri) nodes; HIP_VISIBLE_DEVICES narrows it to one card
        return {'devices': ['/dev/kfd', '/dev/dri'], 'group_add': ['video'],
                'environment': {'HIP_VISIBLE_DEVICES': str(index)}}
    raise ValueError(f'unsupported GPU vendor: {vendor}')


class PullError(Exception):
    pass


def _pull(docker_client, image: str) -> None:
    # The low-level stream, because images.pull() drops errors the daemon reports mid-pull
    # (a full disk, say) and then fails later with a misleading "No such image".
    repository, digest = image.split('@', 1)
    for event in docker_client.api.pull(repository, tag=digest, stream=True, decode=True):
        if 'error' in event:
            raise PullError(event['error'])


def benchmark_gpu(docker_client, gpu: GpuInfo, notify=print) -> GpuInfo:
    """The GPU with fp32_tflops and memory_bandwidth_gbps filled in, or error set."""
    from docker.errors import APIError, DockerException, ImageNotFound
    image = BENCHMARK_IMAGES[gpu.vendor]
    container = None
    try:
        try:
            docker_client.images.get(image)
        except ImageNotFound:
            notify(f'Downloading the {gpu.vendor.upper()} GPU benchmark image (several GB, first run only)...')
            try:
                _pull(docker_client, image)
            except (PullError, DockerException) as error:
                return replace(gpu, error=f"couldn't download the GPU benchmark image: {error}")
        options = container_gpu_options(gpu.vendor, gpu.index)
        try:
            container = docker_client.containers.run(image, command=['python', '-c', BENCHMARK_SCRIPT],
                                                     network_disabled=True, detach=True, **options)
        except APIError as error:
            # the daemon refusing the GPU (no runtime, no device nodes) is a host setup problem
            return replace(gpu, error=f"Docker can't use this GPU ({error}); {SETUP_HINTS[gpu.vendor]}")
        status = container.wait(timeout=BENCHMARK_TIMEOUT_S)
        logs = container.logs().decode('utf-8', errors='replace').strip()
        if status.get('StatusCode') != 0:
            detail = logs.splitlines()[-1] if logs else f'exit code {status.get("StatusCode")}'
            return replace(gpu, error=f'benchmark failed: {detail}')
        result = json.loads(logs.splitlines()[-1])
        return replace(gpu, fp32_tflops=float(result['fp32Tflops']),
                       memory_bandwidth_gbps=float(result['memoryBandwidthGBps']))
    except DockerException as error:
        return replace(gpu, error=f'Docker error during the GPU benchmark: {error}')
    except (ValueError, KeyError, IndexError) as error:
        return replace(gpu, error=f'unreadable benchmark output: {error}')
    except Exception as error:  # e.g. the wait timing out; the profile still goes out without this GPU
        return replace(gpu, error=f'benchmark did not finish: {error}')
    finally:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
