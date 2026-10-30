"""Crash boundaries use real journal files and a deterministic fake Ethereum RPC."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import requests
from docker.errors import NotFound, ImageNotFound
from web3 import Web3
from web3.exceptions import TimeExhausted, TransactionNotFound

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blockchain.BlockchainManager import BlockchainManager
from blockchain.Contract import ProviderContractWrapper, TransactionReverted, TransactionRetry
from blockchain.State import ProviderState, StateConflict, ExecutionPaused
from ProviderClient import ProviderClient
from job.RunManager import RunManager

ADDRESS = '0x' + '12' * 20
CONTRACT = '0x' + '34' * 20
SEED = b's' * 32
RESULT = b'r' * 32


class Signer:
    address = ADDRESS

    def __init__(self):
        self.signed = []

    def sign_transaction(self, transaction):
        raw = json.dumps(transaction, sort_keys=True).encode()
        self.signed.append(raw)
        return SimpleNamespace(raw_transaction=raw, hash=Web3.keccak(raw))


class FakeEth:
    chain_id = 31337
    block_number = 2

    def __init__(self):
        self.blocks = {i: dict(hash=Web3.keccak(text=f'block-{i}'), timestamp=100 + i) for i in range(3)}
        self.receipts, self.commitments, self.logs = {}, {}, []
        self.nonce, self.broadcasts = 0, []
        self.before_send, self.after_send = None, None
        self.next_status = 1
        self.phase = 2

    def get_block(self, number):
        return self.blocks[self.block_number if number == 'latest' else number]

    def get_transaction_count(self, address, kind):
        return self.nonce

    def get_transaction_receipt(self, tx_hash):
        key = tx_hash if isinstance(tx_hash, str) else '0x' + bytes(tx_hash).hex()
        if key not in self.receipts:
            raise TransactionNotFound(key)
        return self.receipts[key]

    def wait_for_transaction_receipt(self, tx_hash, **kwargs):
        try:
            return self.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            raise TimeExhausted('still pending') from None

    def send_raw_transaction(self, raw):
        if self.before_send:
            self.before_send(raw)
        self.broadcasts.append(raw)
        tx = json.loads(raw)
        tx_hash = '0x' + bytes(Web3.keccak(raw)).hex()
        if tx['nonce'] < self.nonce:
            raise ValueError('nonce too low')
        if tx['nonce'] != self.nonce:
            raise AssertionError('unexpected nonce gap')
        status, self.next_status = self.next_status, 1
        self.nonce += 1
        job = tx['args'][0]
        if status and tx['method'] == 'commit' and job in self.commitments:
            status = 0
        if status:
            if tx['method'] == 'commit':
                self.commitments[job] = [bytes.fromhex(tx['args'][1]), bytes(32), False, False, False, 1]
            elif tx['method'] == 'reveal':
                record = self.commitments[job]
                record[1], record[2] = Web3.keccak(bytes.fromhex(tx['args'][1])), True
        self.receipts[tx_hash] = dict(status=status, blockNumber=self.block_number,
                                     blockHash=self.blocks[self.block_number]['hash'])
        if self.after_send:
            self.after_send(raw)
        return Web3.keccak(raw)


class FakeFunctions:
    def __init__(self, eth):
        self.eth = eth

    def stakeFor(self, address):
        return SimpleNamespace(call=lambda: 1)

    def getDeadlines(self, job):
        return SimpleNamespace(call=lambda: (self.eth.phase, 200, 300, 400))

    def getAssignedProviders(self, job):
        return SimpleNamespace(call=lambda: [ADDRESS])

    def getProviderCommitment(self, job, address):
        return SimpleNamespace(call=lambda: self.eth.commitments.get(job, (bytes(32), bytes(32), False, False, False, 0)))

    def _function(self, method, args):
        encoded = [arg.hex() if isinstance(arg, bytes) else arg for arg in args]
        return SimpleNamespace(build_transaction=lambda fields: dict(fields, method=method, args=encoded))

    def submitCommitment(self, *args):
        return self._function('commit', args)

    def submitReveal(self, *args):
        return self._function('reveal', args)


class FakeEvents:
    def __init__(self, eth):
        self.eth = eth

    def __getattr__(self, name):
        def get_logs(from_block, to_block):
            return [log for log in self.eth.logs if log['event'] == name and from_block <= log['blockNumber'] <= to_block]
        return lambda: SimpleNamespace(get_logs=get_logs)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.eth, self.signer = FakeEth(), Signer()
        self.w3 = SimpleNamespace(eth=self.eth)
        self.manager = None
        self.restart()
        self.addCleanup(lambda: self.manager.close())

    def restart(self):
        if self.manager:
            self.manager.close()
        contract = SimpleNamespace(address=CONTRACT, functions=FakeFunctions(self.eth), events=FakeEvents(self.eth))
        self.wrapper = ProviderContractWrapper(contract)
        self.manager = BlockchainManager(self.w3, self.wrapper, self.signer, SEED, self.temp.name)

    def assign(self, job=7):
        self.manager.remember_assignment(job, {'image': 'pinned', 'command': ['job']})
        self.manager.request_execution(job)

    def test_journal_is_private_locked_namespaced_and_seed_checked(self):
        path = self.manager.state.path
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(StateConflict):
            ProviderState(self.manager.state.identity, SEED, self.temp.name)
        self.assign()
        self.restart()
        self.assertTrue(self.manager.state.job(7)['execution_requested'])
        self.manager.close()
        with self.assertRaises(StateConflict):
            ProviderState(self.manager.state.identity, b'different seed', self.temp.name)
        other = dict(self.manager.state.identity, chain_id=1)
        state = ProviderState(other, SEED, self.temp.name)
        self.addCleanup(state.close)
        self.assertNotEqual(state.path, path)
        self.assertEqual(state.snapshot()['jobs'], {})

    def test_same_signer_cannot_run_two_contract_clients_on_one_chain(self):
        other = dict(self.manager.state.identity, contract='0x' + '56' * 20)
        with self.assertRaises(StateConflict):
            ProviderState(other, SEED, self.temp.name)

    def test_chain_reset_gets_fresh_job_journal_and_old_process_fails_closed(self):
        self.assign()
        self.manager.commit(7, RESULT)
        old_directory = self.manager.state.directory
        self.eth.blocks[0]['hash'] = Web3.keccak(text='fresh dev chain genesis')
        self.eth.commitments.clear()
        self.eth.receipts.clear()
        self.eth.nonce = 0
        with self.assertRaises(StateConflict):
            self.manager.pollEvents()
        with self.assertRaises(StateConflict):
            self.manager.commit(7, RESULT)
        self.assertEqual(len(self.eth.broadcasts), 1)
        self.restart()
        self.assertNotEqual(self.manager.state.directory, old_directory)
        self.assertEqual(self.manager.state.snapshot()['jobs'], {})
        self.assertEqual(self.manager.state.snapshot()['transactions'], {})

    def runner_fixture(self):
        docker = Mock()
        docker.info.return_value = {'SecurityOptions': [], 'ID': 'stable-daemon'}
        with patch('job.RunManager.docker.from_env', return_value=docker):
            runner = RunManager()
        runner.state = self.manager.state
        runner.jobs_dir = runner.state.directory / 'jobs'
        container = Mock()
        container.attrs = dict(Config=dict(Labels=runner._labels(7)), State=dict(OOMKilled=False))
        container.wait.return_value = {'StatusCode': 0}
        docker.containers.get.side_effect = NotFound('not present')
        docker.containers.run.return_value = container
        return runner, docker, container

    def test_mediator_retries_ambiguous_create_without_marking_execution_failed(self):
        self.assign()
        runner, docker, container = self.runner_fixture()
        docker.containers.run.side_effect = requests.ConnectionError('created but response lost')
        client = ProviderClient(Mock(), self.manager, Mock(), runner)
        client._recover_job(7, 'execute', 60)
        self.assertFalse(self.manager.state.job(7).get('execution_failed', False))
        self.assertEqual(self.manager.recovery_actions(), [(7, 'execute', 98)])
        docker.containers.get.side_effect = None
        docker.containers.get.return_value = container
        client._recover_job(7, 'execute', 59)
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(docker.containers.run.call_count, 1)
        self.assertTrue(self.manager.state.job(7)['committed'])

    def test_stop_during_execution_pauses_promptly_and_reconnects(self):
        self.assign()
        runner, docker, container = self.runner_fixture()
        started = threading.Event()
        def wait(**kwargs):
            self.assertLessEqual(kwargs['timeout'], 1)
            started.set()
            time.sleep(0.05)
            raise requests.ReadTimeout('long-poll not complete')
        container.wait.side_effect = wait
        stop = threading.Event()
        client = ProviderClient(Mock(), self.manager, Mock(), runner)
        failures = []
        def run():
            try:
                client.run(stop)
            except BaseException as error:
                failures.append(error)
        driver = threading.Thread(target=run)
        driver.start()
        try:
            self.assertTrue(started.wait(2))
            begin = time.monotonic()
            stop.set()
            driver.join(2)
            self.assertFalse(driver.is_alive(), 'graceful stop waited for the full job deadline')
            self.assertLess(time.monotonic() - begin, 2)
            self.assertEqual(failures, [])
            container.remove.assert_not_called()
            self.assertFalse(self.manager.state.job(7).get('execution_failed', False))
            self.assertEqual(self.manager.state.job(7)['execution']['status'], 'running')
            self.assertEqual(self.manager.recovery_actions(), [(7, 'execute', 98)])
            runner.stop_event = threading.Event()
            container.wait.side_effect = None
            docker.containers.get.side_effect = None
            docker.containers.get.return_value = container
            resumed = ProviderClient(Mock(), self.manager, Mock(), runner)
            resumed._recover_job(7, 'execute', 59)
            self.assertEqual(docker.containers.run.call_count, 1)
            self.assertTrue(self.manager.state.job(7)['committed'])
        finally:
            stop.set()
            driver.join(2)

    def test_post_replace_fsync_failure_poisoning_preserves_disk_record(self):
        real_fsync = os.fsync
        count = 0
        def fsync(descriptor):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('directory fsync failed after replace')
            return real_fsync(descriptor)
        with patch('blockchain.State.os.fsync', side_effect=fsync):
            with self.assertRaises(OSError):
                self.manager.state.save_job(7, result=RESULT.hex())
        with self.assertRaises(StateConflict):
            self.manager.state.save_job(8, assigned=True)
        with self.assertRaises(StateConflict):
            self.manager.state.snapshot()
        self.restart()
        self.assertEqual(self.manager.state.job(7)['result'], RESULT.hex())

    def log(self, event, job, block, index, **args):
        return dict(event=event, args=dict(jobId=job, **args), blockNumber=block,
                    transactionIndex=0, logIndex=index)

    def test_ordered_replay_and_explicit_acknowledgment_survive_restart(self):
        self.eth.logs = [self.log('PROVIDER_SELECTED', 7, 1, 0, provider=ADDRESS),
                         self.log('COMMIT_PHASE_START', 7, 1, 1, deadline=100),
                         self.log('PROVIDER_SELECTED', 8, 2, 0, provider=ADDRESS),
                         self.log('COMMIT_PHASE_START', 8, 2, 1, deadline=100)]
        events = self.manager.pollEvents()
        self.assertEqual([event.jobId for event in events], [7, 7, 8, 8])
        self.assertEqual(self.manager.next_block_to_scan, 0)
        server = Mock()
        server.getDockerManifest.return_value = {'image': 'pinned', 'command': ['job']}
        client = ProviderClient(Mock(), self.manager, server, Mock())
        for event in events[:2]:
            client._handle_event(event)
        self.restart()  # stopped before the entire batch was acknowledged
        self.assertEqual(len(self.manager.pollEvents()), 4)
        client.blockchain = self.manager
        for event in self.manager.pollEvents():
            client._handle_event(event)
        self.manager.acknowledgeEvents()
        self.restart()
        self.assertEqual(self.manager.pollEvents(), [])
        self.assertEqual(self.manager.recovery_actions(), [(7, 'execute', 98), (8, 'execute', 98)])

    def test_unassigned_broadcast_never_creates_execution_work(self):
        self.manager.request_execution(99)
        self.assertEqual(self.manager.state.snapshot()['jobs'], {})

    def test_committed_result_survives_restart_and_skips_execution(self):
        self.assign()
        self.manager.commit(7, RESULT)
        self.restart()
        self.assertEqual(self.manager.recovery_actions(), [])
        self.eth.phase = 3
        self.assertEqual(self.manager.recovery_actions(), [(7, 'reveal', 0)])
        self.manager.reveal(7)
        self.restart()
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertTrue(self.manager.state.job(7)['revealed'])
        self.assertEqual(self.manager.state.job(7)['result'], RESULT.hex())
        self.assertEqual(len(self.signer.signed), 2)

    def test_result_and_signed_transaction_are_durable_before_broadcast(self):
        self.assign()
        def check_and_fail(raw):
            disk = json.loads(self.manager.state.path.read_text())
            self.assertEqual(disk['jobs']['7']['result'], RESULT.hex())
            self.assertIn('salt', disk['jobs']['7'])
            self.assertEqual(bytes.fromhex(disk['transactions']['commit:7']['raw'][2:]), raw)
            raise requests.ConnectionError('process lost RPC before broadcast')
        self.eth.before_send = check_and_fail
        with self.assertRaises(requests.ConnectionError):
            self.manager.commit(7, RESULT)
        raw = self.signer.signed[0]
        self.restart()
        self.eth.before_send = None
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(self.eth.broadcasts, [raw])
        self.assertEqual(len(self.signer.signed), 1)

    def test_lost_broadcast_response_is_reconciled_without_new_nonce(self):
        self.assign()
        self.eth.after_send = Mock(side_effect=requests.ConnectionError('response lost after mining'))
        with self.assertRaises(requests.ConnectionError):
            self.manager.commit(7, RESULT)
        self.restart()
        self.eth.after_send = None
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(len(self.eth.broadcasts), 1)
        self.assertEqual(len(self.signer.signed), 1)

    def test_failed_reveal_keeps_opening_and_retries_identical_signed_bytes(self):
        self.assign()
        self.manager.commit(7, RESULT)
        self.eth.phase = 3
        self.eth.before_send = Mock(side_effect=requests.Timeout('temporary RPC failure'))
        with self.assertRaises(requests.Timeout):
            self.manager.reveal(7)
        self.assertFalse(self.manager.state.job(7).get('revealed', False))
        reveal_raw = self.signer.signed[-1]
        self.restart()
        self.eth.before_send = None
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(self.eth.broadcasts[-1], reveal_raw)
        self.assertEqual(len(self.signer.signed), 2)
        self.assertTrue(self.manager.state.job(7)['revealed'])

    def test_unmined_transaction_keeps_same_nonce_and_bytes_across_restart(self):
        self.assign()
        with patch.object(self.eth, 'send_raw_transaction', return_value=Web3.keccak(text='accepted')):
            with self.assertRaises(TransactionRetry):
                self.manager.commit(7, RESULT)
        record = self.manager.state.snapshot()['transactions']['commit:7']
        self.assertEqual(record['status'], 'pending')
        self.restart()
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(self.eth.broadcasts, self.signer.signed)
        self.assertEqual(len(self.signer.signed), 1)

    def test_handler_failure_leaves_batch_unacknowledged_for_retry(self):
        self.eth.logs = [self.log('PROVIDER_SELECTED', 7, 1, 0, provider=ADDRESS)]
        event = self.manager.pollEvents()[0]
        server = Mock()
        server.getDockerManifest.side_effect = requests.ConnectionError('server unavailable')
        client = ProviderClient(Mock(), self.manager, server, Mock())
        with self.assertRaises(requests.ConnectionError):
            client._handle_event(event)
        self.restart()
        self.assertEqual(self.manager.next_block_to_scan, 0)
        self.assertEqual(len(self.manager.pollEvents()), 1)

    def test_batch_reorganized_before_ack_is_retried(self):
        self.manager.pollEvents()
        self.eth.blocks[2]['hash'] = Web3.keccak(text='reorganized before ack')
        with self.assertRaises(TransactionRetry):
            self.manager.acknowledgeEvents()
        self.assertEqual(self.manager.next_block_to_scan, 0)

    def test_expired_execution_is_cleaned_even_after_job_settles(self):
        self.assign()
        self.manager.state.save_job(7, execution=dict(container='managed', status='running', cleaned=False))
        self.eth.phase = 7
        self.assertEqual(self.manager.recovery_actions(), [(7, 'cleanup', 0)])
        self.manager.state.save_job(7, execution=dict(container='managed', status='failed', cleaned=True))
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertTrue(self.manager.state.job(7)['terminal'])

    def test_reverted_receipt_is_not_success_and_retries_with_next_nonce(self):
        self.assign()
        self.eth.next_status = 0
        with self.assertRaises(TransactionReverted):
            self.manager.commit(7, RESULT)
        self.assertFalse(self.manager.state.job(7).get('committed', False))
        self.assertEqual(self.manager.state.snapshot()['transactions']['commit:7']['status'], 'reverted')
        self.restart()
        self.assertEqual(self.manager.recovery_actions(), [(7, 'commit', 0)])
        self.manager.commit(7, RESULT)
        self.assertEqual([json.loads(raw)['nonce'] for raw in self.signer.signed], [0, 1])

    def test_reorg_preserves_failed_attempt_bytes_needed_to_fill_nonce_gap(self):
        self.assign()
        self.eth.next_status = 0
        with self.assertRaises(TransactionReverted):
            self.manager.commit(7, RESULT)
        self.manager.commit(7, RESULT)
        original = list(self.signer.signed)
        self.assertIn('commit:7@0', self.manager.state.snapshot()['transactions'])
        # Both attempts' receipts disappear; the originally reverted nonce can now succeed.
        self.eth.receipts.clear()
        self.eth.commitments.clear()
        self.eth.nonce = 0
        self.restart()
        with self.assertRaises(TransactionReverted):
            self.manager.recovery_actions()  # nonce 0 succeeds; nonce 1 is now a duplicate commit
        self.assertEqual(self.manager.recovery_actions(), [])
        self.assertEqual(self.eth.broadcasts[-2:], original)
        self.assertEqual(len(self.signer.signed), 2)
        self.assertEqual(self.eth.nonce, 2)

    def test_other_sender_consuming_reserved_nonce_fails_closed(self):
        self.eth.before_send = Mock(side_effect=requests.Timeout())
        with self.assertRaises(requests.Timeout):
            self.manager.commit(7, RESULT)
        self.eth.nonce = 1  # another wallet process submitted a different transaction
        self.eth.before_send = None
        with self.assertRaises(StateConflict):
            self.manager.commit(8, RESULT)
        self.assertEqual(len(self.signer.signed), 1)

    def test_concurrent_jobs_serialize_transaction_nonces(self):
        failures = []
        def commit(job):
            try:
                self.manager.commit(job, RESULT)
            except BaseException as error:
                failures.append(error)
        workers = [threading.Thread(target=commit, args=(job,)) for job in (7, 8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(failures, [])
        self.assertEqual([json.loads(raw)['nonce'] for raw in self.signer.signed], [0, 1])

    def test_reorg_rewinds_cursor_and_rebroadcasts_orphaned_commit_without_execution(self):
        self.assign()
        self.manager.pollEvents()
        self.manager.acknowledgeEvents()
        self.manager.commit(7, RESULT)
        original = self.signer.signed[0]
        self.eth.blocks[2]['hash'] = Web3.keccak(text='replacement block')
        self.eth.commitments.clear()
        self.eth.nonce = 0
        self.assertEqual(self.manager.next_block_to_scan, 3)
        self.manager.pollEvents()
        self.assertEqual(self.manager.next_block_to_scan, 0)
        self.assertEqual(self.manager.recovery_actions(), [])  # outbox already restored the commitment
        self.manager.commit(7, RESULT)
        self.assertEqual(self.eth.broadcasts, [original, original])
        self.assertEqual(len(self.signer.signed), 1)


class ContainerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = ProviderState(dict(chain_id=1, contract=CONTRACT, signer=ADDRESS), SEED, self.temp.name)
        self.addCleanup(self.state.close)
        self.docker = Mock()
        self.docker.info.return_value = {'SecurityOptions': [], 'ID': 'stable-daemon'}
        with patch('job.RunManager.docker.from_env', return_value=self.docker):
            self.runner = RunManager()
        self.runner.state = self.state
        self.runner.jobs_dir = self.state.directory / 'jobs'
        self.runner.prepareJob({'image': 'pinned', 'command': ['job']}, 7)
        self.name = f'offbalance-{self.state.directory.name[:24]}-7'
        self.container = Mock()
        self.container.attrs = dict(Config=dict(Labels=self.runner._labels(7)), State=dict(OOMKilled=False))
        self.container.wait.return_value = {'StatusCode': 0}
        self.docker.containers.run.return_value = self.container
        self.docker.containers.get.side_effect = NotFound('no container')

    def test_reconnects_to_surviving_container_without_rerun_or_clearing_output(self):
        output = self.runner.out_dir / 'result.txt'
        output.write_text('existing partial output')
        self.state.save_job(7, execution=dict(container=self.name, expires=time.time() + 30, status='running', cleaned=False))
        self.docker.containers.get.side_effect = None
        self.docker.containers.get.return_value = self.container
        result = self.runner.startJob(7, 60)
        self.assertEqual(result.status, 'ok')
        self.assertEqual(output.read_text(), 'existing partial output')
        self.docker.containers.run.assert_not_called()
        self.assertLessEqual(self.container.wait.call_args.kwargs['timeout'], 30)
        self.assertEqual(self.state.job(7)['execution']['status'], 'ready')
        self.container.remove.assert_called_once_with(force=True)

    def test_completed_output_is_reused_after_crash_before_hashing(self):
        def finish(**kwargs):
            (self.runner.out_dir / 'result.txt').write_text('finished output')
            return {'StatusCode': 0}
        self.container.wait.side_effect = finish
        self.runner.startJob(7, 60)
        digest = self.runner.hash_dir(self.runner.out_dir)
        self.runner.startJob(7, 60)
        self.assertEqual(self.runner.hash_dir(self.runner.out_dir), digest)
        self.docker.containers.run.assert_called_once()
        self.assertEqual(self.docker.containers.run.call_args.kwargs['name'], self.name)

    def test_expired_surviving_container_is_removed_without_rerun(self):
        self.state.save_job(7, execution=dict(container=self.name, expires=time.time() - 1, status='running', cleaned=False))
        self.docker.containers.get.side_effect = None
        self.docker.containers.get.return_value = self.container
        self.assertEqual(self.runner.startJob(7, 60).status, 'timeout')
        self.container.wait.assert_not_called()
        self.container.remove.assert_called_once_with(force=True)
        self.docker.containers.run.assert_not_called()

    def test_transient_wait_disconnect_preserves_container_for_reconnect(self):
        self.docker.containers.get.side_effect = None
        self.docker.containers.get.return_value = self.container
        self.state.save_job(7, execution=dict(container=self.name, expires=time.time() + 30, status='running', cleaned=False))
        self.container.wait.side_effect = requests.ConnectionError('daemon transport disconnected')
        with self.assertRaises(ExecutionPaused):
            self.runner.startJob(7, 60)
        self.container.remove.assert_not_called()
        self.assertEqual(self.state.job(7)['execution']['status'], 'running')
        self.assertFalse(self.state.job(7)['execution']['cleaned'])
        self.container.wait.side_effect = None
        self.assertEqual(self.runner.startJob(7, 30).status, 'ok')
        self.docker.containers.run.assert_not_called()

    def test_stop_during_image_pull_does_not_wait_for_download_or_start_container(self):
        self.docker.images.get.side_effect = ImageNotFound('missing')
        started, release, completed = threading.Event(), threading.Event(), threading.Event()
        def pull(image):
            started.set()
            release.wait(2)
            completed.set()
        self.docker.images.pull.side_effect = pull
        failures = []
        def start():
            try:
                self.runner.startJob(7, 60)
            except ExecutionPaused:
                pass
            except BaseException as error:
                failures.append(error)
        worker = threading.Thread(target=start)
        worker.start()
        try:
            self.assertTrue(started.wait(2))
            self.runner.stop_event.set()
            worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])
            self.docker.containers.run.assert_not_called()
            self.assertEqual(self.state.job(7)['execution']['status'], 'running')
        finally:
            release.set()
            worker.join(2)
            self.assertTrue(completed.wait(2))

    def test_output_hashing_stops_without_losing_completed_output(self):
        output = self.runner.out_dir / 'result.txt'
        output.write_text('completed')
        stop = threading.Event()
        stop.set()
        with self.assertRaises(ExecutionPaused):
            self.runner.hash_dir(self.runner.out_dir, stop)
        self.assertEqual(output.read_text(), 'completed')

    def test_changed_daemon_cannot_rerun_a_possibly_live_job(self):
        self.state.update(lambda data: data.update(docker_daemon='original-daemon'))
        with self.assertRaises(StateConflict):
            self.runner.startJob(7, 60)
        self.docker.containers.get.assert_not_called()
        self.docker.containers.run.assert_not_called()

    def test_unknown_container_with_colliding_name_is_not_removed(self):
        self.container.attrs['Config']['Labels'] = {}
        self.docker.containers.get.side_effect = None
        self.docker.containers.get.return_value = self.container
        with self.assertRaises(StateConflict):
            self.runner.startJob(7, 60)
        self.container.remove.assert_not_called()
        self.docker.containers.run.assert_not_called()

    def test_lost_docker_create_response_reconnects_on_restart(self):
        def create(**kwargs):
            disk = json.loads(self.state.path.read_text())
            self.assertEqual(disk['jobs']['7']['execution']['container'], self.name)
            raise requests.ConnectionError('Docker created container but response was lost')
        self.docker.containers.run.side_effect = lambda *args, **kwargs: create(**kwargs)
        with self.assertRaises(ExecutionPaused):
            self.runner.startJob(7, 60)
        self.assertFalse(self.state.job(7)['execution']['cleaned'])
        self.docker.containers.get.side_effect = None
        self.docker.containers.get.return_value = self.container
        self.assertEqual(self.runner.startJob(7, 60).status, 'ok')
        self.assertEqual(self.docker.containers.run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
