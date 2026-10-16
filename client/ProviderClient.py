# mediator design pattern - holds references to all managers and governs their interactions
from benchmark.BenchmarkManager import BenchmarkManager
from blockchain.BlockchainManager import BlockchainManager
from blockchain.BlockchainEvent import BlockchainEvent
from server.ServerManager import ServerManager
from blockchain.EventData import *
from web3 import Web3
import time



class ProviderClient():
    # server is None in dev mode (no backend running)
    def __init__(self, benchmark: BenchmarkManager, blockchain: BlockchainManager, server: ServerManager | None):
        self.benchmark = benchmark
        self.blockchain = blockchain
        self.server = server
        self.busy = False # flag saying whether we do job or not

    # mediator methods here...
    def run(self) -> None:
        scores = self.benchmark.do_benchmark()
        # failures terminate with error
        if self.server is not None:
            self.server.post_benchmark(scores)
        else:
            print(f"No server, skipping benchmark post: {scores}")

        # mux events 
        while True:
            events = self.blockchain.poll_events()
            for event in events:
                self._handle_event(event)

            time.sleep(1)

    # ugly ahh multiplexer D:
    def _handle_event(self, event: Event):
        print(event)
        if isinstance(event, ProviderSelectedEvent):    
                if self.blockchain.address == event.provider_selected:
                    print(f"I was selected! {self.blockchain.address} === {event.provider_selected}")
                print("Handling provider selected!")

        elif isinstance(event, CommitPhaseStartEvent):
            print("Handling commit phase start")

        elif isinstance(event, RevealPhaseStartEvent):
            print("Hanlding reveal phase start")

        elif isinstance(event, DeliveryPhaseStartEvent):
            print("Handling delivery phase start")

        elif isinstance(event, DeliveredEvent):
            print("Handling delivered event")

        elif isinstance(event, CanceledEvent):
            print("Handling canceled event")

        elif isinstance(event, NoQuorumEvent):
            print("Handling No quorum event")

        else:    
            raise ValueError(f"Unknown event of type: {event.type}")
        
        # here, will need to mux the events and orchestrate client workflow