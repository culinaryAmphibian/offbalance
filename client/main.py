# main orchestrator that creates all of the managers
from blockchain.BlockchainManager import BlockchainManager
from benchmark.BenchmarkManager import BenchmarkManager
from server.ServerManager import ServerManager
from ProviderClient import ProviderClient
from web3 import Web3
import json
from pathlib import Path
from eth_account import Account
from eth_account.signers.local import LocalAccount
from getpass import getpass

ACCESS_TOKEN = 'TEST_TOKEN'
BASE_URL = 'http://localhost:5173'
DEFAULT_RPC = 'http://127.0.0.1:8545'
# need to replace with the proper path and solidity name
CONTRACT_ARTIFACT = Path("artifacts/contracts/OffBalance.sol/OffBalance.json")

def ask_for_session_key() -> LocalAccount:
    session_key = getpass("Please provide your authenticated session key: ")
    return Account.from_key(session_key)

def ask_for_api_key() -> str:
    api_key = input("Please provide your API key for OffBalance: ")
    return api_key

def ask_for_contract_addr(s_mgr: ServerManager) -> str:
    res = s_mgr.request('GET', '/contract_address')
    data = res.json()
    # server responds with the "address" field
    return data.address

def main():
    be_mgr = BenchmarkManager()

    # create server manager
    api_key = ask_for_api_key()
    s_mgr = ServerManager(BASE_URL, api_key)

    
    w3 = Web3(Web3.HTTPProvider(DEFAULT_RPC))
    if not w3.is_connected():
        raise ConnectionError("Hardhat node is not reachable")
    
    # obtain contract addr from server via network call
    addr_str = ask_for_contract_addr(s_mgr)
    contract_addr = Web3.to_checksum_address(addr_str)

    # make sure it's valid
    if not w3.eth.get_code(contract_addr):
        raise ValueError(f"No contract deployed at {addr_str}")

    # obtain contract abi
    artifact = json.loads(CONTRACT_ARTIFACT.read_text())
    contract_abi = artifact['abi']

    # contract object    
    contract = w3.eth.contract(address=contract_addr, abi=contract_abi)

    # get the signer account
    signer = ask_for_session_key()

    # finally ready for blockchain manager
    bc_mgr = BlockchainManager(w3, contract, signer)

    mediator = ProviderClient(be_mgr, bc_mgr, s_mgr)
    try:
        mediator.run()
    finally:
        s_mgr.close()

if __name__ == "__main__":
    main()