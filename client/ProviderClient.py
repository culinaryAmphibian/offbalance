# mediator design pattern - holds references to all managers and governs their interactions
from __future__ import annotations

from typing import TYPE_CHECKING
from blockchain.EventData import *
import requests
import sys
import threading

from blockchain.Contract import TransactionRetry, TransactionReverted
from blockchain.State import ExecutionPaused
from web3.exceptions import Web3RPCError

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
        self._executing = False
        self._workers = set()
        self._stop_event = None

    # mediator methods here...
    def run(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        self._stop_event = stop_event
        self.runner.stop_event = stop_event
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
                try:
                    events = self.blockchain.pollEvents()
                    for event in events:
                        if stop_event.is_set():
                            break
                        self._handle_event(event)
                    else:
                        # Handlers persisted their work before this checkpoint advances.
                        self.blockchain.acknowledgeEvents()
                    self._resume_jobs()
                except (requests.RequestException, TransactionRetry, TransactionReverted, Web3RPCError) as error:
                    print(f'Provider recovery will retry: {error}', file=sys.stderr)
                stop_event.wait(1)
        finally:
            stop_event.set()
            worker.join()  # finish any bounded HTTP request before closing sessions
            # Finish container/transaction work before releasing the state lock.
            for job_worker in list(self._workers):
                job_worker.join()
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
            # recovery_actions checks the current phase and durable opening before sending.

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
        try:
            manifest = self.server.getDockerManifest(jobId) if self.blockchain.needs_manifest(jobId) else None
            self.blockchain.remember_assignment(jobId, manifest)
        except Exception as error:
            self._report_error(jobId, f'Job preparation failed: {error}')
            raise  # Do not acknowledge a selection whose work was not persisted.

    def handleCommitPhaseStart(self, jobId, deadline):
        self.blockchain.request_execution(jobId)

    def _resume_jobs(self):
        if self._stop_event is not None and self._stop_event.is_set():
            return
        for job_id, action, remaining in self.blockchain.recovery_actions():
            with self._job_lock:
                if job_id in self._running_jobs or (action == 'execute' and self._executing):
                    continue
                self._running_jobs.add(job_id)
                if action == 'execute':
                    self._executing = True
                worker = threading.Thread(target=self._recover_job, args=(job_id, action, remaining), daemon=True)
                self._workers.add(worker)
                worker.start()

    def _recover_job(self, job_id, action, remaining):
        try:
            if self._stop_event is not None and self._stop_event.is_set():
                return
            if action == 'execute':
                self.runner.prepareJob(self.blockchain.state.job(job_id)['manifest'], job_id)
                self._runAndCommit(job_id, remaining)
            elif action == 'commit':
                result = bytes.fromhex(self.blockchain.state.job(job_id)['result'])
                self.blockchain.commit(job_id, result)
            elif action == 'reveal':
                self.blockchain.reveal(job_id)
            elif action == 'cleanup':
                self.runner.cleanupJob(job_id)
        except ExecutionPaused as error:
            print(f'Job {job_id}: {error}', file=sys.stderr)
        except Exception as error:
            self._report_error(job_id, f'Recovery {action} failed: {error}')
        finally:
            with self._job_lock:
                self._running_jobs.discard(job_id)
                if action == 'execute':
                    self._executing = False
                self._workers.discard(threading.current_thread())

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
                result_hash = self.runner.hash_dir(result.output_dir, self._stop_event)
                if self._stop_event is not None and self._stop_event.is_set():
                    raise ExecutionPaused('Provider stopping; completed output retained for commitment.')
                self.blockchain.commit(jobId, result_hash)
            else:
                details = getattr(result, 'message', None) or 'No output was produced.'
                self.blockchain.state.save_job(jobId, execution_failed=True)
                self._report_error(jobId, f'Execution {result.status} (exit code {result.exitCode}): {details}')
        except ExecutionPaused as error:
            print(f'Job {jobId}: {error}', file=sys.stderr)
        except Exception as error:
            self._report_error(jobId, f'Execution or commitment failed: {error}')
        finally:
            with self._job_lock:
                self._running_jobs.discard(jobId)
