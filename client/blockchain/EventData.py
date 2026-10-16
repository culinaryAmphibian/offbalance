from blockchain.BlockchainEvent import BlockchainEvent
# create a class bucket for events from the blockchain that collect useful info

class Event():
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        self.block_number = block_number
        self.type = event
        self.jobId = jobId

    def __repr__(self):
        return f"block number: {self.block_number}, event: {self.type.value}, jobId: {self.jobId}"

class ProviderSelectedEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int, provider: int):
        super().__init__(block_number, event, jobId)
        self.provider_selected = provider

    def __repr__(self):
        return f"{super().__repr__()} provider selected: {self.provider_selected}"

class CommitPhaseStartEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int, deadline: int):
        super().__init__(block_number, event, jobId)
        self.deadline = deadline

class RevealPhaseStartEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        super().__init__(block_number, event, jobId)

class DeliveryPhaseStartEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        super().__init__(block_number, event, jobId)

class DeliveredEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        super().__init__(block_number, event, jobId)

class CanceledEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        super().__init__(block_number, event, jobId)

class NoQuorumEvent(Event):
    def __init__(self, block_number: int, event: BlockchainEvent, jobId: int):
        super().__init__(block_number, event, jobId)

def event_class_factory(e) -> Event:
    block_number = e['blockNumber']
    event = BlockchainEvent(e['event'])
    args = e['args']
    jobId = args['jobId']

    match e['event']:
        case BlockchainEvent.PROVIDER_SELECTED.value:
            return ProviderSelectedEvent(block_number, event, jobId, args['provider'])
        
        case BlockchainEvent.COMMIT_PHASE_START.value:
            return CommitPhaseStartEvent(block_number, event, jobId, args['deadline'])
        
        case BlockchainEvent.REVEAL_PHASE_START.value:
            return RevealPhaseStartEvent(block_number, event, jobId)
        
        case BlockchainEvent.DELIVERY_PHASE_START.value:
            return DeliveryPhaseStartEvent(block_number, event, jobId)
        
        case BlockchainEvent.DELIVERED.value:
            return DeliveredEvent(block_number, event, jobId)
        
        case BlockchainEvent.CANCELED.value:
            return CanceledEvent(block_number, event, jobId)
        
        case BlockchainEvent.NO_QUORUM.value:
            return NoQuorumEvent(block_number, event, jobId)
        
        case _:
            raise ValueError(f"{e} is could not be processed by factory... block_number:{block_number}, event: {event}, args: {args}, jobId: {jobId}")
    