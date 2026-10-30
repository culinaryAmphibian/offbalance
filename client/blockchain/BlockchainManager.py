"""Ordered event consumption and recovery from the provider's private journal."""
import os

from web3 import Web3
from web3.exceptions import BlockNotFound
from eth_abi import encode
from Crypto.Protocol.KDF import HKDF
from Crypto.Hash import SHA256

from blockchain.BlockchainEvent import BlockchainEvent
from blockchain.Contract import hex_bytes, TransactionRetry
from blockchain.State import ProviderState, StateConflict


class BlockchainManager:
    event_types = [BlockchainEvent.PROVIDER_SELECTED, BlockchainEvent.COMMIT_PHASE_START,
                   BlockchainEvent.REVEAL_PHASE_START, BlockchainEvent.DELIVERY_PHASE_START,
                   BlockchainEvent.DELIVERED, BlockchainEvent.CANCELED, BlockchainEvent.NO_QUORUM]
    COMMIT, REVEAL = 2, 3
    TERMINAL = {6, 7, 8, 9}  # DELIVERED, PAID, CANCELED, NO_QUORUM

    def __init__(self, w3, contract, signer, key_seed, state_dir=None, start_block=None):
        self.w3, self.contract, self.signer = w3, contract, signer
        self.address, self.key_seed = signer.address, key_seed
        self.start_block = int(os.environ.get('OFFBALANCE_START_BLOCK', '0')) if start_block is None else start_block
        if self.start_block < 0:
            raise ValueError('Start block must be nonnegative.')
        identity = dict(chain_id=w3.eth.chain_id, genesis=hex_bytes(w3.eth.get_block(0)['hash']),
                        contract=contract.contract.address.lower(), signer=signer.address.lower())
        self.state = ProviderState(identity, key_seed, state_dir, self.start_block)
        contract.state = self.state
        self._batch = None

    @property
    def next_block_to_scan(self):
        return self.state.snapshot()['next_block']

    def close(self):
        self.state.close()

    def _hash_at(self, height):
        try:
            return hex_bytes(self.w3.eth.get_block(height)['hash'])
        except BlockNotFound:
            return None

    def _check_checkpoint(self):
        anchors = self.state.snapshot()['anchors']
        if anchors and self._hash_at(anchors[-1]['block']) != anchors[-1]['hash']:
            canonical = [anchor for anchor in anchors if self._hash_at(anchor['block']) == anchor['hash']]
            rewind = canonical[-1]['block'] + 1 if canonical else self.start_block
            def update(data):
                data['anchors'] = canonical
                data['next_block'] = rewind
                for job in data['jobs'].values():
                    job['terminal'] = False
                for transaction in data['transactions'].values():
                    transaction['status'] = 'pending'
            self.state.update(update)

    def pollEvents(self):
        self.contract.assert_chain_identity(self.w3)
        self._check_checkpoint()
        start = self.next_block_to_scan
        end = min(self.w3.eth.block_number, start + 255)
        self._batch = None
        if start > end:
            return []
        block_hash = self._hash_at(end)
        events = []
        for event_type in self.event_types:
            events.extend(self.contract.getEventLogs(event_type, start, end))
        events.sort(key=lambda event: (event.block_number, event.transaction_index, event.log_index))
        self._batch = (end, block_hash)
        return events

    def acknowledgeEvents(self):
        if self._batch is None:
            return
        end, block_hash = self._batch
        if block_hash is None or self._hash_at(end) != block_hash:
            raise TransactionRetry('Chain reorganized during event handling; replaying the unacknowledged batch.')
        def update(data):
            data['next_block'] = end + 1
            data['anchors'] = (data['anchors'] + [dict(block=end, hash=block_hash)])[-32:]
        self.state.update(update)
        self._batch = None

    def needs_manifest(self, job_id):
        job = self.state.job(job_id)
        phase, deadline, *_ = self.contract.deadlines(job_id)
        now = self.w3.eth.get_block('latest')['timestamp']
        return not job.get('manifest') and not job.get('result') and phase == self.COMMIT and now < deadline

    def remember_assignment(self, job_id, manifest):
        fields = dict(assigned=True)
        if manifest is not None:
            fields['manifest'] = manifest
        self.state.save_job(job_id, **fields)

    def request_execution(self, job_id):
        if self.state.job(job_id).get('assigned'):
            self.state.save_job(job_id, execution_requested=True)

    def job_key(self, job_id):
        key = HKDF(self.key_seed, 32, b'off-balance-job-key-v1', SHA256,
                   context=job_id.to_bytes(32, 'big'))
        assert isinstance(key, bytes)
        return key

    def commitment(self, job_id, result_hash):
        salt = bytes.fromhex(self.state.job(job_id).get('salt', self.job_key(job_id).hex()))
        return Web3.keccak(encode(['bytes32', 'bytes32'], [Web3.keccak(result_hash), salt]))

    def commit(self, job_id, result_hash):
        job = self.state.job(job_id)
        if job.get('result') and job['result'] != result_hash.hex():
            raise StateConflict(f'Job {job_id} result changed after it was journaled.')
        # Result and its opening must survive a crash even before transaction construction.
        self.state.save_job(job_id, result=result_hash.hex(), salt=job.get('salt', self.job_key(job_id).hex()))
        self.contract.submitCommitment(job_id, self.commitment(job_id, result_hash), self.signer, self.w3)
        self.state.save_job(job_id, committed=True)

    def reveal(self, job_id):
        job = self.state.job(job_id)
        if not job.get('result'):
            return
        result, salt = bytes.fromhex(job['result']), bytes.fromhex(job['salt'])
        self.contract.submitReveal(job_id, result, salt, self.signer, self.w3)
        self.state.save_job(job_id, revealed=True)

    def recovery_actions(self):
        """Use current chain state, never old phase events, to decide the next action."""
        self.contract.assert_chain_identity(self.w3)
        self.contract.reconcile_pending(self.w3)
        actions = []
        now = self.w3.eth.get_block('latest')['timestamp']
        for text_id, job in self.state.snapshot()['jobs'].items():
            if job.get('terminal'):
                continue
            job_id = int(text_id)
            phase, commit_deadline, reveal_deadline, _ = self.contract.deadlines(job_id)
            execution = job.get('execution', {})
            expired = phase != self.COMMIT or now >= commit_deadline
            if expired and execution.get('container') and not execution.get('cleaned'):
                actions.append((job_id, 'cleanup', 0))
                continue
            if phase in self.TERMINAL:
                self.state.save_job(job_id, terminal=True)
                continue
            if phase not in (self.COMMIT, self.REVEAL):
                continue
            assigned = self.contract.assigned_providers(job_id)
            if self.address.lower() not in {address.lower() for address in assigned}:
                continue  # e.g. assignment orphaned in a reorg
            chain_hash, output_hash, revealed, *_ = self.contract.provider_commitment(job_id, self.address)
            if bytes(chain_hash) != bytes(32):
                if not job.get('result'):
                    raise StateConflict(f'Job {job_id} has an on-chain commitment but no local opening.')
                result = bytes.fromhex(job['result'])
                if bytes(chain_hash) != self.commitment(job_id, result):
                    raise StateConflict(f'Job {job_id} on-chain commitment differs from the journal.')
                self.state.save_job(job_id, committed=True)
                if revealed:
                    if bytes(output_hash) != Web3.keccak(result):
                        raise StateConflict(f'Job {job_id} on-chain reveal differs from the journal.')
                    self.state.save_job(job_id, revealed=True)
                elif phase == self.REVEAL and now <= reveal_deadline:
                    actions.append((job_id, 'reveal', 0))
            elif phase == self.COMMIT and now < commit_deadline:
                if job.get('result'):
                    actions.append((job_id, 'commit', 0))
                elif job.get('execution_requested') and job.get('manifest') and not job.get('execution_failed') and execution.get('status') != 'failed':
                    actions.append((job_id, 'execute', commit_deadline - now))
        return actions
