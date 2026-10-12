from dataclasses import dataclass

# score data class
@dataclass(frozen=True, slots=True)
class Scores:
    cpu: float
    gpu: float | None
    memory: float