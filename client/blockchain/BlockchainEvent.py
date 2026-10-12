from enum import StrEnum

# defines types of blockchain events, must be consistent with other parts of system
class BlockchainEvent(StrEnum):
    PENDING = "PENDING"
    COMMIT_PHASE = "COMMIT_PHASE"
    REVEAL_PHASE = "REVEAL_PHASE"
    CONSENSUS_VERIFICATION = "CONSENSUS_VERIFICATION"
    AWAITING_DELIVERY = "AWAITING_DELIVERY"
    DELIVERY_RECEIPT_VALIDATION = "DELIVERY_RECEIPT_VALIDATION"
    PAYOUT = "PAYOUT"
    CANCELED = "CANCELED"
    NO_QUORUM = "NO_QUORUM"