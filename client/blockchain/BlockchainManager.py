from blockchain.BlockchainEvent import BlockchainEvent
from web3 import Web3
from web3.exceptions import BlockNotFound
from eth_abi import encode
from Credentials import Credentials
from blockchain.Contract import ProviderContractWrapper, TransactionRetry, hex_bytes
from blockchain.State import ProviderState, StateConflict
from Crypto.Protocol.KDF import HKDF
from Crypto.Hash import SHA256

class BlockchainManager:
    # OffBalance.Status values returned by getDeadlines.
    STAKING, COMMIT, REVEAL, DELIVERING = 1, 3, 4, 6
    TERMINAL = {8, 9, 10}
    event_types = [BlockchainEvent.PROVIDER_SELECTED, 
                   BlockchainEvent.COMMIT_PHASE_START,
                   BlockchainEvent.REVEAL_PHASE_START,
                   BlockchainEvent.DELIVERY_PHASE_START,
                   BlockchainEvent.DELIVERED, # knows that you can take on another job
                   BlockchainEvent.CANCELED,
                   BlockchainEvent.NO_QUORUM]

    # init method might need more
    def __init__(self, w3: Web3, contract : ProviderContractWrapper, credentials: Credentials, *, state_dir=None):
        # w3 is the connection to the chain
        self.w3 = w3

        # contract is the contract binding using contract address and ABI
        self.contract = contract

        if credentials.owner is None:
            raise ValueError("credentials.owner must be resolved from the chain first")
        self.credentials = credentials

        # the session key signs every transaction...
        self.signer = credentials.session
        self.address = credentials.session.address

        # ...on behalf of the owner wallet: the identity the server assigns and the contract pays.
        # Events name the owner, so assignments are matched against it.
        self.owner = credentials.owner
        
        # i need to look through only the latest block for the events, but only do it once. Hence, I have a last_scanned_block value
        self.next_block_to_scan = w3.eth.block_number

        # derived from the session key. it never goes on-chain: only the per-job salts derived from it are revealed
        self.key_seed = credentials.key_seed

        # job id -> the result hash this provider committed to, kept for the reveal
        self.committed_jobs: dict[int, bytes] = {}
        self.state = None
        self._batch = None
        if state_dir is not None:
            identity = dict(
                chain_id=w3.eth.chain_id, genesis=hex_bytes(w3.eth.get_block(0)['hash']),
                contract=contract.contract.address.lower(), owner=self.owner.lower(),
                signer=self.address.lower(),
            )
            self.state = ProviderState(identity, self.key_seed, state_dir, self.next_block_to_scan)
            self.contract.state = self.state

    def close(self):
        if self.state is not None:
            self.state.close()

    def _block_hash(self, height):
        try:
            return hex_bytes(self.w3.eth.get_block(height)['hash'])
        except BlockNotFound:
            return None

    def _restore_cursor(self):
        snapshot = self.state.snapshot()
        anchors = snapshot['anchors']
        if anchors and self._block_hash(anchors[-1]['block']) != anchors[-1]['hash']:
            canonical = [entry for entry in anchors if self._block_hash(entry['block']) == entry['hash']]
            def rewind(data):
                data['anchors'] = canonical
                data['next_block'] = canonical[-1]['block'] + 1 if canonical else data['start_block']
                for job in data['jobs'].values():
                    job['terminal'] = False
                    job['delivered'] = False
                    job['delivery_failed'] = False
            self.state.update(rewind)
            self.contract.recheck_receipts()
            return self.state.snapshot()['next_block']
        return snapshot['next_block']

    def acknowledgeEvents(self):
        if self._batch is None:
            return
        end, block_hash = self._batch
        if block_hash is None or self._block_hash(end) != block_hash:
            raise TransactionRetry('Chain changed during event handling; replaying unacknowledged events.')
        def save(data):
            data['next_block'] = end + 1
            data['anchors'] = (data['anchors'] + [dict(block=end, hash=block_hash)])[-32:]
        self.state.update(save)
        self._batch = None


    def pollEvents(self):
        start = self.next_block_to_scan
        if self.state is not None:
            self.contract.assert_chain_identity(self.w3)
            start = self._restore_cursor()
        end = min(self.w3.eth.block_number, start + 255)
        self._batch = None
        if start > end:
            return []

        anchor = self._block_hash(end) if self.state is not None else None
        events = []
        for event in self.event_types:
            events.extend(self.contract.getEventLogs(event, start, end))
        events.sort(key=lambda event: (event.block_number, getattr(event, 'transaction_index', 0),
                                       getattr(event, 'log_index', 0)))
        if self.state is None:
            self.next_block_to_scan = end + 1
        else:
            self._batch = (end, anchor)
        return events

    # seconds of chain time left until `timestamp` (the contract's deadlines are chain time)
    def seconds_until(self, timestamp: int) -> int:
        now = int(self.w3.eth.get_block('latest')['timestamp'])
        return max(0, int(timestamp) - now)

    def execution_window(self, block_number: int, execution_seconds: int) -> int:
        # Milestone4 omits the duration from COMMIT_PHASE_START. The assigned
        # manifest supplies it; the event block anchors the start in chain time.
        if not isinstance(execution_seconds, int) or isinstance(execution_seconds, bool) or execution_seconds <= 0:
            raise ValueError('The assigned manifest needs a positive execution timeout.')
        started = int(self.w3.eth.get_block(block_number)['timestamp'])
        now = int(self.w3.eth.get_block('latest')['timestamp'])
        if now < started:
            raise ValueError('Commit event block is ahead of the current chain time.')
        return max(0, started + execution_seconds - now)

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

    # The contract hashes the revealed 32-byte output digest before recomputing the commitment.
    def commitment(self, job_id: int, result_hash: bytes) -> bytes:
        return self._commitment(result_hash, self.job_key(job_id))

    @staticmethod
    def _commitment(result_hash, salt):
        return Web3.keccak(encode(["bytes32", "bytes32"], [Web3.keccak(result_hash), salt]))

    def stake(self, jobId: int, amount: int):
        if self.state is not None:
            self.remember_assignment(jobId)
        self.contract.submitStake(jobId, amount, self.signer, self.w3)

    def commit(self, jobId: int, result_hash: bytes):
        salt = self.job_key(jobId)
        if self.state is not None:
            self.remember_assignment(jobId)
            job = self.state.job(jobId)
            if job.get('result') and job['result'] != result_hash.hex():
                raise StateConflict(f'Job {jobId} output differs from the saved commitment opening.')
            salt = bytes.fromhex(job['salt']) if job.get('salt') else salt
            self.state.save_job(jobId, result=result_hash.hex(), salt=salt.hex())
        self.contract.submitCommitment(jobId, self._commitment(result_hash, salt), self.signer, self.w3)
        if self.state is None:
            self.committed_jobs[jobId] = result_hash

    def reveal(self, job_id: int):
        if self.state is not None:
            job = self.state.job(job_id)
            if not job.get('result'):
                return
            result, salt = bytes.fromhex(job['result']), bytes.fromhex(job['salt'])
        else:
            result = self.committed_jobs.get(job_id)
            if result is None:
                return
            salt = self.job_key(job_id)
        self.contract.submitReveal(job_id, result, salt, self.signer, self.w3)
        self.committed_jobs.pop(job_id, None)

    def remember_assignment(self, job_id, block_number=None, block_hash=None):
        if self.state.job(job_id).get('assignment'):
            return
        if block_hash is None:
            # The API raises candidates it knows about. Bind a legacy assignment only
            # after this owner is also assigned at a specific canonical block.
            block = self.w3.eth.get_block('latest')
            block_number = block['number']
            block_hash = hex_bytes(block['hash'])
            if self.contract.provider_commitment(job_id, self.owner, block_hash)[4] <= 0:
                return
        self.state.save_job(job_id, assignment=dict(block=block_number, hash=block_hash))

    def assert_assignment_identity(self, job_id):
        self.contract.assert_assignment_identity(job_id, self.w3)

    def recovery_actions(self, *, include_waiting=False):
        """Resume jobs using current contract state and the saved commitment opening."""
        self.contract.reconcile_pending(self.w3)
        now = self.w3.eth.get_block('latest')['timestamp']
        for text_id, job in self.state.snapshot()['jobs'].items():
            if job.get('terminal'):
                continue
            job_id = int(text_id)
            self.assert_assignment_identity(job_id)
            phase, pending, commit, reveal, delivery = self.contract.deadlines(job_id)
            execution = job.get('execution', {})
            if (phase != self.COMMIT or now >= commit) and execution.get('container') and not execution.get('cleaned'):
                yield job_id, 'cleanup', 0
                continue
            if phase in self.TERMINAL:
                self.state.save_job(job_id, terminal=True)
                continue
            if phase not in (self.STAKING, self.COMMIT, self.REVEAL, self.DELIVERING):
                continue
            commitment, output, revealed, winning, required, stake = self.contract.provider_commitment(job_id, self.owner)
            action = None
            if phase == self.STAKING and required > 0 and stake == 0 and now < pending:
                action = ('stake', required)
            elif phase == self.COMMIT and stake > 0 and now < commit and not any(commitment):
                if job.get('result'):
                    action = ('commit', 0)
                elif execution.get('status') != 'failed':
                    action = ('execute', commit - now)
            elif job.get('result'):
                result = bytes.fromhex(job['result'])
                expected = self._commitment(result, bytes.fromhex(job['salt']))
                if bytes(commitment) == expected:
                    if phase == self.REVEAL and not revealed and now < reveal:
                        action = ('reveal', 0)
                    elif phase == self.DELIVERING and winning and revealed and now < delivery:
                        if bytes(output) == Web3.keccak(result) and not (job.get('delivered') or job.get('delivery_failed')):
                            action = ('deliver', delivery - now)
            if action is not None:
                yield job_id, *action
            elif include_waiting and (stake > 0 or (phase == self.STAKING and required > 0)):
                yield job_id, 'wait', 0
