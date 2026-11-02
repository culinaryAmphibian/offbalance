import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
SERVER_ABI = [{'type': 'function', 'name': 'fromServer'}]
FILE_ABI = [{'type': 'function', 'name': 'fromFile'}]


def server_returning(body):
    s_mgr = Mock()
    s_mgr.request.return_value.json.return_value = body
    return s_mgr


class ContractLookupTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.deployment = Path(directory.name) / 'localhost.json'
        self.deployment.write_text(json.dumps({'address': ADDRESS, 'abi': FILE_ABI}))
        patcher = patch.object(main, 'DEPLOYMENT_FILE', self.deployment)
        patcher.start()
        self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('OFFBALANCE_ADDRESS', None)

    def test_a_remote_provider_gets_address_abi_and_chain_from_the_server(self):
        self.deployment.unlink()  # another machine has no deployment file
        s_mgr = server_returning({'address': ADDRESS, 'chainId': 31337, 'abi': SERVER_ABI})
        self.assertEqual(main.fetch_contract(s_mgr), (ADDRESS, SERVER_ABI, 31337))
        s_mgr.request.assert_called_once_with('GET', '/contract_address')

    def test_an_older_server_without_the_abi_falls_back_to_the_deployment_file(self):
        self.assertEqual(main.fetch_contract(server_returning({'address': ADDRESS})), (ADDRESS, FILE_ABI, None))

    def test_the_address_override_skips_the_server(self):
        os.environ['OFFBALANCE_ADDRESS'] = ADDRESS
        s_mgr = Mock()
        self.assertEqual(main.fetch_contract(s_mgr), (ADDRESS, FILE_ABI, None))
        s_mgr.request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
