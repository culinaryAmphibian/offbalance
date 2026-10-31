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
from blockchain.BlockchainEvent import BlockchainEvent
from blockchain.EventData import DeliveryPhaseStartEvent, RevealPhaseStartEvent
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
            return SimpleNamespace(status_code=201, json=lambda: {'results': [{'receiptVerified': True}]})
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


if __name__ == '__main__':
    unittest.main()
