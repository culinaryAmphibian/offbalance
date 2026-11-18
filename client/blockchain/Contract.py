from blockchain.EventData import BlockchainEvent, Event, event_class_factory
import threading
import time
from web3 import Web3, contract
from web3.exceptions import BlockNotFound, TimeExhausted, TransactionNotFound, Web3RPCError
from blockchain.State import StateConflict


def hex_bytes(value):
    return '0x' + bytes(value).hex()


class TransactionRetry(RuntimeError):
    """A recorded operation is unresolved; retry the same signed transaction."""

# contract wrapper that could be tested for proper ABI alignment
# every transaction is signed by the session key; the contract maps it to its owner (providerOf)

class TransactionFailed(RuntimeError):
    pass

class ProviderContractWrapper():
    def __init__(self, contract: contract.Contract):
        self.contract = contract
        self.state = None
        self._transaction_lock = threading.RLock()
        self._reconcile_history = True

    def assert_chain_identity(self, w3):
        identity = self.state.identity
        if w3.eth.chain_id != identity['chain_id'] or hex_bytes(w3.eth.get_block(0)['hash']) != identity['genesis']:
            raise StateConflict('RPC chain identity changed; stop this provider and restart against the intended chain.')

    def assert_assignment_identity(self, job_id, w3):
        anchor = self.state.job(job_id).get('assignment')
        try:
            block = w3.eth.get_block(anchor['block']) if anchor else None
        except BlockNotFound:
            block = None
        if block is None or hex_bytes(block['hash']) != anchor['hash']:
            raise StateConflict(f'Job {job_id} assignment is no longer on the canonical chain; automatic recovery stopped.')

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
        self.assert_assignment_identity(record['job_id'], w3)
        receipt = self._canonical_receipt(w3, record)
        if receipt is None:
            self.state.save_transaction(operation, status='pending')
            signer = Web3.to_checksum_address(self.state.identity['signer'])
            # Mining can advance the nonce between receipt and nonce reads, and an RPC
            # replica can briefly lag. Recheck the receipt before treating it as a conflict.
            for attempt in range(4):
                if w3.eth.get_transaction_count(signer, 'latest') <= record['nonce']:
                    break
                receipt = self._canonical_receipt(w3, record)
                if receipt is not None:
                    break
                if attempt < 3:
                    time.sleep(0.25)
            else:
                raise StateConflict(f"Nonce {record['nonce']} was consumed without journaled transaction {record['hash']}.")
        if receipt is None:
            try:
                self.assert_chain_identity(w3)
                self.assert_assignment_identity(record['job_id'], w3)
                w3.eth.send_raw_transaction(bytes.fromhex(record['raw'][2:]))
            except (ValueError, Web3RPCError) as error:
                message = str(error).lower()
                if 'already known' not in message and 'known transaction' not in message and 'nonce too low' not in message:
                    raise
            try:
                receipt = w3.eth.wait_for_transaction_receipt(record['hash'], timeout=3, poll_latency=0.25)
            except TimeExhausted as error:
                raise TransactionRetry(f"Transaction {record['hash']} remains pending.") from error
            # A receipt from an orphaned fork must not acknowledge this operation.
            receipt = self._canonical_receipt(w3, record)
            if receipt is None:
                raise TransactionRetry(f"Transaction {record['hash']} is not in the canonical chain.")
        if receipt['status'] != 1:
            self.state.save_transaction(operation, status='reverted', block=receipt['blockNumber'], block_hash=hex_bytes(receipt['blockHash']))
            raise TransactionFailed(f"Transaction {record['hash']} reverted.")
        self.state.save_transaction(operation, status='confirmed', block=receipt['blockNumber'], block_hash=hex_bytes(receipt['blockHash']))
        return receipt

    def recheck_receipts(self):
        with self._transaction_lock:
            self._reconcile_history = True

    def reconcile_pending(self, w3):
        with self._transaction_lock:
            records = self.state.snapshot()['transactions']
            for operation, record in sorted(records.items(), key=lambda item: item[1]['nonce']):
                if record['status'] == 'pending' or (self._reconcile_history and self._canonical_receipt(w3, record) is None):
                    self._resolve(operation, record, w3)
            self._reconcile_history = False

    def _send_durable(self, operation, function, signer, w3, value):
        self.assert_chain_identity(w3)
        job_id = int(operation.split(':', 1)[1])
        self.assert_assignment_identity(job_id, w3)
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
                          job_id=job_id, nonce=tx['nonce'], status='pending')
            # This fsync precedes broadcast: a crash can only cause identical rebroadcast.
            self.state.save_transaction(operation, **record)
            return self._resolve(operation, record, w3)


    # build, sign with the session key, send, and wait; raises if the transaction reverted
    def _send(self, fn, signer, w3, value: int = 0, label: str = "transaction", operation=None):
        if self.state is not None:
            return self._send_durable(operation, fn, signer, w3, value)
        tx = fn.build_transaction({
            "from": signer.address,
            "value": value,
            "nonce": w3.eth.get_transaction_count(signer.address, "pending"),
        })
        signed = signer.sign_transaction(tx)
        receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
        if receipt["status"] != 1:
            raise TransactionFailed(f"{label} reverted (tx {receipt['transactionHash'].hex()})")
        print(f"{label} mined in block {receipt['blockNumber']}")
        return receipt

    # the stake amount was fixed when the provider was assigned (PROVIDER_SELECTED's `stake`)
    def submitStake(self, jobId, amount: int, signer, w3):
        return self._send(self.contract.functions.submitStake(jobId), signer, w3, value=amount, label=f"stake for job {jobId}", operation=f"stake:{jobId}")

    # the stake was already deposited with submitStake
    def submitCommitment(self, jobId, commitment: bytes, signer, w3):
        return self._send(self.contract.functions.submitCommitment(jobId, commitment), signer, w3, label=f"commitment for job {jobId}", operation=f"commit:{jobId}")

    def submitReveal(self, jobId, output: bytes, salt: bytes, signer, w3):
        return self._send(self.contract.functions.submitReveal(jobId, output, salt), signer, w3, label=f"reveal for job {jobId}", operation=f"reveal:{jobId}")

    # the wallet `address` acts for: its owner if it's a live session key, otherwise itself
    def providerOf(self, address: str) -> str:
        return self.contract.functions.providerOf(address).call()

    # (owner, expiresAt) for a session key; owner is the zero address if it was never registered
    def sessionKeyInfo(self, address: str) -> tuple[str, int]:
        owner, expires_at = self.contract.functions.sessionKeys(address).call()
        return owner, expires_at

    def stakeFor(self, address: str) -> int:
        return self.contract.functions.stakeFor(address).call()

    def deadlines(self, job_id):
        return self.contract.functions.getDeadlines(job_id).call()

    def provider_commitment(self, job_id, owner, block_identifier='latest'):
        return self.contract.functions.getProviderCommitment(job_id, owner).call(block_identifier=block_identifier)

    def getEventLogs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        raw_event_factory = getattr(self.contract.events, event_type.value, None)
        if raw_event_factory is None:
            raise ValueError(f"Event factory failed to get a contract event called: {event_type.value}")

        raw_logs = list(raw_event_factory().get_logs(from_block=from_block, to_block=to_block))
        events = []
        for log in raw_logs:
            event = event_class_factory(log)
            event.transaction_index = log.get('transactionIndex', 0)
            event.log_index = log.get('logIndex', 0)
            event.block_hash = hex_bytes(log['blockHash']) if 'blockHash' in log else None
            events.append(event)
        return events
