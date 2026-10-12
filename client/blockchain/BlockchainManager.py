from BlockchainEvent import BlockchainEvent

class BlockchainManager():
    # init method might need more
    def __init__(self, w3, contract, signer):
        # w3 is the connection to the chain
        self.w3 = w3

        # contract is the contract binding using contract address and ABI
        self.contract = contract

        # signer is the session key object that sends directly
        self.signer = signer

        # its address is also stored for convenience
        self.address = signer.address

    # listen for blockchain events and multiplex functionality
    def poll_events(self) -> list[BlockchainEvent]:
        raise NotImplementedError()
        

    # SUBMIT phase action
    def submit_result_hash(self, job_id: int, result_hash: bytes):
        pass

    # REVEAL phase action
    def submit_result_nonce(self, job_id: int, nonce: bytes):
        pass