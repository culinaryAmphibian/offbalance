# mediator design pattern - holds references to all managers and governs their interactions
from benchmark.BenchmarkManager import BenchmarkManager
from blockchain.BlockchainManager import BlockchainManager
from blockchain.BlockchainEvent import BlockchainEvent
from server.ServerManager import ServerManager
import time

class ProviderClient():
    def __init__(self, benchmark: BenchmarkManager, blockchain: BlockchainManager, server: ServerManager):
        self.benchmark = benchmark
        self.blockchain = blockchain
        self.server = server

    # mediator methods here...
    def run(self) -> None:
        scores = self.benchmark.do_benchmark()

        # failures terminate with error
        self.server.post_benchmark(scores) 

        while True:
            events = self.blockchain.poll_events()
            for event in events:
                self._handle_event(event)

            time.sleep(1)

    def _handle_event(self, event: BlockchainEvent):
        raise NotImplementedError()
        # here, will need to mux the events and orchestrate client workflow
