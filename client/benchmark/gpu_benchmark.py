# Runs inside the GPU benchmark container (see gpu.py), not in the client.
# PyTorch's torch.cuda API drives both CUDA and ROCm builds, so one script serves both vendors.
# Prints one JSON line: FP32 matmul TFLOPS and device memory copy bandwidth.
import json
import time

import torch

if not torch.cuda.is_available():
    raise SystemExit('PyTorch sees no GPU in this container')

# measure true FP32, not TF32 tensor-core math
torch.backends.cuda.matmul.allow_tf32 = False
torch.backends.cudnn.allow_tf32 = False

device = torch.device('cuda:0')
props = torch.cuda.get_device_properties(device)


def seconds_per_call(fn, iterations):
    fn()  # warm-up: kernel selection and allocation
    torch.cuda.synchronize()
    started = time.perf_counter()
    for _ in range(iterations):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - started) / iterations


# three n×n FP32 matrices: 768 MiB at 8192, small enough for any card with 4 GiB
n = 8192 if props.total_memory >= 4 * 1024 ** 3 else 4096
a = torch.randn(n, n, device=device)
b = torch.randn(n, n, device=device)
matmul = seconds_per_call(lambda: torch.mm(a, b), 10)

elements = 256 * 1024 ** 2 // 4  # 256 MiB of float32
src = torch.empty(elements, device=device)
dst = torch.empty_like(src)
copy = seconds_per_call(lambda: dst.copy_(src), 20)

print(json.dumps({
    'model': props.name,
    'fp32Tflops': 2 * n ** 3 / matmul / 1e12,
    'memoryBandwidthGBps': 2 * elements * 4 / copy / 1e9,  # read + write
}))
