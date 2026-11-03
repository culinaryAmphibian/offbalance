# main orchestrator that creates all of the managers
#
#   python3 main.py                        # prompts for the API key + session key
#   python3 main.py --dev --provider 2     # keys from dev.env (the provider wallet acts directly)
#
# Startup:
#   1. ask for the API key (Provider Setup page) and session key (Authorize provider client)
#   2. fetch the contract address + ABI from the server with the API key
#   3. ask the contract which wallet the session key acts for (the owner)
#   4. hand the credentials to the managers and run
from blockchain.BlockchainManager import BlockchainManager
from benchmark.BenchmarkManager import BenchmarkManager
from server.ServerManager import ServerManager
from ProviderClient import ProviderClient
from Credentials import Credentials, parse_api_key, parse_session_key, prompt_credentials
from web3 import Web3
import argparse
import os
import sys
import time
from pathlib import Path
from job.RunManager import RunManager
from blockchain.Contract import ProviderContractWrapper

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_ENV_FILE = REPO_ROOT / 'dev.env'

# every value can be overridden from the environment (see dev.env)
BASE_URL = os.environ.get('OFFBALANCE_SERVER_URL', 'http://localhost:5000')
RPC_URL = os.environ.get('RPC_URL', 'http://127.0.0.1:8545')

# warn when the session key is about to stop working, or can't afford a stake plus some gas
EXPIRY_WARNING_SECONDS = 24 * 60 * 60
GAS_HEADROOM_WEI = Web3.to_wei(0.005, 'ether')

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OffBalance provider client")
    parser.add_argument('--dev', action='store_true',
                        help="local hardhat mode: provider key from dev.env, API key defaults to dev/dev2/dev3/dev4")
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

# dev keys are the provider wallets themselves; the contract lets a wallet act without a session key
def load_dev_credentials(provider: int) -> Credentials:
    key_name = f'PROVIDER_{provider}_PRIVATE_KEY'
    dev_env = load_dev_env()
    if key_name not in dev_env:
        raise ValueError(f"{key_name} is not in {DEV_ENV_FILE}")
    default_api_key = 'dev' if provider == 1 else f'dev{provider}'
    return Credentials(
        api_key=parse_api_key(os.environ.get('OFFBALANCE_API_KEY', default_api_key)),
        session=parse_session_key(dev_env[key_name]),
    )

# the wallet the session key acts for. Outside --dev the key must be registered and unexpired.
def resolve_owner(contract: ProviderContractWrapper, w3: Web3, creds: Credentials, dev: bool) -> str:
    session = creds.session_address
    owner = contract.providerOf(session)
    if owner.lower() == session.lower():
        if not dev:
            sys.exit(
                f"Session key {session} isn't authorized for any wallet, or it has expired.\n"
                "Open Provider Setup in the OffBalance frontend, use \"Authorize provider client\", "
                "and paste the session key it shows."
            )
        return owner

    _, expires_at = contract.sessionKeyInfo(session)
    left = expires_at - int(time.time())
    if left < EXPIRY_WARNING_SECONDS:
        print(f"WARNING: session key expires in {max(left, 0) // 3600}h; authorize a new one soon.", file=sys.stderr)
    balance = w3.eth.get_balance(session)
    needed = contract.stakeFor(owner) + GAS_HEADROOM_WEI
    if balance < needed:
        print(f"WARNING: session key has {Web3.from_wei(balance, 'ether')} ETH; staking a job needs about "
              f"{Web3.from_wei(needed, 'ether')} ETH. Authorize a new key with more funding.", file=sys.stderr)
    return owner

def main():
    args = parse_args()

    # 1. credentials, kept in memory for the life of the client
    creds = load_dev_credentials(args.provider) if args.dev else prompt_credentials()

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        raise ConnectionError(f"Blockchain node is not reachable at {RPC_URL}")

    # 2. the server identifies us by the API key and tells us which contract to use
    s_mgr = ServerManager(BASE_URL, creds.api_key)
    try:
        deployment = s_mgr.get_contract()
        contract_addr = Web3.to_checksum_address(os.environ.get('OFFBALANCE_ADDRESS') or deployment['address'])
        if deployment.get('chainId') is not None and deployment['chainId'] != w3.eth.chain_id:
            raise ValueError(f"the server's contract is on chain {deployment['chainId']}, but {RPC_URL} is chain {w3.eth.chain_id}")
        if not w3.eth.get_code(contract_addr):
            raise ValueError(f"No contract deployed at {contract_addr}")
        contract = ProviderContractWrapper(w3.eth.contract(address=contract_addr, abi=deployment['abi']))

        # 3. which wallet are we working for?
        creds = creds.with_owner(resolve_owner(contract, w3, creds, args.dev))

        # 4. managers built from the credentials
        bc_mgr = BlockchainManager(w3, contract, creds)
        print(f"Provider {creds.owner} (session key {creds.session_address}) listening to {contract_addr}")

        mediator = ProviderClient(BenchmarkManager(), bc_mgr, s_mgr, RunManager(), credentials=creds)
        print("Client started...")
        mediator.run()
    finally:
        s_mgr.close()

if __name__ == "__main__":
    main()
