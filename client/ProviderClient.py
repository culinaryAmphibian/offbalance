# mediator design pattern - holds references to all managers and governs their interactions
from benchmark.BenchmarkManager import BenchmarkManager
from blockchain.BlockchainManager import BlockchainManager
from blockchain.BlockchainEvent import BlockchainEvent
from server.ServerManager import ServerManager
from blockchain.EventData import *
from job.RunManager import RunManager
from web3 import Web3
import time
import threading



class ProviderClient():
    def __init__(self, benchmark: BenchmarkManager, blockchain: BlockchainManager, server: ServerManager, runner: RunManager):
        self.benchmark = benchmark
        self.blockchain = blockchain
        self.server = server
        self.runner = runner

    # mediator methods here...
    def run(self) -> None:
        scores = self.benchmark.do_benchmark()
        # failures terminate with error
        self.server.post_benchmark(scores)

        # mux events 
        while True:
            events = self.blockchain.pollEvents()
            for event in events:
                self._handle_event(event)

            time.sleep(1)

    # ugly ahh multiplexer D:
    def _handle_event(self, event: Event):
        print(event)

        if isinstance(event, ProviderSelectedEvent):  
            print('Handling assignment')  
            if self.blockchain.address == event.provider_selected:
                self.handleAssignment(event.jobId)

        elif isinstance(event, CommitPhaseStartEvent):
            print("Handling commit phase start")
            self.handleCommitPhaseStart(event.jobId, event.deadline)

        elif isinstance(event, RevealPhaseStartEvent):
            print("Handling reveal phase start")
            self.blockchain.reveal(event.jobId)

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
    
    def handleAssignment(self, jobId):
        print(f"Handling assignment for: {jobId}")
        manifest = self.server.getDockerManifest(jobId)
        self.runner.prepareJob(manifest, jobId)

    def handleCommitPhaseStart(self, jobId, deadline):
        threading.Thread(target=self._runAndCommit, args=(jobId, deadline), daemon=True).start() 
        # timer, when the runner is ready, then he should return the result..?
    
    def _runAndCommit(self, jobId, deadline):
        result = self.runner.startJob(jobId, deadline)
        if result.status == 'ok' and result.output_dir:
            print(f"Result was obtained: {result.output_dir}")
            self.blockchain.commit(jobId, self.runner.hash_dir(result.output_dir))

        
    