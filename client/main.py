# main orchestrator that creates all of the managers
#
#   python3 main.py                        # prompts for API key + session key
#   python3 main.py --dev --provider 2     # keys from dev.env, against server/dev-server.ts
#
# the contract address always comes from the server; the dev server picks
# OffBalance vs OffBalanceEventMock with CONTRACT=real|mock
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
from job.RunManager import RunManager
from blockchain.Contract import ProviderContractWrapper

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_ENV_FILE = REPO_ROOT / 'dev.env'

# every value can be overridden from the environment (see dev.env)
BASE_URL = os.environ.get('OFFBALANCE_SERVER_URL', 'http://localhost:5000')
RPC_URL = os.environ.get('RPC_URL', 'http://127.0.0.1:8545')
# written by `npm run deploy:local` in blockchain/
DEPLOYMENT_FILE = REPO_ROOT / os.environ.get('OFFBALANCE_DEPLOYMENT', 'blockchain/deployments/localhost.json')

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OffBalance provider client")
    parser.add_argument('--dev', action='store_true',
                        help="local hardhat mode: session key from dev.env, API key defaults to dev/dev2/dev3/dev4")
    parser.add_argument('--provider', type=int, default=1,
                        help="with --dev: which PROVIDER_N_PRIVATE_KEY from dev.env to use (default 1)")
    return parser.parse_args()

def load_dev_env() -> dict[str, str]:
    env = {}
    for line in DEV_ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            env[key] = value
    return env

def load_dev_signer(provider: int) -> LocalAccount:
    key_name = f'PROVIDER_{provider}_PRIVATE_KEY'
    dev_env = load_dev_env()
    if key_name not in dev_env:
        raise ValueError(f"{key_name} is not in {DEV_ENV_FILE}")
    return Account.from_key(dev_env[key_name])

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

    # create server manager
    dev_api_key = 'dev' if args.provider == 1 else f'dev{args.provider}'
    api_key = os.environ.get('OFFBALANCE_API_KEY', dev_api_key) if args.dev else ask_for_api_key()
    s_mgr = ServerManager(BASE_URL, api_key)
    # obtain contract addr from server via network call
    addr_str = ask_for_contract_addr(s_mgr)
    # get the signer account
    signer = load_dev_signer(args.provider) if args.dev else ask_for_session_key()

    contract_addr = Web3.to_checksum_address(addr_str)

    # the server may hand out the event mock, which has its own ABI
    deployment = json.loads(DEPLOYMENT_FILE.read_text())
    if contract_addr == Web3.to_checksum_address(deployment['eventMock']['address']):
        contract_abi = deployment['eventMock']['abi']
    else:
        contract_abi = deployment['abi']

    # make sure it's valid
    if not w3.eth.get_code(contract_addr):
        raise ValueError(f"No contract deployed at {addr_str}")

    # contract object
    raw_contract = w3.eth.contract(address=contract_addr, abi=contract_abi)
    contract = ProviderContractWrapper(raw_contract, )

    # finally ready for blockchain manager
    bc_mgr = BlockchainManager(w3, contract, signer)
    print(f"Provider {signer.address} listening to {contract_addr}")

    run_mgr = RunManager()

    print("Client started...")
    mediator = ProviderClient(be_mgr, bc_mgr, s_mgr, run_mgr)
    try:
        mediator.run()
    finally:
        s_mgr.close()

if __name__ == "__main__":
    main()
