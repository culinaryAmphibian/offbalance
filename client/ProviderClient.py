# mediator design pattern - holds references to all managers and governs their interactions
from __future__ import annotations

from typing import TYPE_CHECKING
from blockchain.EventData import *
import requests
import sys
import threading

if TYPE_CHECKING:
    from benchmark.BenchmarkManager import BenchmarkManager
    from blockchain.BlockchainManager import BlockchainManager
    from server.ServerManager import ServerManager
    from job.RunManager import RunManager

HEARTBEAT_INTERVAL_SECONDS = 10

class ProviderClient():
    def __init__(self, benchmark: BenchmarkManager, blockchain: BlockchainManager, server: ServerManager, runner: RunManager):
        self.benchmark = benchmark
        self.blockchain = blockchain
        self.server = server
        self.runner = runner
        self._job_lock = threading.Lock()
        self._running_jobs = set()

    # mediator methods here...
    def run(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        scores = self.benchmark.do_benchmark()
        # failures terminate with error
        self.server.post_benchmark(scores)

        # Advertise immediately, then renew independently of slow chain requests.
        self._heartbeat()
        heartbeat_errors = []

        def keep_available():
            while not stop_event.wait(HEARTBEAT_INTERVAL_SECONDS):
                try:
                    self._heartbeat()
                except requests.RequestException as error:
                    heartbeat_errors.append(error)
                    stop_event.set()
                    return

        worker = threading.Thread(target=keep_available, name='provider-heartbeat', daemon=True)
        worker.start()
        try:
            while not stop_event.is_set():
                events = self.blockchain.pollEvents()
                for event in events:
                    if stop_event.is_set():
                        break
                    self._handle_event(event)
                stop_event.wait(1)
        finally:
            stop_event.set()
            worker.join()  # finish any bounded HTTP request before closing sessions
        if heartbeat_errors:
            raise heartbeat_errors[0]

    def _heartbeat(self) -> None:
        try:
            self.server.heartbeat()
        except requests.RequestException as error:
            status = error.response.status_code if error.response is not None else None
            if status in (401, 403) or isinstance(error, requests.exceptions.SSLError):
                raise
            print("Provider heartbeat failed; retrying in 10 seconds.", file=sys.stderr)

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
        try:
            manifest = self.server.getDockerManifest(jobId)
            self.runner.prepareJob(manifest, jobId)
        except Exception as error:
            self._report_error(jobId, f'Job preparation failed: {error}')

    def handleCommitPhaseStart(self, jobId, deadline):
        with self._job_lock:
            # Commit-phase events are broadcast to every provider, including
            # machines that were not selected for this job.
            if self.runner.currentJobId != jobId or jobId in self._running_jobs:
                return
            self._running_jobs.add(jobId)
        threading.Thread(target=self._runAndCommit, args=(jobId, deadline), daemon=True).start()

    def _report_error(self, jobId, message):
        print(f'Job {jobId}: {message}', file=sys.stderr)
        try:
            self.server.report_error(jobId, message)
        except requests.RequestException as error:
            print(f'Job {jobId}: error report failed: {error}', file=sys.stderr)

    def _runAndCommit(self, jobId, deadline):
        try:
            result = self.runner.startJob(jobId, deadline)
            if result.status == 'ok' and result.output_dir:
                print(f"Result was obtained: {result.output_dir}")
                self.blockchain.commit(jobId, self.runner.hash_dir(result.output_dir))
            else:
                details = getattr(result, 'message', None) or 'No output was produced.'
                self._report_error(jobId, f'Execution {result.status} (exit code {result.exitCode}): {details}')
        except Exception as error:
            self._report_error(jobId, f'Execution or commitment failed: {error}')
        finally:
            with self._job_lock:
                self._running_jobs.discard(jobId)
