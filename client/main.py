# main orchestrator that creates all of the managers
#
#   python3 main.py                        # real flow: server + prompts
#   python3 main.py --dev                  # local hardhat node, provider 1, no server
#   python3 main.py --dev --provider 2 --mock   # listen to the event mock (dev/event_controller.py)
from blockchain.BlockchainManager import BlockchainManager
from benchmark.BenchmarkManager import BenchmarkManager
from server.ServerManager import ServerManager
from ProviderClient import ProviderClient
from web3 import Web3
import argparse
import json
import os
from pathlib import Path
from eth_account import Account
from eth_account.signers.local import LocalAccount
from getpass import getpass

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_ENV_FILE = REPO_ROOT / 'dev.env'

# every value can be overridden from the environment (see dev.env)
BASE_URL = os.environ.get('OFFBALANCE_SERVER_URL', 'http://localhost:5173')
RPC_URL = os.environ.get('RPC_URL', 'http://127.0.0.1:8545')
# written by `npm run deploy:local` in blockchain/
DEPLOYMENT_FILE = REPO_ROOT / os.environ.get('OFFBALANCE_DEPLOYMENT', 'blockchain/deployments/localhost.json')

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OffBalance provider client")
    parser.add_argument('--dev', action='store_true',
                        help="local hardhat mode: key from dev.env, contract from the deployment file, no server")
    parser.add_argument('--provider', type=int, default=1,
                        help="with --dev: which PROVIDER_N_PRIVATE_KEY from dev.env to use (default 1)")
    parser.add_argument('--mock', action='store_true',
                        help="with --dev: listen to OffBalanceEventMock instead of OffBalance")
    return parser.parse_args()

def load_dev_env() -> dict[str, str]:
    env = {}
    for line in DEV_ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key] = value
    return env

def ask_for_session_key() -> LocalAccount:
    session_key = os.environ.get('PROVIDER_PRIVATE_KEY') or getpass("Please provide your authenticated session key: ")
    return Account.from_key(session_key)

def ask_for_api_key() -> str:
    return os.environ.get('OFFBALANCE_API_KEY') or input("Please provide your API key for OffBalance: ")

def ask_for_contract_addr(s_mgr: ServerManager) -> str:
    # override: skip the server and use this address
    if addr := os.environ.get('OFFBALANCE_ADDRESS'):
        return addr

    res = s_mgr.request('GET', '/contract_address')
    data = res.json()
    # server responds with the "address" field
    return data['address']

def main():
    args = parse_args()
    be_mgr = BenchmarkManager()

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        raise ConnectionError(f"Hardhat node is not reachable at {RPC_URL}")

    deployment = json.loads(DEPLOYMENT_FILE.read_text())
    contract_abi = deployment['abi']

    if args.dev:
        # no server in dev: addresses come from the deployment file, keys from dev.env
        s_mgr = None
        key_name = f'PROVIDER_{args.provider}_PRIVATE_KEY'
        dev_env = load_dev_env()
        if key_name not in dev_env:
            raise ValueError(f"{key_name} is not in {DEV_ENV_FILE}")
        signer = Account.from_key(dev_env[key_name])

        if args.mock:
            addr_str = deployment['eventMock']['address']
            contract_abi = deployment['eventMock']['abi']
        else:
            addr_str = deployment['address']
    else:
        # create server manager
        s_mgr = ServerManager(BASE_URL, ask_for_api_key())
        # obtain contract addr from server via network call
        addr_str = ask_for_contract_addr(s_mgr)
        # get the signer account
        signer = ask_for_session_key()

    contract_addr = Web3.to_checksum_address(addr_str)

    # make sure it's valid
    if not w3.eth.get_code(contract_addr):
        raise ValueError(f"No contract deployed at {addr_str}")

    # contract object
    contract = w3.eth.contract(address=contract_addr, abi=contract_abi)

    # finally ready for blockchain manager
    bc_mgr = BlockchainManager(w3, contract, signer)
    print(f"Provider {signer.address} listening to {contract_addr}")

    mediator = ProviderClient(be_mgr, bc_mgr, s_mgr)
    try:
        mediator.run()
    finally:
        if s_mgr is not None:
            s_mgr.close()

if __name__ == "__main__":
    main()
