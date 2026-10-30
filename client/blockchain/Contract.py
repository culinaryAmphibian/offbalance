"""ABI access and a durable, serialized transaction outbox."""
import threading

from web3 import Web3
from web3.exceptions import BlockNotFound, TimeExhausted, TransactionNotFound, Web3RPCError
from blockchain.EventData import BlockchainEvent, Event, event_class_factory
from blockchain.State import StateConflict


class TransactionRetry(RuntimeError):
    """A durable transaction is still pending; retry the same bytes later."""


class TransactionReverted(RuntimeError):
    pass


def hex_bytes(value):
    return '0x' + bytes(value).hex()


class ProviderContractWrapper:
    def __init__(self, contract):
        self.contract = contract
        self.state = None
        self._transaction_lock = threading.RLock()
        self._reconcile_history = True

    def assert_chain_identity(self, w3):
        identity = self.state.identity
        if w3.eth.chain_id != identity['chain_id'] or hex_bytes(w3.eth.get_block(0)['hash']) != identity['genesis']:
            raise StateConflict('RPC chain identity changed; stop this provider and restart against the intended chain.')

    def _canonical_receipt(self, w3, record):
        try:
            receipt = w3.eth.get_transaction_receipt(record['hash'])
        except TransactionNotFound:
            return None
        try:
            block = w3.eth.get_block(receipt['blockNumber'])
        except BlockNotFound:
            return None
        return receipt if hex_bytes(block['hash']) == hex_bytes(receipt['blockHash']) else None

    def _resolve(self, operation, record, w3):
        self.assert_chain_identity(w3)
        receipt = self._canonical_receipt(w3, record)
        if receipt is None:
            self.state.save_transaction(operation, status='pending')
            # A different transaction consuming our reserved nonce is never guessed away.
            if w3.eth.get_transaction_count(Web3.to_checksum_address(self.state.identity['signer']), 'latest') > record['nonce']:
                raise StateConflict(f"Nonce {record['nonce']} was consumed without journaled transaction {record['hash']}.")
            try:
                self.assert_chain_identity(w3)
                w3.eth.send_raw_transaction(bytes.fromhex(record['raw'][2:]))
            except (ValueError, Web3RPCError) as error:
                message = str(error).lower()
                if 'already known' not in message and 'known transaction' not in message and 'nonce too low' not in message:
                    raise
            try:
                receipt = w3.eth.wait_for_transaction_receipt(record['hash'], timeout=5, poll_latency=0.25)
            except TimeExhausted as error:
                raise TransactionRetry(f"Transaction {record['hash']} remains pending.") from error
            # A receipt from an orphaned fork must not acknowledge this operation.
            receipt = self._canonical_receipt(w3, record)
            if receipt is None:
                raise TransactionRetry(f"Transaction {record['hash']} is not in the canonical chain.")
        if receipt['status'] != 1:
            self.state.save_transaction(operation, status='reverted', block=receipt['blockNumber'], block_hash=hex_bytes(receipt['blockHash']))
            raise TransactionReverted(f"Transaction {record['hash']} reverted.")
        self.state.save_transaction(operation, status='confirmed', block=receipt['blockNumber'], block_hash=hex_bytes(receipt['blockHash']))
        return receipt

    def reconcile_pending(self, w3):
        with self._transaction_lock:
            records = self.state.snapshot()['transactions']
            for operation, record in sorted(records.items(), key=lambda item: item[1]['nonce']):
                if record['status'] == 'pending' or (self._reconcile_history and self._canonical_receipt(w3, record) is None):
                    self._resolve(operation, record, w3)
            self._reconcile_history = False

    def _send(self, operation, function, signer, w3, value=0):
        if self.state is None:
            raise StateConflict('Attach a provider journal before sending transactions.')
        self.assert_chain_identity(w3)
        with self._transaction_lock:
            record = self.state.snapshot()['transactions'].get(operation)
            if record and record['status'] != 'reverted':
                return self._resolve(operation, record, w3)
            self.reconcile_pending(w3)
            if record:
                # Keep a failed nonce's bytes: a reorg can orphan that receipt too.
                self.state.save_transaction(f"{operation}@{record['nonce']}", **record)
            tx = function.build_transaction({
                'from': signer.address, 'value': value,
                'nonce': w3.eth.get_transaction_count(signer.address, 'pending'),
            })
            signed = signer.sign_transaction(tx)
            record = dict(hash=hex_bytes(signed.hash), raw=hex_bytes(signed.raw_transaction),
                          nonce=tx['nonce'], status='pending')
            # This fsync precedes broadcast: a crash can only cause identical rebroadcast.
            self.state.save_transaction(operation, **record)
            return self._resolve(operation, record, w3)

    def submitCommitment(self, jobId, commitment, signer, w3):
        stake = self.contract.functions.stakeFor(signer.address).call()
        function = self.contract.functions.submitCommitment(jobId, commitment)
        return self._send(f'commit:{jobId}', function, signer, w3, stake)

    def submitReveal(self, jobId, output, salt, signer, w3):
        function = self.contract.functions.submitReveal(jobId, output, salt)
        return self._send(f'reveal:{jobId}', function, signer, w3)

    def deadlines(self, job_id):
        return self.contract.functions.getDeadlines(job_id).call()

    def provider_commitment(self, job_id, address):
        return self.contract.functions.getProviderCommitment(job_id, address).call()

    def assigned_providers(self, job_id):
        return self.contract.functions.getAssignedProviders(job_id).call()

    def getEventLogs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        factory = getattr(self.contract.events, event_type.value, None)
        if factory is None:
            raise ValueError(f'No contract event named {event_type.value}')
        events = []
        for log in factory().get_logs(from_block=from_block, to_block=to_block):
            event = event_class_factory(log)
            event.transaction_index = log['transactionIndex']
            event.log_index = log['logIndex']
            events.append(event)
        return events
