import contextlib
import io
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ProviderClient import ProviderClient
from server.ServerManager import ServerManager


def http_error(status):
    response = requests.Response()
    response.status_code = status
    return requests.HTTPError(response=response)


class AvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.benchmark = Mock()
        self.blockchain = Mock()
        self.blockchain.pollEvents.return_value = []
        self.server = Mock()
        self.client = ProviderClient(self.benchmark, self.blockchain, self.server, Mock())
        self.stop = threading.Event()
        self.sent = 0

    def run_until_heartbeats(self, count, failures=()):
        failures = iter(failures)

        def heartbeat():
            self.sent += 1
            if self.sent >= count:
                self.stop.set()
            failure = next(failures, None)
            if failure:
                raise failure

        self.server.heartbeat.side_effect = heartbeat
        # Fail the test instead of hanging if the worker fails to start/retry.
        timeout = threading.Timer(2, self.stop.set)
        timeout.start()
        try:
            with patch('ProviderClient.HEARTBEAT_INTERVAL_SECONDS', 0.01), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.client.run(self.stop)
        finally:
            timeout.cancel()

    def test_benchmark_precedes_immediate_heartbeat_and_periodic_renewal(self):
        calls = Mock()
        calls.attach_mock(self.server.post_benchmark, 'benchmark')
        calls.attach_mock(self.server.heartbeat, 'heartbeat')
        self.run_until_heartbeats(3)
        self.assertEqual(calls.mock_calls[0][0], 'benchmark')
        self.assertEqual(calls.mock_calls[1][0], 'heartbeat')
        self.server.post_benchmark.assert_called_once_with(self.benchmark.do_benchmark.return_value)
        self.assertEqual(self.sent, 3)
        self.assertGreater(self.blockchain.pollEvents.call_count, 0)

    def test_network_failures_retry_while_event_polling_continues(self):
        self.run_until_heartbeats(4, [requests.ConnectionError(), requests.Timeout(), http_error(503)])
        self.assertEqual(self.sent, 4)
        self.assertGreater(self.blockchain.pollEvents.call_count, 0)

    def test_invalid_credentials_stop_before_polling(self):
        for status in (401, 403):
            self.stop.clear()
            with self.subTest(status=status), self.assertRaises(requests.HTTPError):
                self.run_until_heartbeats(3, [http_error(status)])
        self.blockchain.pollEvents.assert_not_called()

    def test_revocation_stops_periodic_heartbeats_and_the_event_loop(self):
        with self.assertRaises(requests.HTTPError):
            self.run_until_heartbeats(3, [None, http_error(401)])
        self.assertEqual(self.sent, 2)
        self.assertTrue(self.stop.is_set())

    def test_untrusted_tls_stops_the_client(self):
        with self.assertRaises(requests.exceptions.SSLError):
            self.run_until_heartbeats(3, [requests.exceptions.SSLError()])
        self.blockchain.pollEvents.assert_not_called()

    def test_failed_benchmark_registration_never_advertises_availability(self):
        self.server.post_benchmark.side_effect = requests.ConnectionError()
        with self.assertRaises(requests.ConnectionError):
            self.run_until_heartbeats(3)
        self.server.heartbeat.assert_not_called()

    def test_heartbeats_continue_while_chain_polling_is_blocked(self):
        renewed = threading.Event()

        def heartbeat():
            self.sent += 1
            if self.sent == 2:
                renewed.set()

        def poll():
            self.assertTrue(renewed.wait(2), 'slow chain polling blocked the heartbeat worker')
            self.stop.set()
            return []

        self.server.heartbeat.side_effect = heartbeat
        self.blockchain.pollEvents.side_effect = poll
        with patch('ProviderClient.HEARTBEAT_INTERVAL_SECONDS', 0.01):
            self.client.run(self.stop)
        self.assertGreaterEqual(self.sent, 2)

    def test_fatal_chain_error_stops_and_joins_the_heartbeat_worker(self):
        self.blockchain.pollEvents.side_effect = RuntimeError('chain unavailable')
        with self.assertRaises(RuntimeError):
            self.run_until_heartbeats(3)
        self.assertEqual(self.sent, 1)
        self.assertTrue(self.stop.is_set())
        self.assertFalse(any(t.name == 'provider-heartbeat' for t in threading.enumerate()))

    def test_heartbeat_uses_separate_authenticated_session_and_verified_https(self):
        manager = ServerManager('https://localhost:5000/', 'provider-token')
        try:
            self.assertIsNot(manager._heartbeat_session, manager.session)
            with patch.object(manager._heartbeat_session, 'post') as post:
                manager.heartbeat()
                post.assert_called_once_with('https://localhost:5000/provider/heartbeat', timeout=15)
                post.return_value.raise_for_status.assert_called_once()
            self.assertEqual(manager._heartbeat_session.headers['Authorization'], 'Bearer provider-token')
            self.assertIs(manager._heartbeat_session.verify, True)
            manager.session.verify = '/local/ca.pem'
            manager.set_access_token('replacement-token')
            with patch.object(manager._heartbeat_session, 'post'):
                manager.heartbeat()
            self.assertEqual(manager._heartbeat_session.verify, '/local/ca.pem')
            self.assertEqual(manager._heartbeat_session.headers['Authorization'], 'Bearer replacement-token')
        finally:
            manager.close()


if __name__ == '__main__':
    unittest.main()
