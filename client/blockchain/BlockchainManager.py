from blockchain.BlockchainEvent import BlockchainEvent
from web3 import Web3, contract
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

        # secret seed from config. it never goes on-chain: only the per-job keys derived from it are revealed
        self.key_seed = key_seed

        # jobs this provider committed to, so it only reveals where it has a commitment
        self.committed_jobs = set()

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

    # one key per job: revealing it exposes only this job's commitment, never the seed or other jobs
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

    # XOR with a keccak pad so the contract can decrypt cheaply:
    #   result_hash = commitment ^ keccak256(abi.encodePacked(key, jobId, provider))
    # the provider address in the pad stops others from reusing this commitment and key as their own
    def encrypt_hash(self, job_id: int, result_hash: bytes) -> bytes:
        pad = Web3.solidity_keccak(["bytes32", "uint256", "address"], [self.job_key(job_id), job_id, self.address])
        return bytes(h ^ p for h, p in zip(result_hash, pad))

    # SUBMIT phase action
    def commit(self, jobId: int, result_hash: bytes):
        self.contract.submitCommitment(jobId, self.encrypt_hash(jobId, result_hash), self.signer, self.w3)
        self.committed_jobs.add(jobId)

    # REVEAL phase action: post the job key so the contract can decrypt the committed hash
    def reveal(self, job_id: int):
        if job_id not in self.committed_jobs:
            return
        self.contract.submitReveal(job_id, self.job_key(job_id), self.signer, self.w3)
        self.committed_jobs.discard(job_id)
