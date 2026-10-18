from blockchain.EventData import BlockchainEvent, Event, event_class_factory
from web3 import contract

# contract wrapper that could be tested for proper ABI alignment

class ProviderContractWrapper():
    def __init__(self, contract: contract.Contract):
        self.contract = contract

    def submitCommitment(self, jobId, hash: bytes, signer, w3):
        commit = int.from_bytes(hash, "big")
        tx = self.contract.functions.submitCommitment(jobId, commit).build_transaction({
            "from": signer.address,
            "nonce": w3.eth.get_transaction_count(signer.address, "pending"),
 
        })

        signed = signer.sign_transaction(tx)
        return w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))

    def submitReveal(self, jobId):
        self.contract.functions.submitReveal(jobId)

    def getEventLogs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        raw_event_factory = getattr(self.contract.events, event_type.value, None)
        if raw_event_factory is None:
            raise ValueError(f"Event factory failed to get a contract event called: {event_type.value}")

        raw_logs = list(raw_event_factory().get_logs(from_block=from_block, to_block=to_block))
        return [event_class_factory(e) for e in raw_logs] # return event objects :D