import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ProviderClient import ProviderClient
from job.JobResult import JobResult
from job.RunManager import RunManager
from server.ServerManager import ServerManager


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.docker = Mock()
        with patch('job.RunManager.docker.from_env', return_value=self.docker):
            self.runner = RunManager()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.runner.jobs_dir = Path(self.folder.name)
        self.runner.prepareJob({'image': 'job@sha256:123', 'command': ['run-job']}, 7)
        self.docker.info.return_value = {'SecurityOptions': []}
        self.container = self.docker.containers.run.return_value
        self.container.wait.return_value = {'StatusCode': 0}
        self.container.attrs = {'State': {'OOMKilled': False}}

    def test_rootless_uses_container_root_with_the_original_output_mount(self):
        self.docker.info.return_value = {'SecurityOptions': ['name=seccomp,profile=builtin', 'name=rootless']}
        result = self.runner.startJob(7, 60)
        args = self.docker.containers.run.call_args.kwargs
        self.assertEqual(args['user'], '0:0')
        self.assertEqual(args['volumes'], {str(self.runner.out_dir): {'bind': '/output', 'mode': 'rw'}})
        self.assertEqual(args['command'], ['run-job'])
        self.assertNotIn('entrypoint', args)
        self.assertEqual(result.status, 'ok')
        self.assertFalse(self.runner.isActive)
        self.container.remove.assert_called_once_with(force=True)

    def test_rootful_keeps_host_uid_and_gid(self):
        with patch('job.RunManager.os.getuid', return_value=123), patch('job.RunManager.os.getgid', return_value=456):
            self.runner.startJob(7, 60)
        self.assertEqual(self.docker.containers.run.call_args.kwargs['user'], '123:456')

    def test_failure_captures_useful_container_logs_and_removes_it(self):
        self.container.wait.return_value = {'StatusCode': 1}
        self.container.logs.return_value = b"sh: can't create /output/result.txt: Permission denied"
        result = self.runner.startJob(7, 60)
        self.assertEqual(result.status, 'failed')
        self.assertEqual(result.exitCode, 1)
        self.assertIn('Permission denied', result.message)
        self.container.remove.assert_called_once_with(force=True)
        self.assertFalse(self.runner.isActive)

    def test_timeout_stops_and_removes_container(self):
        self.container.wait.side_effect = requests.ReadTimeout()
        self.assertEqual(self.runner.startJob(7, 1).status, 'timeout')
        self.container.remove.assert_called_once_with(force=True)
        self.assertFalse(self.runner.isActive)

    def test_exception_during_execution_also_removes_container(self):
        self.container.wait.side_effect = RuntimeError('daemon disconnected')
        with self.assertRaisesRegex(RuntimeError, 'daemon disconnected'):
            self.runner.startJob(7, 60)
        self.container.remove.assert_called_once_with(force=True)
        self.assertFalse(self.runner.isActive)

    def test_image_failure_resets_active_state(self):
        self.docker.images.get.side_effect = RuntimeError('cannot fetch image')
        with self.assertRaisesRegex(RuntimeError, 'cannot fetch image'):
            self.runner.startJob(7, 60)
        self.assertFalse(self.runner.isActive)
        self.docker.containers.run.assert_not_called()


class ExecutionReportingTests(unittest.TestCase):
    def setUp(self):
        self.server = Mock()
        self.runner = Mock()
        self.runner.currentJobId = 7
        self.blockchain = Mock()
        self.client = ProviderClient(Mock(), self.blockchain, self.server, self.runner)
        self.stderr = contextlib.redirect_stderr(io.StringIO())
        self.stderr.__enter__()
        self.addCleanup(self.stderr.__exit__, None, None, None)

    def test_nonzero_exit_timeout_and_oom_are_reported_without_commit(self):
        for status in ['failed', 'timeout', 'oom']:
            with self.subTest(status=status):
                self.runner.startJob.return_value = JobResult(status, exitCode=1, message='container detail')
                self.client._runAndCommit(7, 60)
                self.assertIn(status, self.server.report_error.call_args.args[1])
                self.assertIn('container detail', self.server.report_error.call_args.args[1])
        self.blockchain.commit.assert_not_called()

    def test_runner_exceptions_are_reported(self):
        self.runner.startJob.side_effect = RuntimeError('daemon unavailable')
        self.client._runAndCommit(7, 60)
        self.server.report_error.assert_called_once_with(7, 'Execution or commitment failed: daemon unavailable')
        self.blockchain.commit.assert_not_called()

    def test_successful_output_is_hashed_and_committed(self):
        self.runner.startJob.return_value = JobResult('ok', output_dir=Path('/output'))
        self.runner.hash_dir.return_value = b'winning-hash'
        self.client._runAndCommit(7, 60)
        self.blockchain.commit.assert_called_once_with(7, b'winning-hash')
        self.server.report_error.assert_not_called()

    def test_unassigned_and_duplicate_events_do_not_start_workers(self):
        with patch('ProviderClient.threading.Thread') as worker:
            self.client.handleCommitPhaseStart(8, 60)
            worker.assert_not_called()
            self.client.handleCommitPhaseStart(7, 60)
            self.client.handleCommitPhaseStart(7, 60)
            self.assertEqual(worker.call_count, 1)
            worker.return_value.start.assert_called_once()

    def test_error_reporting_network_failure_is_visible_without_crashing_worker(self):
        self.runner.startJob.side_effect = RuntimeError('container failed')
        self.server.report_error.side_effect = requests.ConnectionError('coordinator unavailable')
        self.client._runAndCommit(7, 60)
        self.assertIn('error report failed', self.stderr._new_target.getvalue())

    def test_report_uses_own_authenticated_session_and_certificate_trust(self):
        manager = ServerManager('https://localhost:5000/', 'provider-token')
        self.addCleanup(manager.close)
        manager.session.verify = '/local/ca.pem'
        with patch('server.ServerManager.requests.Session') as session_factory:
            session = session_factory.return_value.__enter__.return_value
            manager.report_error(7, 'permission denied')
            session.headers.update.assert_called_once_with(manager.session.headers)
            self.assertEqual(session.verify, '/local/ca.pem')
            session.post.assert_called_once_with(
                'https://localhost:5000/provider/jobs/7/error',
                json={'message': 'permission denied'}, timeout=15,
            )
            session.post.return_value.raise_for_status.assert_called_once()
            session_factory.return_value.__exit__.assert_called_once()


if __name__ == '__main__':
    unittest.main()
