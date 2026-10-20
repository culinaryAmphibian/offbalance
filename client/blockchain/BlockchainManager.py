from blockchain.BlockchainEvent import BlockchainEvent
from web3 import Web3, contract
from eth_abi import encode
from eth_account.signers.local import LocalAccount
from blockchain.EventData import Event, event_class_factory
from blockchain.Contract import ProviderContractWrapper
from Crypto.Protocol.KDF import HKDF
from Crypto.Hash import SHA256

class BlockchainManager():
    event_types = [BlockchainEvent.PROVIDER_SELECTED, 
                   BlockchainEvent.COMMIT_PHASE_START,
                   BlockchainEvent.REVEAL_PHASE_START,
                   BlockchainEvent.DELIVERY_PHASE_START,
                   BlockchainEvent.DELIVERED, # knows that you can take on another job
                   BlockchainEvent.CANCELED]

    # init method might need more
    def __init__(self, w3: Web3, contract : ProviderContractWrapper, signer: LocalAccount, key_seed: bytes):
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

        # secret seed from config. it never goes on-chain: only the per-job salts derived from it are revealed
        self.key_seed = key_seed

        # job id -> the result hash this provider committed to, kept for the reveal
        self.committed_jobs: dict[int, bytes] = {}

    def pollEvents(self):
        # poll events in the following range:
        end_block = self.w3.eth.block_number # the last published block
        start_block = self.next_block_to_scan # the blocks before it that you haven't scanned (usually this is just end_block again, meaning you only end up scanning the newest block)
        res = []
        
        if start_block <= end_block:
            for event in self.event_types:
                logs = self.contract.getEventLogs(event, start_block, end_block)
                res.extend(logs)

        # advance next_block_to_scan for the next block that will be published
        self.next_block_to_scan = end_block + 1
        return res

    # one salt per job: revealing it exposes only this job's commitment, never the seed or other jobs
    def job_key(self, job_id: int) -> bytes:
        key = HKDF(
            self.key_seed,
            32,
            b"off-balance-job-key-v1",
            SHA256,
            num_keys=1,
            context=job_id.to_bytes(32, "big"),
        )
        # HKDF only returns a tuple when num_keys > 1; this narrows the type for the checker
        assert isinstance(key, bytes)
        return key

    # matches the contract's check: keccak256(abi.encode(keccak256(output), salt)).
    # the revealed "output" is the 32-byte result hash, so the full output never goes on-chain
    def commitment(self, job_id: int, result_hash: bytes) -> bytes:
        return Web3.keccak(encode(["bytes32", "bytes32"], [Web3.keccak(result_hash), self.job_key(job_id)]))

    # SUBMIT phase action: commits and posts the stake
    def commit(self, jobId: int, result_hash: bytes):
        self.contract.submitCommitment(jobId, self.commitment(jobId, result_hash), self.signer, self.w3)
        self.committed_jobs[jobId] = result_hash

    # REVEAL phase action: post the result hash and salt so the contract can check them against the commitment
    def reveal(self, job_id: int):
        result_hash = self.committed_jobs.pop(job_id, None)
        if result_hash is None:
            return
        self.contract.submitReveal(job_id, result_hash, self.job_key(job_id), self.signer, self.w3)
