# Integration: the client's real chain layer (ProviderContractWrapper, BlockchainManager,
# Credentials, main.resolve_owner) against a real Hardhat node and the real compiled OffBalance.
# The test plays the buyer and the server (deploys, submits, assigns, advances phases); the client
# code does everything a provider does: decodes the events, stakes the amount from the event,
# commits, reveals, and reads its session key's owner.
#
# Needs Node with blockchain/ installed (`npm ci` in blockchain/). Skipped otherwise.
#   cd client && python -m unittest test.test_chain_integration -v      (or via discover)
from pathlib import Path
import contextlib
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import requests

from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from Credentials import Credentials, parse_session_key
from ProviderClient import ProviderClient
from job.JobResult import JobResult
from blockchain.BlockchainEvent import BlockchainEvent
from blockchain.BlockchainManager import BlockchainManager
from blockchain.Contract import ProviderContractWrapper
from blockchain.State import StateConflict
from blockchain.EventData import CommitPhaseStartEvent, ProviderSelectedEvent, RevealPhaseStartEvent
import main

ROOT = Path(__file__).resolve().parents[2]
BLOCKCHAIN = ROOT / 'blockchain'
ARTIFACT = BLOCKCHAIN / 'artifacts' / 'contracts' / 'OffBalance.sol' / 'OffBalance.json'
PRICE = Web3.to_wei(0.01, 'ether')
RESULT = bytes.fromhex('ab' * 32)


def dev_env():
    pairs = (line.strip().split('=', 1) for line in (ROOT / 'dev.env').read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))
    return {k: v.strip() for k, v in pairs}


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def node_available():
    return shutil.which('npx') is not None and (BLOCKCHAIN / 'node_modules').is_dir()


@unittest.skipUnless(node_available(), 'needs npx and blockchain/node_modules (npm ci in blockchain/)')
class ClientAgainstRealChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run(['npx', 'hardhat', 'compile', '--quiet'], cwd=BLOCKCHAIN, check=True, capture_output=True)
        port = free_port()
        cls.node = subprocess.Popen(['npx', 'hardhat', 'node', '--port', str(port)], cwd=BLOCKCHAIN,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        cls.w3 = Web3(Web3.HTTPProvider(f'http://127.0.0.1:{port}'))
        for _ in range(120):
            if cls.w3.is_connected():
                break
            time.sleep(0.5)
        else:
            cls.tearDownClass()
            raise RuntimeError('hardhat node did not start')
        env = dev_env()
        cls.server = Account.from_key(env['SERVER_PRIVATE_KEY'])
        cls.buyer = Account.from_key(env['BUYER_PRIVATE_KEY'])
        cls.p1 = Account.from_key(env['PROVIDER_1_PRIVATE_KEY'])
        cls.p2 = Account.from_key(env['PROVIDER_2_PRIVATE_KEY'])
        cls.artifact = json.loads(ARTIFACT.read_text())

    @classmethod
    def tearDownClass(cls):
        with contextlib.suppress(Exception):
            os.killpg(cls.node.pid, signal.SIGTERM)
            cls.node.wait(timeout=10)

    # a fresh contract per test, deployed by the server account
    def setUp(self):
        factory = self.w3.eth.contract(abi=self.artifact['abi'], bytecode=self.artifact['bytecode'])
        receipt = self.send(self.server, factory.constructor())
        self.contract = self.w3.eth.contract(address=receipt['contractAddress'], abi=self.artifact['abi'])
        self.wrapper = ProviderContractWrapper(self.contract)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state_dir = directory.name

    # ───────────── the test's own (buyer/server) transactions ─────────────

    def send(self, account, fn, value=0):
        tx = fn.build_transaction({'from': account.address, 'value': value,
                                   'nonce': self.w3.eth.get_transaction_count(account.address, 'pending')})
        receipt = self.w3.eth.wait_for_transaction_receipt(
            self.w3.eth.send_raw_transaction(account.sign_transaction(tx).raw_transaction))
        self.assertEqual(receipt['status'], 1, getattr(fn, 'fn_name', 'constructor'))
        return receipt

    def advance(self, seconds):
        self.w3.provider.make_request('evm_increaseTime', [seconds])
        self.w3.provider.make_request('evm_mine', [])

    def register_session_key(self, owner, session, funding=Web3.to_wei(1, 'ether'), lifetime=3600):
        expires_at = self.w3.eth.get_block('latest')['timestamp'] + lifetime
        digest = self.contract.functions.sessionKeyDigest(owner.address, session.address, expires_at).call()
        signature = Account.sign_message(encode_defunct(primitive=digest), session.key).signature
        self.send(owner, self.contract.functions.registerSessionKey(session.address, expires_at, signature), funding)

    def manager(self, session_key, owner, *, recover=False):
        wrapper = ProviderContractWrapper(self.contract)
        with contextlib.redirect_stdout(io.StringIO()):
            manager = BlockchainManager(
                self.w3, wrapper, Credentials('api', parse_session_key(session_key), owner=owner),
                state_dir=self.state_dir if recover else None,
            )
        self.addCleanup(manager.close)
        return manager

    def submitted_and_assigned(self, providers, k=2):
        receipt = self.send(self.buyer, self.contract.functions.submitJob(PRICE, k, len(providers), 10, 'img'), PRICE)
        job_id = self.contract.events.JOB_SUBMITTED().process_receipt(receipt)[0]['args']['jobId']
        self.send(self.server, self.contract.functions.assignProviders(job_id, [p.address for p in providers]))
        return job_id

    def events(self, manager, kind):
        with contextlib.redirect_stdout(io.StringIO()):
            return [e for e in manager.pollEvents() if isinstance(e, kind)]

    # ───────────── tests ─────────────

    def test_a_session_key_runs_a_whole_job_for_its_owner_who_alone_is_paid(self):
        session = Account.create()
        self.register_session_key(self.p1, session)
        with contextlib.redirect_stderr(io.StringIO()):  # it warns that a 1-hour key expires soon
            owner = main.resolve_owner(self.wrapper, self.w3, Credentials('api', parse_session_key(session.key.hex())), dev=False)
        self.assertEqual(owner, self.p1.address)

        m1 = self.manager(session.key.hex(), self.p1.address)    # signs with the session key for p1
        m2 = self.manager(self.p2.key.hex(), self.p2.address)    # p2 signs for itself (--dev style)
        job_id = self.submitted_and_assigned([self.p1, self.p2])

        # each client sees its own assignment, with the stake the contract fixed for it
        stakes = {}
        for manager, provider in ((m1, self.p1), (m2, self.p2)):
            selected = [e for e in self.events(manager, ProviderSelectedEvent) if e.provider_selected == provider.address]
            self.assertEqual(len(selected), 1)
            stakes[provider.address] = self.contract.functions.getProviderCommitment(job_id, provider.address).call()[4]
            self.assertEqual(selected[0].stake, stakes[provider.address])
            with contextlib.redirect_stdout(io.StringIO()):
                manager.stake(job_id, selected[0].stake)
        required = stakes[self.p1.address]
        self.assertEqual(self.contract.functions.lockedStake(self.p1.address).call(), required,
                         "the session key's stake is locked under the owner")

        self.send(self.server, self.contract.functions.finalizeProviderSelection(job_id))  # everyone staked
        commit = self.events(m1, CommitPhaseStartEvent)
        self.assertEqual(len(commit), 1)
        self.assertEqual(commit[0].commit_deadline, self.contract.functions.getDeadlines(job_id).call()[2])
        self.assertGreater(m1.seconds_until(commit[0].commit_deadline), 0)

        with contextlib.redirect_stdout(io.StringIO()):
            m1.commit(job_id, RESULT)
            m2.commit(job_id, RESULT)
        self.advance(11)
        self.send(self.server, self.contract.functions.startRevealPhase(job_id))
        self.assertEqual(len(self.events(m1, RevealPhaseStartEvent)), 1)
        with contextlib.redirect_stdout(io.StringIO()):
            m1.reveal(job_id)   # the contract recomputes the commitment from the client's reveal
            m2.reveal(job_id)
        self.advance(self.contract.functions.REVEAL_WINDOW().call() + 1)
        self.send(self.server, self.contract.functions.endRevealPhase(job_id))
        self.advance(self.contract.functions.DELIVERY_WINDOW().call() + 1)
        self.send(self.server, self.contract.functions.endDeliveryPhase(job_id))

        credits = self.contract.functions.credits
        self.assertEqual(credits(self.p1.address).call(), PRICE // 2 + required)
        self.assertEqual(credits(session.address).call(), 0, 'the session key never holds earnings')
        self.assertEqual(self.contract.functions.reputationOf(self.p1.address).call(), 1)

        # only the owner can withdraw
        before = self.w3.eth.get_balance(self.p1.address)
        receipt = self.send(self.p1, self.contract.functions.withdraw())
        gas = receipt['gasUsed'] * receipt['effectiveGasPrice']
        self.assertEqual(self.w3.eth.get_balance(self.p1.address) - before + gas, PRICE // 2 + required)
        with self.assertRaises(Exception):
            self.contract.functions.withdraw().call({'from': session.address})

    def test_the_contract_rejects_a_reveal_that_doesnt_match_the_commitment(self):
        m1 = self.manager(self.p1.key.hex(), self.p1.address)
        m2 = self.manager(self.p2.key.hex(), self.p2.address)
        job_id = self.submitted_and_assigned([self.p1, self.p2])
        for manager, provider in ((m1, self.p1), (m2, self.p2)):
            with contextlib.redirect_stdout(io.StringIO()):
                manager.stake(job_id, self.contract.functions.getProviderCommitment(job_id, provider.address).call()[4])
        self.send(self.server, self.contract.functions.finalizeProviderSelection(job_id))
        with contextlib.redirect_stdout(io.StringIO()):
            m1.commit(job_id, RESULT)
        self.advance(11)
        self.send(self.server, self.contract.functions.startRevealPhase(job_id))
        m1.committed_jobs[job_id] = bytes.fromhex('cd' * 32)  # try to reveal a different result
        with self.assertRaises(Exception) as raised, contextlib.redirect_stdout(io.StringIO()):
            m1.reveal(job_id)
        self.assertIn('Reveal does not match commitment', str(raised.exception))

    def test_staking_the_wrong_amount_is_rejected_before_anything_is_spent(self):
        m1 = self.manager(self.p1.key.hex(), self.p1.address)
        job_id = self.submitted_and_assigned([self.p1, self.p2])
        required = self.contract.functions.getProviderCommitment(job_id, self.p1.address).call()[4]
        before = self.w3.eth.get_balance(self.p1.address)
        with self.assertRaises(Exception) as raised, contextlib.redirect_stdout(io.StringIO()):
            m1.stake(job_id, required - 1)
        self.assertIn('Incorrect stake', str(raised.exception))
        self.assertEqual(self.w3.eth.get_balance(self.p1.address), before, 'nothing was sent')

    def test_resolve_owner_refuses_an_unregistered_or_expired_key(self):
        session = Account.create()
        creds = Credentials('api', parse_session_key(session.key.hex()))
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            main.resolve_owner(self.wrapper, self.w3, creds, dev=False)
        # --dev: a provider wallet may act for itself
        self.assertEqual(main.resolve_owner(self.wrapper, self.w3, creds, dev=True), session.address)

        self.register_session_key(self.p1, session, lifetime=60)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main.resolve_owner(self.wrapper, self.w3, creds, dev=False), self.p1.address)
        self.advance(61)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            main.resolve_owner(self.wrapper, self.w3, creds, dev=False)

    def test_an_underfunded_session_key_is_warned_about_at_startup(self):
        session = Account.create()
        self.register_session_key(self.p1, session, funding=1)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            main.resolve_owner(self.wrapper, self.w3, Credentials('api', parse_session_key(session.key.hex())), dev=False)
        self.assertIn('WARNING: session key has', err.getvalue())

    def test_the_client_subscribes_to_events_the_contract_actually_has(self):
        names = {item['name'] for item in self.artifact['abi'] if item['type'] == 'event'}
        for kind in BlockchainManager.event_types:
            self.assertIn(kind.value, names, f'{kind.value} is not an event of the deployed contract')
        self.assertIsInstance(BlockchainEvent.PROVIDER_SELECTED, BlockchainEvent)


    def test_a_client_restarted_after_committing_still_reveals(self):
        session = Account.create()
        self.register_session_key(self.p1, session)
        m1 = self.manager(session.key.hex(), self.p1.address, recover=True)
        m2 = self.manager(self.p2.key.hex(), self.p2.address)
        job_id = self.submitted_and_assigned([self.p1, self.p2])
        with contextlib.redirect_stdout(io.StringIO()):
            for manager, provider in ((m1, self.p1), (m2, self.p2)):
                manager.stake(job_id, self.contract.functions.getProviderCommitment(job_id, provider.address).call()[4])
            self.send(self.server, self.contract.functions.finalizeProviderSelection(job_id))
            m2.commit(job_id, RESULT)
            # The RPC mines the original transaction but loses its response.
            send_raw = self.w3.eth.send_raw_transaction

            def lose_response(raw):
                send_raw(raw)
                raise requests.ConnectionError('lost response')

            with patch.object(self.w3.eth, 'send_raw_transaction', side_effect=lose_response):
                with self.assertRaises(requests.ConnectionError):
                    m1.commit(job_id, RESULT)

        recorded = m1.state.snapshot()['transactions'][f'commit:{job_id}']
        self.assertEqual(recorded['status'], 'pending')
        nonce = self.w3.eth.get_transaction_count(session.address)
        m1.close()
        restarted = self.manager(session.key.hex(), self.p1.address, recover=True)
        self.advance(11)
        self.send(self.server, self.contract.functions.startRevealPhase(job_id))
        canonical_receipt = restarted.contract._canonical_receipt
        first_read = True

        def lagging_commit_receipt(w3, record):
            nonlocal first_read
            if first_read and record['hash'] == recorded['hash']:
                first_read = False
                return None
            return canonical_receipt(w3, record)

        with patch.object(restarted.contract, '_canonical_receipt', side_effect=lagging_commit_receipt):
            self.assertEqual(list(restarted.recovery_actions()), [(job_id, 'reveal', 0)])
        self.assertFalse(first_read)
        self.assertEqual(restarted.state.snapshot()['transactions'][f'commit:{job_id}']['hash'], recorded['hash'])
        self.assertEqual(self.w3.eth.get_transaction_count(session.address), nonce)
        with contextlib.redirect_stdout(io.StringIO()):
            restarted.reveal(job_id)
        revealed = self.contract.functions.getProviderCommitment(job_id, self.p1.address).call()[2]
        self.assertTrue(revealed, 'the restarted client revealed for the wallet that owns the session key')
        self.assertEqual(list(restarted.recovery_actions()), [], 'a repeated wake must not submit a duplicate reveal')
        self.assertEqual(self.w3.eth.get_transaction_count(session.address), nonce + 1)

    def test_a_client_restarted_after_staking_still_runs_its_assignment(self):
        m1 = self.manager(self.p1.key.hex(), self.p1.address, recover=True)
        m2 = self.manager(self.p2.key.hex(), self.p2.address)
        job_id = self.submitted_and_assigned([self.p1, self.p2])
        with contextlib.redirect_stdout(io.StringIO()):
            before = ProviderClient(Mock(), m1, Mock(), Mock())
            before._poll_events(threading.Event())
            for manager, provider in ((m1, self.p1), (m2, self.p2)):
                manager.stake(job_id, self.contract.functions.getProviderCommitment(job_id, provider.address).call()[4])
        self.assertIn('assignment', m1.state.job(job_id))
        nonce = self.w3.eth.get_transaction_count(self.p1.address)
        m1.close()
        self.send(self.server, self.contract.functions.finalizeProviderSelection(job_id))

        restarted = self.manager(self.p1.key.hex(), self.p1.address, recover=True)
        # The original assignment block was already acknowledged. Recovery uses the
        # saved job and the current contract phase even when the event is absent.
        self.assertEqual(self.events(restarted, ProviderSelectedEvent), [])
        runner = Mock()
        runner.startJob.return_value = JobResult('ok', output_dir=Path('output'))
        runner.hash_dir.return_value = RESULT
        server = Mock()
        manifest = {'image': 'fixture', 'command': ['run']}
        server.getDockerManifest.return_value = manifest
        client = ProviderClient(Mock(), restarted, server, runner)
        client._stop_event = threading.Event()
        client._resume_jobs()
        end = time.monotonic() + 5
        while client._workers and time.monotonic() < end:
            time.sleep(0.01)
        self.assertFalse(client._workers, 'recovery worker completed')
        runner.prepareJob.assert_called_once_with(manifest, job_id)
        runner.startJob.assert_called_once()
        self.assertEqual(self.contract.functions.getProviderCommitment(job_id, self.p1.address).call()[0],
                         restarted.commitment(job_id, RESULT))
        self.assertEqual(self.w3.eth.get_transaction_count(self.p1.address), nonce + 1, 'no duplicate stake')
        client._resume_jobs()
        runner.startJob.assert_called_once()

    def test_orphaned_assignment_does_not_replay_pending_stake_for_reused_id(self):
        fork = self.w3.provider.make_request('evm_snapshot', [])['result']
        manager = self.manager(self.p1.key.hex(), self.p1.address, recover=True)
        job_id = self.submitted_and_assigned([self.p1], k=1)
        stake = self.contract.functions.getProviderCommitment(job_id, self.p1.address).call()[4]
        with patch.object(self.w3.eth, 'send_raw_transaction', side_effect=requests.ConnectionError):
            with self.assertRaises(requests.ConnectionError):
                manager.stake(job_id, stake)
        self.assertEqual(manager.state.snapshot()['transactions'][f'stake:{job_id}']['status'], 'pending')
        self.assertTrue(self.w3.provider.make_request('evm_revert', [fork])['result'])
        self.advance(10)
        self.assertEqual(self.submitted_and_assigned([self.p1], k=1), job_id)
        with patch.object(self.w3.eth, 'send_raw_transaction') as broadcast:
            with self.assertRaisesRegex(StateConflict, f'Job {job_id} assignment'):
                list(manager.recovery_actions())
            broadcast.assert_not_called()


if __name__ == '__main__':
    unittest.main()
