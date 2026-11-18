# Unit tests for the client's chain layer and event dispatch, without a node or a server:
#   - ProviderContractWrapper: building, signing and sending transactions; reverted receipts
#   - BlockchainManager: block-range polling, chain-time deadlines, per-job salts, stake/commit/reveal
#   - event_class_factory: every event type the client subscribes to
#   - ProviderClient._handle_event: dispatch, and the error paths around preparing and running a job
#   - ServerManager: error handling for benchmarks, hardware lookups and error reports
from pathlib import Path
import contextlib
import io
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import requests
from web3 import Web3
from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from Credentials import Credentials, parse_session_key
from ProviderClient import ProviderClient
from blockchain.BlockchainEvent import BlockchainEvent
from blockchain.BlockchainManager import BlockchainManager
from blockchain.Contract import ProviderContractWrapper, TransactionFailed
from blockchain.EventData import (CanceledEvent, CommitPhaseStartEvent, DeliveredEvent, DeliveryPhaseStartEvent,
                                  Event, NoQuorumEvent, ProviderSelectedEvent, RevealPhaseStartEvent,
                                  event_class_factory)
from server.ServerManager import DeliveryError, ServerManager

KEY = '0x' + '11' * 32
OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'


def silenced(fn):
    def wrapper(*args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    return wrapper


def fake_w3(block_number=10, receipt_status=1, nonce=7):
    w3 = Mock()
    w3.eth.block_number = block_number
    w3.eth.get_transaction_count.return_value = nonce
    w3.eth.send_raw_transaction.return_value = b'\x01' * 32
    w3.eth.wait_for_transaction_receipt.return_value = {
        'status': receipt_status, 'blockNumber': block_number, 'transactionHash': bytes.fromhex('ab' * 32)}
    return w3


def fake_signer(address=OWNER):
    signer = Mock()
    signer.address = address
    signer.sign_transaction.return_value = SimpleNamespace(raw_transaction=b'signed')
    return signer


class ContractWrapperTests(unittest.TestCase):
    def setUp(self):
        self.contract = MagicMock()
        self.wrapper = ProviderContractWrapper(self.contract)
        self.w3 = fake_w3()
        self.signer = fake_signer()

    def built(self, fn_name):
        return getattr(self.contract.functions, fn_name).return_value.build_transaction.call_args[0][0]

    @silenced
    def test_stake_sends_exactly_the_amount_from_the_signer_with_the_pending_nonce(self):
        receipt = self.wrapper.submitStake(4, 6_000, self.signer, self.w3)
        self.contract.functions.submitStake.assert_called_once_with(4)
        self.assertEqual(self.built('submitStake'), {'from': OWNER, 'value': 6_000, 'nonce': 7})
        self.w3.eth.get_transaction_count.assert_called_once_with(OWNER, 'pending')
        self.w3.eth.send_raw_transaction.assert_called_once_with(b'signed')
        self.assertEqual(receipt['status'], 1)

    @silenced
    def test_commit_and_reveal_send_no_value(self):
        self.wrapper.submitCommitment(4, b'\x02' * 32, self.signer, self.w3)
        self.wrapper.submitReveal(4, b'\x03' * 32, b'\x04' * 32, self.signer, self.w3)
        self.contract.functions.submitCommitment.assert_called_once_with(4, b'\x02' * 32)
        self.contract.functions.submitReveal.assert_called_once_with(4, b'\x03' * 32, b'\x04' * 32)
        self.assertEqual(self.built('submitCommitment')['value'], 0)
        self.assertEqual(self.built('submitReveal')['value'], 0)

    def test_a_reverted_transaction_raises_with_its_hash(self):
        w3 = fake_w3(receipt_status=0)
        with self.assertRaises(TransactionFailed) as raised:
            self.wrapper.submitStake(4, 1, self.signer, w3)
        self.assertIn('stake for job 4 reverted', str(raised.exception))
        self.assertIn('ab' * 32, str(raised.exception))

    def test_views_read_the_contract(self):
        self.contract.functions.providerOf.return_value.call.return_value = OWNER
        self.contract.functions.sessionKeys.return_value.call.return_value = (OWNER, 1234)
        self.contract.functions.stakeFor.return_value.call.return_value = 6_000
        self.assertEqual(self.wrapper.providerOf('0xkey'), OWNER)
        self.assertEqual(self.wrapper.sessionKeyInfo('0xkey'), (OWNER, 1234))
        self.assertEqual(self.wrapper.stakeFor(OWNER), 6_000)

    def test_event_logs_are_decoded_and_unknown_events_rejected(self):
        log = {'blockNumber': 3, 'event': 'REVEAL_PHASE_START', 'args': {'jobId': 4, 'deadline': 99}}
        self.contract.events.REVEAL_PHASE_START.return_value.get_logs.return_value = [log]
        events = self.wrapper.getEventLogs(BlockchainEvent.REVEAL_PHASE_START, 1, 3)
        self.assertIsInstance(events[0], RevealPhaseStartEvent)
        self.contract.events.REVEAL_PHASE_START.return_value.get_logs.assert_called_once_with(from_block=1, to_block=3)
        missing = ProviderContractWrapper(SimpleNamespace(events=SimpleNamespace()))
        with self.assertRaises(ValueError):
            missing.getEventLogs(BlockchainEvent.REVEAL_PHASE_START, 1, 3)


class BlockchainManagerTests(unittest.TestCase):
    def setUp(self):
        self.w3 = fake_w3(block_number=10)
        self.contract = Mock()
        self.contract.getEventLogs.return_value = []
        self.creds = Credentials('api', parse_session_key(KEY), owner=OWNER)
        self.manager = BlockchainManager(self.w3, self.contract, self.creds)

    def test_needs_the_owner_resolved_first(self):
        with self.assertRaises(ValueError):
            BlockchainManager(self.w3, self.contract, Credentials('api', parse_session_key(KEY)))

    def test_polls_each_new_block_range_once_for_every_event_type(self):
        self.w3.eth.block_number = 12
        self.manager.pollEvents()
        ranges = {(c.args[1], c.args[2]) for c in self.contract.getEventLogs.call_args_list}
        self.assertEqual(ranges, {(10, 12)}, 'starts at the block current when the client started')
        self.assertEqual({c.args[0] for c in self.contract.getEventLogs.call_args_list}, set(BlockchainManager.event_types))

        self.contract.getEventLogs.reset_mock()
        self.manager.pollEvents()  # no new block
        self.contract.getEventLogs.assert_not_called()

        self.w3.eth.block_number = 13
        self.manager.pollEvents()
        self.assertEqual({(c.args[1], c.args[2]) for c in self.contract.getEventLogs.call_args_list}, {(13, 13)})

    def test_one_jobs_events_fetched_in_one_range_come_out_in_lifecycle_order(self):
        # the client polls by event type, so a lagging client gets a batch; for one job, the type
        # order has to match the order the phases happen in
        by_type = {
            BlockchainEvent.PROVIDER_SELECTED: [ProviderSelectedEvent(11, BlockchainEvent.PROVIDER_SELECTED, 4, OWNER, 1)],
            BlockchainEvent.COMMIT_PHASE_START: [CommitPhaseStartEvent(12, BlockchainEvent.COMMIT_PHASE_START, 4, 99)],
            BlockchainEvent.REVEAL_PHASE_START: [RevealPhaseStartEvent(13, BlockchainEvent.REVEAL_PHASE_START, 4)],
            BlockchainEvent.DELIVERY_PHASE_START: [DeliveryPhaseStartEvent(14, BlockchainEvent.DELIVERY_PHASE_START, 4)],
            BlockchainEvent.DELIVERED: [DeliveredEvent(15, BlockchainEvent.DELIVERED, 4)],
        }
        self.contract.getEventLogs.side_effect = lambda kind, start, end: by_type.get(kind, [])
        self.w3.eth.block_number = 15
        blocks = [e.block_number for e in self.manager.pollEvents()]
        self.assertEqual(blocks, sorted(blocks))

    def test_seconds_until_uses_chain_time_and_never_goes_negative(self):
        self.w3.eth.get_block.return_value = {'timestamp': 1_000}
        self.assertEqual(self.manager.seconds_until(1_030), 30)
        self.assertEqual(self.manager.seconds_until(900), 0)

    def test_execution_window_counts_from_the_event_block(self):
        blocks = {5: {'timestamp': 1_000}, 'latest': {'timestamp': 1_010}}
        self.w3.eth.get_block.side_effect = lambda b: blocks[b]
        self.assertEqual(self.manager.execution_window(5, 60), 50)
        self.assertEqual(self.manager.execution_window(5, 5), 0)
        for bad in (0, -1, True, 1.5, '60'):
            with self.assertRaises(ValueError):
                self.manager.execution_window(5, bad)
        blocks['latest'] = {'timestamp': 900}  # event block ahead of the chain head
        with self.assertRaises(ValueError):
            self.manager.execution_window(5, 60)

    def test_salts_are_per_job_per_key_and_never_the_seed(self):
        a, b = self.manager.job_key(1), self.manager.job_key(2)
        self.assertEqual(len(a), 32)
        self.assertNotEqual(a, b)
        self.assertEqual(a, self.manager.job_key(1))
        self.assertNotEqual(a, self.creds.key_seed)
        other = BlockchainManager(self.w3, self.contract, Credentials('api', parse_session_key('0x' + '22' * 32), owner=OWNER))
        self.assertNotEqual(a, other.job_key(1))

    def test_commitment_is_what_the_contract_recomputes_from_the_reveal(self):
        result_hash = bytes.fromhex('cd' * 32)
        salt = self.manager.job_key(4)
        # OffBalance.submitReveal: keccak256(abi.encode(keccak256(output), salt)) == commitmentHash
        expected = Web3.keccak(encode(['bytes32', 'bytes32'], [Web3.keccak(result_hash), salt]))
        self.assertEqual(self.manager.commitment(4, result_hash), expected)
        self.assertNotEqual(self.manager.commitment(5, result_hash), expected)

    def test_reveal_sends_the_committed_hash_once_and_nothing_without_a_commit(self):
        self.manager.reveal(4)
        self.contract.submitReveal.assert_not_called()
        result_hash = bytes.fromhex('cd' * 32)
        self.manager.commit(4, result_hash)
        self.contract.submitCommitment.assert_called_once()
        self.manager.reveal(4)
        self.contract.submitReveal.assert_called_once_with(4, result_hash, self.manager.job_key(4), self.creds.session, self.w3)
        self.manager.reveal(4)
        self.assertEqual(self.contract.submitReveal.call_count, 1, 'a second reveal event sends nothing')

    def test_stake_passes_the_amount_fixed_at_assignment(self):
        self.manager.stake(4, 6_000)
        self.contract.submitStake.assert_called_once_with(4, 6_000, self.creds.session, self.w3)


class EventFactoryTests(unittest.TestCase):
    def log(self, name, **args):
        return {'blockNumber': 3, 'event': name, 'args': {'jobId': 4, **args}}

    def test_every_subscribed_event_type_decodes(self):
        expected = {
            'PROVIDER_SELECTED': ProviderSelectedEvent, 'COMMIT_PHASE_START': CommitPhaseStartEvent,
            'REVEAL_PHASE_START': RevealPhaseStartEvent, 'DELIVERY_PHASE_START': DeliveryPhaseStartEvent,
            'DELIVERED': DeliveredEvent, 'CANCELED': CanceledEvent, 'NO_QUORUM': NoQuorumEvent,
        }
        self.assertEqual(set(expected), {t.value for t in BlockchainManager.event_types})
        for name, cls in expected.items():
            event = event_class_factory(self.log(name, provider=OWNER, stake=5, deadline=99))
            self.assertIsInstance(event, cls, name)
            self.assertEqual((event.jobId, event.block_number), (4, 3))

    def test_assignment_and_commit_events_carry_their_amounts(self):
        selected = event_class_factory(self.log('PROVIDER_SELECTED', provider=OWNER, stake=6_000))
        self.assertEqual((selected.provider_selected, selected.stake), (OWNER, 6_000))
        self.assertEqual(event_class_factory(self.log('PROVIDER_SELECTED', provider=OWNER)).stake, 0)
        self.assertEqual(event_class_factory(self.log('COMMIT_PHASE_START', deadline=1_234)).commit_deadline, 1_234)

    def test_an_event_the_client_doesnt_know_is_an_error(self):
        with self.assertRaises(ValueError):
            event_class_factory(self.log('JOB_SUBMITTED'))


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.blockchain = Mock()
        self.blockchain.owner = OWNER
        self.server = Mock()
        self.runner = Mock()
        self.runner.currentJobId = None
        self.client = ProviderClient(Mock(), self.blockchain, self.server, self.runner)

    @silenced
    def test_phase_events_reach_the_right_handler(self):
        self.client._handle_event(RevealPhaseStartEvent(1, BlockchainEvent.REVEAL_PHASE_START, 4))
        self.blockchain.reveal.assert_called_once_with(4)
        with patch.object(self.client, 'handleDeliveryPhaseStart') as deliver:
            self.client._handle_event(DeliveryPhaseStartEvent(1, BlockchainEvent.DELIVERY_PHASE_START, 4))
        deliver.assert_called_once_with(4)
        with patch.object(self.client, 'handleCommitPhaseStart') as commit:
            self.client._handle_event(CommitPhaseStartEvent(7, BlockchainEvent.COMMIT_PHASE_START, 4, 99))
        commit.assert_called_once_with(4, block_number=7, commit_deadline=99)

    @silenced
    def test_end_of_job_events_change_nothing(self):
        for event in (DeliveredEvent(1, BlockchainEvent.DELIVERED, 4), CanceledEvent(1, BlockchainEvent.CANCELED, 4),
                      NoQuorumEvent(1, BlockchainEvent.NO_QUORUM, 4)):
            self.client._handle_event(event)
        self.blockchain.stake.assert_not_called()
        self.blockchain.reveal.assert_not_called()
        self.server.report_error.assert_not_called()

    @silenced
    def test_an_unknown_event_object_is_an_error(self):
        with self.assertRaises(ValueError):
            self.client._handle_event(Event(1, BlockchainEvent.JOB_SUBMITTED, 4))

    @silenced
    def test_a_manifest_that_cant_be_fetched_is_reported_after_staking(self):
        self.server.getDockerManifest.side_effect = requests.HTTPError('403')
        self.client.handleAssignment(4, 6_000)
        self.blockchain.stake.assert_called_once_with(4, 6_000)
        self.assertIn('Job preparation failed', self.server.report_error.call_args[0][1])

    @silenced
    def test_an_unreadable_commit_deadline_skips_the_run_and_reports_it(self):
        self.runner.currentJobId = 4
        self.blockchain.seconds_until.side_effect = ConnectionError('rpc down')
        with patch('ProviderClient.threading.Thread') as thread:
            self.client.handleCommitPhaseStart(4, commit_deadline=1_234)
        thread.assert_not_called()
        self.assertEqual(self.server.report_error.call_args[0][1], 'Cannot read the commit deadline.')

    @silenced
    def test_commit_events_for_jobs_this_machine_isnt_running_are_ignored(self):
        self.runner.currentJobId = 5
        with patch('ProviderClient.threading.Thread') as thread:
            self.client.handleCommitPhaseStart(4, deadline=30)
        thread.assert_not_called()
        self.server.report_error.assert_not_called()

    def test_unexpected_delivery_errors_report_only_their_type(self):
        self.server.deliver_result.side_effect = RuntimeError('https://user:secret@host/ leaked')
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.client._deliverResult(4, Path('/tmp/out'), b'\x00' * 32)
        self.assertIn('RuntimeError', err.getvalue())
        self.assertNotIn('secret', err.getvalue())

    # The server gives a provider one job at a time, so this shouldn't happen. But nothing in the
    # client guards it: preparing job 5 replaces job 4's manifest, so when job 4's commit phase
    # starts the client ignores it, never commits, and its stake for job 4 is slashed.
    @unittest.expectedFailure
    @silenced
    def test_a_second_assignment_before_the_first_job_runs_doesnt_drop_the_first(self):
        runner = SimpleNamespace(currentJobId=None, currentManifest=None)

        def prepare(manifest, job_id):
            runner.currentJobId, runner.currentManifest = job_id, manifest
        runner.prepareJob = prepare
        self.client.runner = runner
        self.server.getDockerManifest.return_value = {'image': 'alpine', 'timeout_s': 30}
        self.client.handleAssignment(4, 1)
        self.client.handleAssignment(5, 1)
        with patch('ProviderClient.threading.Thread') as thread:
            self.client.handleCommitPhaseStart(4, deadline=30)
        thread.assert_called_once()


class ServerManagerTests(unittest.TestCase):
    def setUp(self):
        self.server = ServerManager('https://api.example/', 'token-1')

    def response(self, status, body=None, text=''):
        res = requests.Response()
        res.status_code = status
        res._content = (text or ('' if body is None else __import__('json').dumps(body))).encode()
        return res

    def test_the_token_goes_on_both_sessions_and_the_url_is_normalised(self):
        self.assertEqual(self.server.base_url, 'https://api.example')
        self.assertEqual(self.server.session.headers['Authorization'], 'Bearer token-1')
        self.assertEqual(self.server._heartbeat_session.headers['Authorization'], 'Bearer token-1')

    def test_a_rejected_benchmark_says_why(self):
        rejected = self.response(400, text='{"error":"cpu.threads must be positive"}')
        rejected.url = 'https://api.example/scores'
        with patch.object(self.server.session, 'request', return_value=rejected):
            with self.assertRaises(requests.HTTPError) as raised:
                self.server.post_benchmark(Mock(to_json=lambda: {}))
        self.assertIn('Failed to post benchmark', str(raised.exception))
        self.assertIn('cpu.threads must be positive', str(raised.exception))

    def test_hardware_address_is_none_on_404_and_errors_otherwise(self):
        missing = self.response(404)
        missing.url = 'https://api.example/provider/hardware'
        with patch.object(self.server.session, 'request', return_value=missing):
            self.assertIsNone(self.server.get_hardware_address())
        broken = self.response(500)
        broken.url = 'https://api.example/provider/hardware'
        with patch.object(self.server.session, 'request', return_value=broken):
            with self.assertRaises(requests.HTTPError):
                self.server.get_hardware_address()
        found = self.response(200, {'hardware': {'address': OWNER.lower()}})
        with patch.object(self.server.session, 'request', return_value=found):
            self.assertEqual(self.server.get_hardware_address(), OWNER.lower())

    def test_error_reports_use_their_own_session_with_the_same_credentials_and_are_capped(self):
        sent = {}

        def post(session, url, json, timeout):
            sent.update(url=url, json=json, auth=session.headers.get('Authorization'))
            return self.response(200, {})
        with patch.object(requests.Session, 'post', post):
            self.server.report_error(4, 'x' * 10_000)
        self.assertEqual(sent['url'], 'https://api.example/provider/jobs/4/error')
        self.assertEqual(sent['auth'], 'Bearer token-1')
        self.assertEqual(len(sent['json']['message']), 4096)

    def test_delivery_errors_say_whether_to_retry(self):
        self.assertTrue(DeliveryError(409, 'not open yet').retryable)
        self.assertTrue(DeliveryError(503, 'down').retryable)
        self.assertTrue(DeliveryError(None, 'network').retryable)
        self.assertFalse(DeliveryError(403, 'not assigned').retryable)
        self.assertFalse(DeliveryError(422, 'wrong hash').retryable)



class DevCredentialsTests(unittest.TestCase):
    # docker-compose.yml passes OFFBALANCE_API_KEY: ${OFFBALANCE_API_KEY:-}, so inside the container
    # it's set but empty when nobody configured a key. --dev then uses "" instead of the dev key and
    # stops with "the API key is empty", which breaks `docker compose run host-client --dev`.
    @unittest.expectedFailure
    def test_dev_mode_ignores_an_empty_api_key_variable(self):
        import main
        with patch.dict('os.environ', {'OFFBALANCE_API_KEY': ''}):
            creds = main.load_dev_credentials(2)
        self.assertEqual(creds.api_key, 'dev2')

    def test_dev_mode_uses_a_set_api_key_and_otherwise_the_dev_key(self):
        import main
        with patch.dict('os.environ', {'OFFBALANCE_API_KEY': 'custom-key'}):
            self.assertEqual(main.load_dev_credentials(2).api_key, 'custom-key')
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(main.load_dev_credentials(1).api_key, 'dev')
            self.assertEqual(main.load_dev_credentials(3).api_key, 'dev3')

if __name__ == '__main__':
    unittest.main()
