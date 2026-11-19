# Integration: RunManager against a real Docker daemon, with small alpine jobs. Covers what the
# unit tests can only mock: a job's output and hash, and the isolation a provider relies on when
# running a stranger's container (no network, memory/CPU limits, deadline, file ownership, no
# Docker socket, nothing outside /output reaches the host).
#
# Each job probes its own sandbox and writes what it found to /output, which the test reads.
# Skipped when no Docker daemon is reachable. The first run pulls alpine.
#   cd client && python -m unittest discover -s test -p test_docker_integration.py -v
from pathlib import Path
import contextlib
import io
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

IMAGE = 'alpine:3.20'


def docker_client():
    try:
        import docker
        client = docker.from_env()
        client.ping()
        return client
    except Exception:
        return None


DOCKER = docker_client()


@unittest.skipIf(DOCKER is None, 'no Docker daemon reachable')
class RealDockerJobTests(unittest.TestCase):
    def setUp(self):
        from job.RunManager import RunManager
        self.runner = RunManager()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.runner.jobs_dir = Path(self.folder.name)
        self.job_id = 0

    def run_job(self, script, deadline=30, **manifest):
        self.job_id += 1
        self.runner.prepareJob({'image': IMAGE, 'command': ['sh', '-c', script], **manifest}, self.job_id)
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.runner.startJob(self.job_id, deadline)
        return result, self.runner.out_dir

    def read(self, out_dir, name):
        return (out_dir / name).read_text().strip()

    # ───────────── output and hashing ─────────────

    def test_output_is_produced_and_hashes_the_same_on_every_run(self):
        script = 'mkdir -p /output/sub && echo "result 42" > /output/result.txt && printf abc > /output/sub/data.bin'
        first, out1 = self.run_job(script)
        self.assertEqual(first.status, 'ok', getattr(first, 'message', ''))
        self.assertEqual(self.read(out1, 'result.txt'), 'result 42')
        time.sleep(1.1)  # different mtimes must not change the hash
        second, out2 = self.run_job(script)
        self.assertNotEqual(out1, out2)
        self.assertEqual(self.runner.hash_dir(out1), self.runner.hash_dir(out2))

    def test_different_output_hashes_differently(self):
        _, a = self.run_job('echo a > /output/r')
        _, b = self.run_job('echo b > /output/r')
        self.assertNotEqual(self.runner.hash_dir(a), self.runner.hash_dir(b))

    def test_a_failing_job_reports_its_exit_code_and_logs(self):
        result, _ = self.run_job('echo "something broke" >&2; exit 3')
        self.assertEqual((result.status, result.exitCode), ('failed', 3))
        self.assertIn('something broke', result.message)

    def test_a_runner_reconnects_to_its_container_and_reuses_completed_output(self):
        from blockchain.State import ExecutionPaused, ProviderState
        from job.RunManager import RunManager

        root = Path(self.folder.name)
        identity = {'chain_id': 31337, 'genesis': str(root), 'signer': 'test'}
        state = ProviderState(identity, b'test-seed', root / 'providers')
        self.addCleanup(state.close)
        stop = threading.Event()
        self.runner.enable_recovery(state, stop)
        manifest = {'image': IMAGE, 'command': ['sh', '-c',
                    'echo started >> /output/runs; sleep 2; echo done > /output/result']}
        self.runner.prepareJob(manifest, 7)
        self.addCleanup(self.runner.cleanupJob, 7)

        def pause_after_start():
            end = time.monotonic() + 5
            while time.monotonic() < end:
                if (self.runner.out_dir / 'runs').is_file():
                    stop.set()
                    return
                time.sleep(0.05)
            stop.set()

        watcher = threading.Thread(target=pause_after_start)
        watcher.start()
        try:
            with self.assertRaises(ExecutionPaused):
                self.runner.startJob(7, 10)
        finally:
            watcher.join()
        name = state.job(7)['execution']['container']
        self.assertEqual(DOCKER.containers.get(name).labels['offbalance.provider'], state.directory.name)

        restarted = RunManager()
        restarted.jobs_dir = root
        restarted.enable_recovery(state, threading.Event())
        restarted.prepareJob(manifest, 7)
        self.assertEqual(restarted.startJob(7, 10).status, 'ok')
        self.assertEqual(self.read(restarted.out_dir, 'runs'), 'started')
        self.assertEqual(self.read(restarted.out_dir, 'result'), 'done')
        self.assertEqual(restarted.startJob(7, 10).status, 'ok')
        self.assertEqual(self.read(restarted.out_dir, 'runs'), 'started')

    # ───────────── isolation ─────────────

    def test_jobs_without_an_input_url_have_no_network(self):
        result, out = self.run_job('ls /sys/class/net > /output/interfaces')
        self.assertEqual(result.status, 'ok')
        self.assertEqual(self.read(out, 'interfaces').split(), ['lo'])

    def test_memory_limit_is_enforced(self):
        # holds about 100 MB in a shell variable against a 32 MB limit (no extra swap)
        result, _ = self.run_job('x=$(head -c 104857600 /dev/zero | tr "\\0" a); echo ${#x}', mem_limit_mb=32)
        self.assertEqual(result.status, 'oom')

    def test_cpu_limit_reaches_the_container(self):
        result, out = self.run_job('cat /sys/fs/cgroup/cpu.max > /output/cpu 2>/dev/null || echo unknown > /output/cpu',
                                   cpu_limit=0.5)
        self.assertEqual(result.status, 'ok')
        cpu = self.read(out, 'cpu')
        if cpu == 'unknown':
            self.skipTest('cgroup v1 host: cpu.max not available')
        quota, period = cpu.split()
        self.assertAlmostEqual(int(quota) / int(period), 0.5, places=2)

    def test_a_job_past_its_deadline_is_stopped_and_removed(self):
        before = {c.id for c in DOCKER.containers.list(all=True)}
        started = time.monotonic()
        result, _ = self.run_job('sleep 60', deadline=2)
        self.assertEqual(result.status, 'timeout')
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual({c.id for c in DOCKER.containers.list(all=True)} - before, set(), 'no container left behind')

    def test_output_files_belong_to_the_provider_not_root(self):
        result, out = self.run_job('echo hi > /output/owned; id -u > /output/uid')
        self.assertEqual(result.status, 'ok')
        rootless = any(o.split(',')[0] == 'name=rootless' for o in DOCKER.info().get('SecurityOptions') or [])
        if not rootless:
            self.assertEqual(self.read(out, 'uid'), str(os.getuid()))
        self.assertEqual((out / 'owned').stat().st_uid, os.getuid())

    def test_the_docker_socket_is_not_reachable_from_a_job(self):
        result, out = self.run_job('[ -e /var/run/docker.sock ] && echo present > /output/sock || echo absent > /output/sock')
        self.assertEqual(result.status, 'ok')
        self.assertEqual(self.read(out, 'sock'), 'absent')

    def test_only_output_reaches_the_host(self):
        result, out = self.run_job('echo secret > /tmp/elsewhere; echo kept > /output/kept')
        self.assertEqual(result.status, 'ok')
        self.assertEqual(sorted(p.name for p in out.iterdir()), ['kept'])

    # A job can leave a symlink in /output that points at a file on the provider's machine (here
    # ../../secret, outside the output folder). Hashing must cover the link itself, never what it
    # points to on the host: changing the host file mustn't change the hash.
    def test_a_symlink_out_of_the_output_folder_is_hashed_as_a_link_not_followed(self):
        result, out = self.run_job('ln -s ../../secret /output/link')
        self.assertEqual(result.status, 'ok')
        host_file = (out / '..' / '..' / 'secret').resolve()
        host_file.write_text('one')
        first = self.runner.hash_dir(out)
        host_file.write_text('two')
        self.assertEqual(self.runner.hash_dir(out), first)

    # B9: the runner caps the number of processes, so a job can't fork-bomb the provider's
    # machine. The job only reads the limit.
    def test_a_job_cant_start_unlimited_processes(self):
        from job.RunManager import JOB_PIDS_LIMIT
        result, out = self.run_job('cat /sys/fs/cgroup/pids.max > /output/pids 2>/dev/null || echo unknown > /output/pids')
        self.assertEqual(result.status, 'ok')
        self.assertEqual(self.read(out, 'pids'), str(JOB_PIDS_LIMIT), 'no process limit')

    # B10: setuid binaries in a job's image can't gain privileges inside the container
    # (Docker's `no-new-privileges`).
    def test_a_job_cant_gain_new_privileges(self):
        result, out = self.run_job("grep NoNewPrivs /proc/self/status | awk '{print $2}' > /output/nnp")
        self.assertEqual(result.status, 'ok')
        self.assertEqual(self.read(out, 'nnp'), '1')


if __name__ == '__main__':
    unittest.main()
