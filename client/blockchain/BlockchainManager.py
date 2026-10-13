from BlockchainEvent import BlockchainEvent
from web3 import Web3, contract
from eth_account.signers.local import LocalAccount


class BlockchainManager():
    event_types = []
    # init method might need more
    def __init__(self, w3: Web3, contract : contract.Contract, signer: LocalAccount):
        # w3 is the connection to the chain
        self.w3 = w3

        # contract is the contract binding using contract address and ABI
        self.contract = contract

        # signer is the session key object that sends directly
        self.signer = signer

        # its address is also stored for convenience
        self.address = signer.address
        
        # i need to look through only the latest block for the events, but only do it once. Hence, I have a last_scanned_block value
        self.next_block_to_scan = w3.eth.block_number
        
    def get_event_logs(self, event_type: BlockchainEvent, from_block: int, to_block: int):
        pass # now the ABI is in blockchain/artifacts/contracts

    def poll_events(self):
        # poll events in the following range:
        end_block = self.w3.eth.block_number # the last published block
        start_block = self.next_block_to_scan # the blocks before it that you haven't scanned (usually this is just end_block again, meaning you only end up scanning that one block)
        res = []
        
        if start_block <= end_block:
            for event in self.event_types:
                logs = self.get_event_logs(event, start_block, end_block)
                res.append(logs)

        # advance next_block_to_scan for the next block that will be published
        self.next_block_to_scan = end_block + 1
        return res

    # SUBMIT phase action
    def submit_result_hash(self, job_id: int, result_hash: bytes):
        pass

    # REVEAL phase action
    def submit_result_nonce(self, job_id: int, nonce: bytes):
        pass