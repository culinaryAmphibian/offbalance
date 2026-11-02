"""Local result delivery tests: no cloud, Docker daemon or chain needed."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from job.Archive import result_archive
from job.RunManager import RunManager
from ProviderClient import ProviderClient
from blockchain.BlockchainManager import BlockchainManager
from blockchain.BlockchainEvent import BlockchainEvent
from blockchain.EventData import CommitPhaseStartEvent, DeliveryPhaseStartEvent, RevealPhaseStartEvent, event_class_factory
from server.ServerManager import ServerManager


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'nested').mkdir()
        (self.root / 'nested' / 'result.txt').write_text('hello')
        (self.root / 'link').symlink_to('nested/result.txt')

    def test_archive_preserves_content_and_directory_hash_without_following_links(self):
        expected = RunManager.hash_dir(self.root)
        with result_archive(self.root, expected) as (file, size):
            self.assertEqual(os.fstat(file.fileno()).st_mode & 0o777, 0o600)
            first = file.read()
            self.assertEqual(size, len(first))
            archive = tarfile.open(fileobj=io.BytesIO(first), mode='r:')
            self.assertEqual(archive.getnames(), ['link', 'nested/result.txt'])
            self.assertTrue(archive.getmember('link').issym())
            self.assertEqual(archive.getmember('link').linkname, 'nested/result.txt')
            self.assertEqual(archive.extractfile('nested/result.txt').read(), b'hello')
        with result_archive(self.root, expected) as (file, _):
            self.assertEqual(file.read(), first)

    def test_changed_output_is_rejected_before_upload(self):
        expected = RunManager.hash_dir(self.root)
        (self.root / 'nested' / 'result.txt').write_text('changed')
        with self.assertRaises(ValueError):
            with result_archive(self.root, expected):
                self.fail('changed output admitted')

    def test_long_ascii_and_unicode_paths_and_link_targets_preserve_committed_content(self):
        names = ['a' * 101, '界' * 60 + '.txt']
        for name in names:
            (self.root / name).write_text('long result path')
        (self.root / 'long-link').symlink_to(names[0])
        digest = RunManager.hash_dir(self.root)
        with result_archive(self.root, digest) as (file, _):
            with tarfile.open(fileobj=file, mode='r:') as archive:
                for name in names:
                    self.assertEqual(archive.extractfile(name).read(), b'long result path')
                self.assertEqual(archive.getmember('long-link').linkname, names[0])

    def test_external_and_parent_links_are_rejected(self):
        for target in ('/etc/passwd', '../secret', 'nested/../../secret', 'a\\b'):
            (self.root / 'link').unlink()
            (self.root / 'link').symlink_to(target)
            with self.subTest(target=target), self.assertRaises(ValueError):
                with result_archive(self.root, RunManager.hash_dir(self.root)):
                    self.fail('unsafe link admitted')

    def test_special_files_unsafe_names_and_symlink_roots_are_rejected(self):
        fifo = self.root / 'pipe'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            with result_archive(self.root, bytes(32)):
                pass
        fifo.unlink()
        unsafe = self.root / 'bad\\name'
        unsafe.touch()
        with self.assertRaises(ValueError):
            with result_archive(self.root, bytes(32)):
                pass
        unsafe.unlink()
        (self.root / 'root-link').symlink_to(self.root)
        with self.assertRaises(OSError):
            with result_archive(self.root / 'root-link', bytes(32)):
                pass

    def test_size_entry_and_stop_limits(self):
        for limits in ({'max_bytes': 1000}, {'max_entries': 1}):
            with self.subTest(limits=limits), self.assertRaises(ValueError):
                with result_archive(self.root, RunManager.hash_dir(self.root), **limits):
                    pass
        stop = threading.Event()
        stop.set()
        with self.assertRaises(RuntimeError):
            with result_archive(self.root, bytes(32), stop):
                pass


class CommitEventTests(unittest.TestCase):
    def setUp(self):
        self.w3 = Mock()
        self.w3.eth.block_number = 12
        self.w3.eth.get_block.side_effect = lambda block: {'timestamp': 100 if block == 12 else 125}
        self.blockchain = BlockchainManager(self.w3, Mock(), SimpleNamespace(address='provider'), b's' * 32)
        self.runner, self.server = Mock(), Mock()
        self.runner.currentJobId = 7
        self.runner.currentManifest = {'timeout_s': 60}
        self.client = ProviderClient(Mock(), self.blockchain, self.server, self.runner)

    def test_milestone4_commit_event_has_no_deadline_and_old_mock_duration_is_preserved(self):
        for args, expected in (({'jobId': 7}, None), ({'jobId': 7, 'deadline': 60}, 60)):
            with self.subTest(args=args):
                event = event_class_factory({'blockNumber': 12, 'event': 'COMMIT_PHASE_START', 'args': args})
                self.assertIsInstance(event, CommitPhaseStartEvent)
                self.assertEqual((event.jobId, event.block_number, event.deadline), (7, 12, expected))

    def test_milestone4_event_uses_remaining_chain_time_for_the_assigned_manifest(self):
        event = event_class_factory({'blockNumber': 12, 'event': 'COMMIT_PHASE_START', 'args': {'jobId': 7}})
        with patch('ProviderClient.threading.Thread') as worker:
            self.client._handle_event(event)
            worker.assert_called_once_with(target=self.client._runAndCommit, args=(7, 35), daemon=True)
            worker.return_value.start.assert_called_once()
        self.assertEqual([call.args[0] for call in self.w3.eth.get_block.call_args_list], [12, 'latest'])
        self.server.report_error.assert_not_called()

    def test_unassigned_commit_event_never_reads_the_execution_window(self):
        event = event_class_factory({'blockNumber': 12, 'event': 'COMMIT_PHASE_START', 'args': {'jobId': 8}})
        with patch('ProviderClient.threading.Thread') as worker:
            self.client._handle_event(event)
            worker.assert_not_called()
        self.w3.eth.get_block.assert_not_called()

    def test_expired_window_skips_execution_and_reports_a_clear_error(self):
        self.w3.eth.get_block.side_effect = lambda block: {'timestamp': 100 if block == 12 else 160}
        with patch('ProviderClient.threading.Thread') as worker, contextlib.redirect_stderr(io.StringIO()):
            self.client.handleCommitPhaseStart(7, block_number=12)
            worker.assert_not_called()
        self.server.report_error.assert_called_once_with(7, 'The commit execution window has expired; execution was skipped.')
        self.assertNotIn(7, self.client._running_jobs)

    def test_old_mock_duration_does_not_require_current_chain_reads(self):
        event = event_class_factory({'blockNumber': 12, 'event': 'COMMIT_PHASE_START', 'args': {'jobId': 7, 'deadline': 60}})
        with patch('ProviderClient.threading.Thread') as worker:
            self.client._handle_event(event)
            worker.assert_called_once_with(target=self.client._runAndCommit, args=(7, 60), daemon=True)
        self.w3.eth.get_block.assert_not_called()

    def test_invalid_manifest_timeout_is_reported_before_any_block_read(self):
        self.runner.currentManifest['timeout_s'] = 0
        with patch('ProviderClient.threading.Thread') as worker, contextlib.redirect_stderr(io.StringIO()):
            self.client.handleCommitPhaseStart(7, block_number=12)
            worker.assert_not_called()
        self.w3.eth.get_block.assert_not_called()
        self.server.report_error.assert_called_once_with(7, 'Cannot read the commit execution window.')


class DeliveryEventTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        (self.output / 'result.txt').write_text('result')
        self.result = RunManager.hash_dir(self.output)
        self.runner, self.blockchain, self.server = Mock(), Mock(), Mock()
        self.runner.startJob.return_value = SimpleNamespace(status='ok', output_dir=self.output)
        self.runner.hash_dir.return_value = self.result
        self.client = ProviderClient(Mock(), self.blockchain, self.server, self.runner)

    def test_successfully_committed_output_is_delivered_on_the_delivery_event(self):
        self.client._runAndCommit(7, 60)
        event = DeliveryPhaseStartEvent(3, BlockchainEvent.DELIVERY_PHASE_START, 7)
        with patch('ProviderClient.threading.Thread') as thread:
            self.client._handle_event(event)
            thread.assert_called_once_with(target=self.client._deliverResult, args=(7, self.output, self.result), daemon=True)
            thread.return_value.start.assert_called_once()
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        self.blockchain.commit.assert_called_once_with(7, self.result)
        self.server.deliver_result.assert_called_once_with(7, self.output, self.result, None)
        self.assertNotIn(7, self.client._delivering)

    def test_unassigned_or_duplicate_delivery_events_do_not_start_upload_workers(self):
        self.client._runAndCommit(7, 60)
        with patch('ProviderClient.threading.Thread') as thread:
            self.client.handleDeliveryPhaseStart(8)
            thread.assert_not_called()
            self.client.handleDeliveryPhaseStart(7)
            self.client.handleDeliveryPhaseStart(7)
            self.assertEqual(thread.call_count, 1)

    def test_failed_commitment_does_not_make_output_available_for_delivery(self):
        self.blockchain.commit.side_effect = RuntimeError('commitment failed')
        with contextlib.redirect_stderr(io.StringIO()):
            self.client._runAndCommit(7, 60)
        with patch('ProviderClient.threading.Thread') as thread:
            self.client.handleDeliveryPhaseStart(7)
            thread.assert_not_called()
        self.server.deliver_result.assert_not_called()

    def test_upload_failure_does_not_crash_or_log_credentials(self):
        self.server.deliver_result.side_effect = requests.ConnectionError('https://secret-token@example.invalid?token=secret-token')
        self.client._delivering.add(7)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.client._deliverResult(7, self.output, self.result)
        self.assertNotIn('secret-token', output.getvalue())
        self.assertIn('result delivery failed', output.getvalue())
        self.assertNotIn(7, self.client._delivering)
        self.server.report_error.assert_not_called()

    def test_reveal_event_preserves_existing_commit_reveal_flow(self):
        event = RevealPhaseStartEvent(2, BlockchainEvent.REVEAL_PHASE_START, 7)
        self.client._handle_event(event)
        self.blockchain.reveal.assert_called_once_with(7)


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        (self.output / 'result.txt').write_text('hello')
        self.result = RunManager.hash_dir(self.output)
        self.manager = ServerManager('https://localhost:5000', 'provider-secret')
        self.manager.session.verify = '/trusted/local-ca.pem'
        self.addCleanup(self.manager.close)

    def test_upload_is_bounded_raw_tar_authenticated_and_does_not_follow_redirects(self):
        session = Mock()
        session.headers = {}
        captured = {}
        def post(url, **kwargs):
            captured.update(url=url, **kwargs)
            captured['bytes'] = kwargs['data'].read()
            return SimpleNamespace(status_code=201, json=lambda: {'results': [{'contentVerified': True, 'receiptVerified': True}]})
        session.post.side_effect = post
        with patch('server.ServerManager.requests.Session') as factory:
            factory.return_value.__enter__.return_value = session
            self.manager.deliver_result(7, self.output, self.result)
        self.assertEqual(session.headers['Authorization'], 'Bearer provider-secret')
        self.assertEqual(session.verify, '/trusted/local-ca.pem')
        self.assertEqual(captured['url'], 'https://localhost:5000/provider/results/7')
        self.assertFalse(captured['allow_redirects'])
        self.assertEqual(captured['headers']['Content-Type'], 'application/x-tar')
        self.assertEqual(int(captured['headers']['Content-Length']), len(captured['bytes']))
        self.assertEqual(captured['headers']['X-Result-Hash'], self.result.hex())
        self.assertEqual(tarfile.open(fileobj=io.BytesIO(captured['bytes'])).getnames(), ['result.txt'])

    def test_http_and_unconfirmed_receipt_failures_are_sanitized(self):
        for response in (SimpleNamespace(status_code=302), SimpleNamespace(status_code=503),
                         SimpleNamespace(status_code=201, json=lambda: {'results': [{'receiptVerified': False}]})):
            with self.subTest(status=response.status_code), patch('server.ServerManager.requests.Session') as factory:
                factory.return_value.__enter__.return_value.post.return_value = response
                with self.assertRaisesRegex(requests.RequestException, '^Result upload failed.$'):
                    self.manager.deliver_result(7, self.output, self.result)

    def test_verified_offchain_or_local_delivery_keeps_chain_receipt_false(self):
        for mode in ('offchain', 'local'):
            for location in ('item', 'top-level'):
                record = {'contentVerified': True, 'receiptVerified': False}
                result = {'results': [record]}
                (record if location == 'item' else result)['receiptMode'] = mode
                with self.subTest(mode=mode, location=location), patch('server.ServerManager.requests.Session') as factory:
                    factory.return_value.__enter__.return_value.post.return_value = SimpleNamespace(status_code=201, json=lambda: result)
                    received = self.manager.deliver_result(7, self.output, self.result)
                    self.assertEqual(received, result)
                    self.assertIs(received['results'][0]['receiptVerified'], False)

    def test_pending_onchain_or_unverified_content_is_not_a_successful_delivery(self):
        responses = [
            {'receiptMode': 'onchain', 'results': [{'contentVerified': True, 'receiptVerified': False}]},
            {'receiptMode': 'offchain', 'results': [{'contentVerified': False, 'receiptVerified': False}]},
            {'receiptMode': 'local', 'results': [{'receiptVerified': False}]},
            {'results': [{'contentVerified': False, 'receiptVerified': True}]},
            {'ok': True},
        ]
        for result in responses:
            with self.subTest(response=result), patch('server.ServerManager.requests.Session') as factory:
                factory.return_value.__enter__.return_value.post.return_value = SimpleNamespace(status_code=202, json=lambda: result)
                with self.assertRaisesRegex(requests.RequestException, '^Result upload failed.$'):
                    self.manager.deliver_result(7, self.output, self.result)


if __name__ == '__main__':
    unittest.main()
