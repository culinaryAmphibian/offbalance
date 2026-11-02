import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark import gpu as gpus
from benchmark import system
from benchmark.BenchmarkManager import BenchmarkManager
from benchmark.HardwareProfile import CpuInfo, GpuInfo, HardwareProfile, MemoryInfo
from server.ServerManager import ServerManager

# two sockets, two cores each, hyper-threaded: 8 logical CPUs, 4 physical cores
X86_CPUINFO = '\n\n'.join(
    f'processor\t: {n}\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz\n'
    f'physical id\t: {n // 4}\ncore id\t\t: {(n // 2) % 2}\ncpu cores\t: 2'
    for n in range(8)) + '\n'
# ARM kernels don't print core ids; a Raspberry Pi names the board instead
ARM_CPUINFO = ('processor\t: 0\nBogoMIPS\t: 108.00\nCPU part\t: 0xd0b\n\n'
               'processor\t: 1\nBogoMIPS\t: 108.00\nCPU part\t: 0xd0b\n\n'
               'Hardware\t: BCM2835\nModel\t\t: Raspberry Pi 5 Model B Rev 1.0\n')
MEMINFO = 'MemTotal:       16303428 kB\nMemFree:         1234567 kB\n'

NVIDIA_CSV = '0, NVIDIA GeForce RTX 2070, 8192, 550.54.14\n1, NVIDIA A100-SXM4-80GB, 81920, 550.54.14\n'
NVIDIA_BANNER_OLD = '| NVIDIA-SMI 550.54.14   Driver Version: 550.54.14   CUDA Version: 12.4     |'
NVIDIA_BANNER_NEW = '| NVIDIA-SMI 616.92   KMD Version: 616.92   CUDA UMD Version: 13.4     |'
ROCM_JSON = json.dumps({
    'card0': {'Card Series': 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]', 'Card Model': '0x73bf',
              'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '12345'},
    'card1': {'Card series': 'Radeon Instinct MI210', 'VRAM Total Memory (B)': '68702699520'},
    'system': {'Driver version': '6.7.0'},
})


def rtx_2070(**changes):
    return GpuInfo(**{'vendor': 'nvidia', 'index': 0, 'model': 'NVIDIA GeForce RTX 2070', 'vram_gb': 8.0,
                      'driver': '550.54.14', 'runtime': 'CUDA 12.4', **changes})


class SystemSpecTests(unittest.TestCase):
    def test_cpuinfo_counts_physical_cores_across_sockets(self):
        self.assertEqual(system.parse_cpuinfo(X86_CPUINFO), ('Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz', 4))

    def test_cpuinfo_without_core_ids_leaves_cores_unknown(self):
        self.assertEqual(system.parse_cpuinfo(ARM_CPUINFO), ('Raspberry Pi 5 Model B Rev 1.0', None))

    def test_meminfo_is_reported_in_gib(self):
        self.assertAlmostEqual(system.parse_meminfo(MEMINFO), 15.548, places=3)
        self.assertIsNone(system.parse_meminfo('MemFree: 1 kB\n'))

    def test_linux_specs_come_from_proc_and_cores_never_exceed_usable_threads(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = Path(folder)
            (proc / 'cpuinfo').write_text(X86_CPUINFO)
            (proc / 'meminfo').write_text(MEMINFO)
            with patch('benchmark.system.logical_cpus', return_value=8):
                self.assertEqual(system.cpu_specs(proc), ('Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz', 4, 8))
            # pinned to two CPUs: the job can't use the other cores
            with patch('benchmark.system.logical_cpus', return_value=2):
                self.assertEqual(system.cpu_specs(proc)[1:], (2, 2))
            self.assertAlmostEqual(system.total_memory_gib(proc), 15.548, places=3)

    def test_unknown_core_count_falls_back_to_threads(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'cpuinfo').write_text(ARM_CPUINFO)
            with patch('benchmark.system.logical_cpus', return_value=4):
                self.assertEqual(system.cpu_specs(Path(folder))[1:], (4, 4))


class GpuDetectionTests(unittest.TestCase):
    def test_nvidia_smi_lists_each_gpu_with_vram_in_gib_and_both_banner_formats(self):
        old = gpus.parse_nvidia_smi(NVIDIA_CSV, NVIDIA_BANNER_OLD)
        self.assertEqual([(g.index, g.model, g.vram_gb, g.driver, g.runtime) for g in old], [
            (0, 'NVIDIA GeForce RTX 2070', 8.0, '550.54.14', 'CUDA 12.4'),
            (1, 'NVIDIA A100-SXM4-80GB', 80.0, '550.54.14', 'CUDA 12.4'),
        ])
        self.assertEqual(gpus.parse_nvidia_smi(NVIDIA_CSV, NVIDIA_BANNER_NEW)[0].runtime, 'CUDA 13.4')
        self.assertIsNone(gpus.parse_nvidia_smi(NVIDIA_CSV, None)[0].runtime)

    def test_nvidia_smi_skips_unparseable_lines(self):
        self.assertEqual(gpus.parse_nvidia_smi('No devices were found\n0, GPU, [N/A], 1\n', None), [])

    def test_rocm_smi_handles_key_spellings_from_different_releases(self):
        cards = gpus.parse_rocm_smi(ROCM_JSON, '6.3.1')
        self.assertEqual([(g.vendor, g.index, g.model, round(g.vram_gb, 1), g.driver, g.runtime) for g in cards], [
            ('amd', 0, 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]', 16.0, '6.7.0', 'ROCm 6.3.1'),
            ('amd', 1, 'Radeon Instinct MI210', 64.0, '6.7.0', 'ROCm 6.3.1'),
        ])
        self.assertEqual(gpus.parse_rocm_smi('not json', None), [])

    def test_missing_vendor_tools_mean_no_gpus(self):
        with patch('benchmark.gpu.subprocess.run', side_effect=FileNotFoundError):
            self.assertEqual(gpus.detect_gpus(), [])

    def test_container_options_hand_over_exactly_one_gpu(self):
        nvidia = gpus.container_gpu_options('nvidia', 1)['device_requests'][0]
        self.assertEqual((nvidia['DeviceIDs'], nvidia['Capabilities']), (['1'], [['gpu']]))
        amd = gpus.container_gpu_options('amd', 1)
        self.assertEqual(amd, {'devices': ['/dev/kfd', '/dev/dri'], 'group_add': ['video'],
                               'environment': {'HIP_VISIBLE_DEVICES': '1'}})


class GpuBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.docker = Mock()
        self.container = self.docker.containers.run.return_value
        self.container.wait.return_value = {'StatusCode': 0}
        self.container.logs.return_value = b'some warning\n{"model": "x", "fp32Tflops": 6.9, "memoryBandwidthGBps": 410.2}\n'

    def test_successful_benchmark_fills_in_measurements_and_removes_the_container(self):
        result = gpus.benchmark_gpu(self.docker, rtx_2070(), notify=Mock())
        self.assertTrue(result.usable)
        self.assertEqual((result.fp32_tflops, result.memory_bandwidth_gbps), (6.9, 410.2))
        args = self.docker.containers.run.call_args
        self.assertEqual(args.args[0], gpus.BENCHMARK_IMAGES['nvidia'])
        self.assertEqual(args.kwargs['command'][:2], ['python', '-c'])
        self.assertTrue(args.kwargs['network_disabled'])
        self.assertEqual(args.kwargs['device_requests'][0]['DeviceIDs'], ['0'])
        self.container.remove.assert_called_once_with(force=True)

    def test_missing_image_is_announced_before_the_one_time_pull_by_digest(self):
        from docker.errors import ImageNotFound
        self.docker.images.get.side_effect = ImageNotFound('missing')
        self.docker.api.pull.return_value = iter([{'status': 'Downloading'}, {'status': 'Digest: sha256:...'}])
        notify = Mock()
        self.assertTrue(gpus.benchmark_gpu(self.docker, rtx_2070(), notify=notify).usable)
        self.assertIn('several GB', notify.call_args.args[0])
        repository, digest = gpus.BENCHMARK_IMAGES['nvidia'].split('@')
        self.docker.api.pull.assert_called_once_with(repository, tag=digest, stream=True, decode=True)

    def test_pull_errors_report_their_real_cause_not_a_gpu_setup_problem(self):
        # Docker Desktop with a full disk: the daemon reports this inside the pull stream
        from docker.errors import ImageNotFound
        self.docker.images.get.side_effect = ImageNotFound('missing')
        self.docker.api.pull.return_value = iter([{'status': 'Downloading'}, {'error': 'write meta.db: input/output error'}])
        result = gpus.benchmark_gpu(self.docker, rtx_2070(), notify=Mock())
        self.assertEqual(result.error, "couldn't download the GPU benchmark image: write meta.db: input/output error")
        self.assertNotIn('Container Toolkit', result.error)
        self.docker.containers.run.assert_not_called()

    def test_failed_benchmark_keeps_the_gpu_but_marks_it_unusable(self):
        self.container.wait.return_value = {'StatusCode': 1}
        self.container.logs.return_value = b'Traceback...\nSystemExit: PyTorch sees no GPU in this container\n'
        result = gpus.benchmark_gpu(self.docker, rtx_2070(), notify=Mock())
        self.assertFalse(result.usable)
        self.assertIn('PyTorch sees no GPU', result.error)
        self.container.remove.assert_called_once_with(force=True)

    def test_docker_without_gpu_support_explains_the_fix(self):
        from docker.errors import APIError
        self.docker.containers.run.side_effect = APIError('could not select device driver "" with capabilities: [[gpu]]')
        result = gpus.benchmark_gpu(self.docker, rtx_2070(), notify=Mock())
        self.assertFalse(result.usable)
        self.assertIn('NVIDIA Container Toolkit', result.error)

    def test_garbage_output_is_an_error_not_a_crash(self):
        self.container.logs.return_value = b'not json'
        self.assertIn('unreadable', gpus.benchmark_gpu(self.docker, rtx_2070(), notify=Mock()).error)


class BenchmarkManagerTests(unittest.TestCase):
    def test_real_cpu_and_memory_benchmarks_report_positive_units(self):
        manager = BenchmarkManager(sample_seconds=0.05, repetitions=1, notify=Mock())
        with patch('benchmark.BenchmarkManager.gpus.detect_gpus', return_value=[]):
            profile = manager.do_benchmark()
        self.assertGreaterEqual(profile.cpu.threads, profile.cpu.cores)
        self.assertGreater(profile.cpu.cores, 0)
        self.assertGreater(profile.cpu.single_thread_mbps, 0)
        self.assertGreater(profile.cpu.multi_thread_mbps, 0)
        self.assertGreater(profile.memory.total_gb, 0)
        self.assertGreater(profile.memory.bandwidth_gbps, 0)
        self.assertEqual(profile.gpus, ())

    def test_every_detected_gpu_is_benchmarked(self):
        manager = BenchmarkManager(docker_client=Mock(), notify=Mock())
        with patch('benchmark.BenchmarkManager.gpus.detect_gpus', return_value=[rtx_2070(), rtx_2070(index=1)]), \
             patch('benchmark.BenchmarkManager.gpus.benchmark_gpu', side_effect=lambda _d, g, _n: g) as bench:
            self.assertEqual(len(manager._gpu_benchmark()), 2)
        self.assertEqual([call.args[1].index for call in bench.call_args_list], [0, 1])

    def test_skipped_gpu_benchmark_reports_the_gpu_as_unusable(self):
        manager = BenchmarkManager(gpu_benchmarks=False, notify=Mock())
        with patch('benchmark.BenchmarkManager.gpus.detect_gpus', return_value=[rtx_2070()]), \
             patch('benchmark.BenchmarkManager.gpus.benchmark_gpu') as bench:
            [gpu] = manager._gpu_benchmark()
        bench.assert_not_called()
        self.assertFalse(gpu.usable)
        self.assertIn('skipped', gpu.error)

    def test_unreachable_docker_marks_gpus_unusable_instead_of_failing(self):
        from docker.errors import DockerException
        manager = BenchmarkManager(notify=Mock())
        with patch('benchmark.BenchmarkManager.gpus.detect_gpus', return_value=[rtx_2070()]), \
             patch('docker.from_env', side_effect=DockerException('daemon not running')):
            [gpu] = manager._gpu_benchmark()
        self.assertFalse(gpu.usable)
        self.assertIn("Docker isn't reachable", gpu.error)

    def test_invalid_settings_are_rejected(self):
        with self.assertRaises(ValueError):
            BenchmarkManager(sample_seconds=0)
        with self.assertRaises(ValueError):
            BenchmarkManager(repetitions=0)


class ProfileUploadTests(unittest.TestCase):
    def test_profile_is_posted_as_json_in_the_server_contract_shape(self):
        profile = HardwareProfile(
            cpu=CpuInfo('Ryzen 7 7700X', 8, 16, 61.234, 610.0),
            memory=MemoryInfo(31.2, 18.456),
            gpus=(rtx_2070(fp32_tflops=6.912, memory_bandwidth_gbps=410.25),),
        )
        manager = ServerManager('https://server.test', 'key')
        with patch.object(manager, 'request') as request:
            manager.post_benchmark(profile)
        body = request.call_args.kwargs['json']
        self.assertEqual(request.call_args.args, ('POST', '/scores'))
        self.assertEqual(body['version'], 2)
        self.assertEqual(body['cpu'], {'model': 'Ryzen 7 7700X', 'cores': 8, 'threads': 16,
                                       'singleThreadMBps': 61.23, 'multiThreadMBps': 610.0})
        self.assertEqual(body['memory'], {'totalGb': 31.2, 'bandwidthGBps': 18.46})
        self.assertEqual(body['gpus'][0]['fp32Tflops'], 6.91)
        self.assertIsNone(body['gpus'][0]['error'])


@unittest.skipUnless(os.environ.get('OFFBALANCE_GPU_TEST') == '1', 'set OFFBALANCE_GPU_TEST=1 on a machine with a GPU')
class RealGpuTests(unittest.TestCase):
    def test_this_machines_gpus_benchmark_inside_docker(self):
        import docker
        detected = gpus.detect_gpus()
        self.assertTrue(detected, 'nvidia-smi / rocm-smi found no GPU')
        client = docker.from_env()
        for gpu in detected:
            result = gpus.benchmark_gpu(client, gpu)
            print(f'\n{result.model}: {result.fp32_tflops} TFLOPS, {result.memory_bandwidth_gbps} GB/s, error={result.error}')
            self.assertTrue(result.usable, result.error)
            self.assertGreater(result.fp32_tflops, 0.1)
            self.assertGreater(result.memory_bandwidth_gbps, 1)


if __name__ == '__main__':
    unittest.main()
