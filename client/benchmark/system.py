# CPU and memory specs from the OS. Linux reads /proc; macOS and Windows fall back
# to what they expose, so the client still starts there during development.
import ctypes
import os
from pathlib import Path
import platform
import subprocess

GIB = 1024 ** 3


def logical_cpus() -> int:
    # affinity, not os.cpu_count(): a pinned or containerised client can't use every CPU
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 1


def parse_cpuinfo(text: str) -> tuple[str | None, int | None]:
    """Model name and physical core count from /proc/cpuinfo."""
    model = None
    cores = set()
    for block in text.split('\n\n'):
        fields = {}
        for line in block.splitlines():
            key, sep, value = line.partition(':')
            if sep:
                fields[key.strip()] = value.strip()
        # x86 has "model name"; some ARM kernels only print a board-level "Model"
        model = model or fields.get('model name') or fields.get('Model')
        if 'core id' in fields:
            cores.add((fields.get('physical id', '0'), fields['core id']))
    return model, len(cores) or None


def parse_meminfo(text: str) -> float | None:
    """MemTotal from /proc/meminfo, in GiB."""
    for line in text.splitlines():
        if line.startswith('MemTotal:'):
            return int(line.split()[1]) * 1024 / GIB
    return None


def _sysctl(name: str) -> str | None:
    try:
        return subprocess.run(['sysctl', '-n', name], capture_output=True, text=True,
                              timeout=5, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _windows_memory_gib() -> float | None:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                    ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                    ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                    ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
    status = MemoryStatus()
    status.dwLength = ctypes.sizeof(MemoryStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return status.ullTotalPhys / GIB


def _windows_cpu_model() -> str | None:
    # platform.processor() only gives "Intel64 Family 6 Model 158 ..." on Windows
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:
            return str(winreg.QueryValueEx(key, 'ProcessorNameString')[0]).strip()
    except OSError:
        return None


def cpu_specs(proc: Path = Path('/proc')) -> tuple[str, int, int]:
    """(model, physical cores, logical threads). Cores fall back to threads when unknown."""
    threads = logical_cpus()
    model = cores = None
    if (proc / 'cpuinfo').exists():
        model, cores = parse_cpuinfo((proc / 'cpuinfo').read_text())
    elif platform.system() == 'Darwin':
        model = _sysctl('machdep.cpu.brand_string')
        physical = _sysctl('hw.physicalcpu')
        cores = int(physical) if physical and physical.isdigit() else None
    elif platform.system() == 'Windows':
        model = _windows_cpu_model()  # no cheap physical core count here; cores fall back to threads
    model = model or platform.processor() or platform.machine() or 'unknown CPU'
    # cores can't exceed what this process may run on
    return model, min(cores or threads, threads), threads


def total_memory_gib(proc: Path = Path('/proc')) -> float:
    total = None
    if (proc / 'meminfo').exists():
        total = parse_meminfo((proc / 'meminfo').read_text())
    elif platform.system() == 'Darwin':
        size = _sysctl('hw.memsize')
        total = int(size) / GIB if size and size.isdigit() else None
    elif platform.system() == 'Windows':
        total = _windows_memory_gib()
    if total is None:
        raise RuntimeError("Can't read this machine's total memory.")
    return total
