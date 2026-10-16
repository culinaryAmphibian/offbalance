from blockchain.BlockchainEvent import BlockchainEvent
from web3 import Web3, contract
from eth_account.signers.local import LocalAccount
from blockchain.EventData import Event, event_class_factory


class BlockchainManager():
    event_types = [BlockchainEvent.PROVIDER_SELECTED, 
                   BlockchainEvent.COMMIT_PHASE_START,
                   BlockchainEvent.REVEAL_PHASE_START,
                   BlockchainEvent.DELIVERY_PHASE_START,
                   BlockchainEvent.DELIVERED, # knows that you can take on another job
                   BlockchainEvent.CANCELED]

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
        
    def get_event_logs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        # this converts my enum to the attribute methods used in web3 api        
        raw_event_factory = getattr(self.contract.events, event_type.value, None) 
        if raw_event_factory is None:
            raise ValueError(f"Event factory failed in get_event logs: {event_type.value}, is it in the contract ABI?")

        # return all logs using web3 api -> raw dictionary
        raw_logs = list(raw_event_factory().get_logs(from_block=from_block, to_block=to_block))

        return [event_class_factory(e) for e in raw_logs] # return neat logs in predefined classes

    def poll_events(self):
        # poll events in the following range:
        end_block = self.w3.eth.block_number # the last published block
        start_block = self.next_block_to_scan # the blocks before it that you haven't scanned (usually this is just end_block again, meaning you only end up scanning the newest block)
        res = []
        
        if start_block <= end_block:
            for event in self.event_types:
                logs = self.get_event_logs(event, start_block, end_block)
                res.extend(logs)

        # advance next_block_to_scan for the next block that will be published
        self.next_block_to_scan = end_block + 1
        return res

    # SUBMIT phase action
    def commit(self, job_id: int, result_hash: bytes):
        pass

    # REVEAL phase action
    def submit_result_nonce(self, job_id: int, nonce: bytes):
        pass