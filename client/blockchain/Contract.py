from blockchain.EventData import BlockchainEvent, Event, event_class_factory
from web3 import contract

# contract wrapper that could be tested for proper ABI alignment

class ProviderContractWrapper():
    def __init__(self, contract: contract.Contract):
        self.contract = contract

    # the commitment carries the provider's stake, which the contract sets per provider
    def submitCommitment(self, jobId, commitment: bytes, signer, w3):
        stake = self.contract.functions.stakeFor(signer.address).call()
        tx = self.contract.functions.submitCommitment(jobId, commitment).build_transaction({
            "from": signer.address,
            "value": stake,
            "nonce": w3.eth.get_transaction_count(signer.address, "pending"),
        })

        signed = signer.sign_transaction(tx)
        receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
        print(f"Receipt for commitment: {receipt}")
        
        return receipt 
    

    def submitReveal(self, jobId, output: bytes, salt: bytes, signer, w3):
        tx = self.contract.functions.submitReveal(jobId, output, salt).build_transaction({
            "from": signer.address,
            "nonce": w3.eth.get_transaction_count(signer.address, "pending"),
        })

        signed = signer.sign_transaction(tx)
        receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
        print(f"Receipt for reveal: {receipt}")

        return receipt

    def getEventLogs(self, event_type: BlockchainEvent, from_block: int, to_block: int) -> list[Event]:
        raw_event_factory = getattr(self.contract.events, event_type.value, None)
        if raw_event_factory is None:
            raise ValueError(f"Event factory failed to get a contract event called: {event_type.value}")

        raw_logs = list(raw_event_factory().get_logs(from_block=from_block, to_block=to_block))
        return [event_class_factory(e) for e in raw_logs] # return event objects :D