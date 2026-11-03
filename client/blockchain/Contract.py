from blockchain.EventData import BlockchainEvent, Event, event_class_factory
from web3 import contract

# contract wrapper that could be tested for proper ABI alignment
# every transaction is signed by the session key; the contract maps it to its owner (providerOf)

class TransactionFailed(RuntimeError):
    pass

class ProviderContractWrapper():
    def __init__(self, contract: contract.Contract):
        self.contract = contract

    # build, sign with the session key, send, and wait; raises if the transaction reverted
    def _send(self, fn, signer, w3, value: int = 0, label: str = "transaction"):
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
        return self._send(self.contract.functions.submitStake(jobId), signer, w3, value=amount, label=f"stake for job {jobId}")

    # the stake was already deposited with submitStake
    def submitCommitment(self, jobId, commitment: bytes, signer, w3):
        return self._send(self.contract.functions.submitCommitment(jobId, commitment), signer, w3, label=f"commitment for job {jobId}")

    def submitReveal(self, jobId, output: bytes, salt: bytes, signer, w3):
        return self._send(self.contract.functions.submitReveal(jobId, output, salt), signer, w3, label=f"reveal for job {jobId}")

    # the wallet `address` acts for: its owner if it's a live session key, otherwise itself
    def providerOf(self, address: str) -> str:
        return self.contract.functions.providerOf(address).call()

    # (owner, expiresAt) for a session key; owner is the zero address if it was never registered
    def sessionKeyInfo(self, address: str) -> tuple[str, int]:
        owner, expires_at = self.contract.functions.sessionKeys(address).call()
        return owner, expires_at

    def stakeFor(self, address: str) -> int:
        return self.contract.functions.stakeFor(address).call()

    def getEventLogs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        raw_event_factory = getattr(self.contract.events, event_type.value, None)
        if raw_event_factory is None:
            raise ValueError(f"Event factory failed to get a contract event called: {event_type.value}")

        raw_logs = list(raw_event_factory().get_logs(from_block=from_block, to_block=to_block))
        return [event_class_factory(e) for e in raw_logs] # return event objects :D