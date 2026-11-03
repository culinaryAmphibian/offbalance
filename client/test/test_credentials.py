from pathlib import Path
import contextlib
import io
import os
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from Credentials import Credentials, parse_api_key, parse_session_key, prompt_credentials
from ProviderClient import ProviderClient, WalletMismatch
from blockchain.EventData import ProviderSelectedEvent
from blockchain.BlockchainEvent import BlockchainEvent
import main

KEY = '0x' + '11' * 32
OTHER_KEY = '0x' + '22' * 32
OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'


class CredentialParsingTests(unittest.TestCase):
    def test_session_key_accepts_hex_with_or_without_prefix(self):
        self.assertEqual(parse_session_key(KEY).address, parse_session_key(KEY[2:] + '\n').address)

    def test_bad_inputs_are_rejected(self):
        for bad in ('', 'xyz', '0x1234', KEY + '00'):
            with self.assertRaises(ValueError):
                parse_session_key(bad)
        for bad in ('', '   ', 'two words'):
            with self.assertRaises(ValueError):
                parse_api_key(bad)

    def test_key_seed_is_deterministic_per_session_key_and_secret(self):
        a = Credentials('k', parse_session_key(KEY))
        self.assertEqual(a.key_seed, Credentials('other', parse_session_key(KEY)).key_seed)
        self.assertNotEqual(a.key_seed, Credentials('k', parse_session_key(OTHER_KEY)).key_seed)
        self.assertEqual(len(a.key_seed), 32)
        self.assertNotIn(KEY[2:], a.key_seed.hex())
        self.assertNotIn('11' * 32, repr(a))

    def test_prompt_reprompts_on_bad_input(self):
        answers = iter(['', 'api-key'])
        keys = iter(['nope', KEY])
        with patch.dict(os.environ, {}, clear=True), \
                patch('builtins.input', lambda _: next(answers)), \
                patch('Credentials.getpass', lambda _: next(keys)), \
                contextlib.redirect_stderr(io.StringIO()):
            creds = prompt_credentials()
        self.assertEqual(creds.api_key, 'api-key')
        self.assertEqual(creds.session.address, parse_session_key(KEY).address)
        self.assertIsNone(creds.owner)

    def test_env_vars_skip_the_prompts(self):
        with patch.dict(os.environ, {'OFFBALANCE_API_KEY': 'env-key', 'OFFBALANCE_SESSION_KEY': KEY}, clear=True), \
                patch('builtins.input', side_effect=AssertionError('prompted')), \
                patch('Credentials.getpass', side_effect=AssertionError('prompted')):
            creds = prompt_credentials()
        self.assertEqual(creds.api_key, 'env-key')


class OwnerResolutionTests(unittest.TestCase):
    def setUp(self):
        self.creds = Credentials('k', parse_session_key(KEY))
        self.contract = Mock()
        self.w3 = Mock()
        self.w3.eth.get_balance.return_value = 10 ** 18
        self.contract.stakeFor.return_value = 6 * 10 ** 15
        self.contract.sessionKeyInfo.return_value = (OWNER, 2 ** 40)

    def test_unregistered_session_key_exits_with_instructions(self):
        self.contract.providerOf.return_value = self.creds.session_address
        with self.assertRaises(SystemExit) as raised:
            main.resolve_owner(self.contract, self.w3, self.creds, dev=False)
        self.assertIn('Authorize provider client', str(raised.exception.code))

    def test_dev_wallet_may_act_for_itself(self):
        self.contract.providerOf.return_value = self.creds.session_address
        self.assertEqual(main.resolve_owner(self.contract, self.w3, self.creds, dev=True), self.creds.session_address)

    def test_registered_key_resolves_to_owner_and_warns_when_underfunded(self):
        self.contract.providerOf.return_value = OWNER
        self.w3.eth.get_balance.return_value = 0
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(main.resolve_owner(self.contract, self.w3, self.creds, dev=False), OWNER)
        self.assertIn('Authorize a new key with more funding', err.getvalue())


class AssignmentTests(unittest.TestCase):
    def setUp(self):
        self.blockchain = Mock()
        self.blockchain.owner = OWNER
        self.server = Mock()
        self.runner = Mock()
        self.creds = Credentials('k', parse_session_key(KEY), owner=OWNER)
        self.client = ProviderClient(Mock(), self.blockchain, self.server, self.runner, credentials=self.creds)

    def selected(self, provider):
        return ProviderSelectedEvent(1, BlockchainEvent.PROVIDER_SELECTED, 7, provider, 123)

    def test_owner_assignment_stakes_then_prepares(self):
        calls = Mock()
        calls.attach_mock(self.blockchain.stake, 'stake')
        calls.attach_mock(self.runner.prepareJob, 'prepare')
        with contextlib.redirect_stdout(io.StringIO()):
            self.client._handle_event(self.selected(OWNER.lower()))
        self.assertEqual([c[0] for c in calls.mock_calls], ['stake', 'prepare'])
        self.blockchain.stake.assert_called_once_with(7, 123)

    def test_other_providers_assignments_are_ignored(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.client._handle_event(self.selected('0x' + '99' * 20))
        self.blockchain.stake.assert_not_called()

    def test_failed_stake_is_reported_and_job_not_prepared(self):
        self.blockchain.stake.side_effect = RuntimeError('reverted')
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.client._handle_event(self.selected(OWNER))
        self.runner.prepareJob.assert_not_called()
        self.assertIn('Staking failed', self.server.report_error.call_args[0][1])

    def test_api_key_for_a_different_wallet_stops_the_client(self):
        self.server.get_hardware_address.return_value = '0x' + '99' * 20
        with self.assertRaises(WalletMismatch):
            self.client._check_wallet_matches()
        self.server.get_hardware_address.return_value = OWNER.lower()
        self.client._check_wallet_matches()
        self.server.get_hardware_address.return_value = None  # server doesn't expose it
        self.client._check_wallet_matches()


if __name__ == '__main__':
    unittest.main()
