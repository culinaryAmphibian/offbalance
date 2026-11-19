# mediator design pattern - holds references to all managers and governs their interactions
from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING
from benchmark.HardwareProfile import GpuInfo
from blockchain.EventData import *
import requests
import sys
import threading
import time
from server.ServerManager import DeliveryError
from blockchain.Contract import TransactionFailed, TransactionRetry
from blockchain.State import ExecutionPaused, ProviderState
from web3.exceptions import Web3RPCError

if TYPE_CHECKING:
    from benchmark.BenchmarkManager import BenchmarkManager
    from blockchain.BlockchainManager import BlockchainManager
    from server.ServerManager import ServerManager
    from job.RunManager import RunManager
    from Credentials import Credentials

HEARTBEAT_INTERVAL_SECONDS = 10
# leave this long before the commit deadline for the commitment transaction to land
COMMIT_MARGIN_SECONDS = 2
RECOVERY_RETRY_ERRORS = (requests.RequestException, TransactionRetry, TransactionFailed, Web3RPCError)

class WalletMismatch(RuntimeError):
    pass

class ProviderClient():
    def __init__(self, benchmark: BenchmarkManager, blockchain: BlockchainManager, server: ServerManager, runner: RunManager,
                 credentials: Credentials | None = None):
        # API key + session key + owner wallet, collected at startup; the managers were built from these
        self.credentials = credentials
        self.benchmark = benchmark
        self.blockchain = blockchain
        self.server = server
        self.runner = runner
        self._job_lock = threading.Lock()
        self._running_jobs = set()
        self._results = {}
        self._delivering = set()
        self._stop_event = None
        self._workers = set()
        journal = getattr(blockchain, 'state', None)
        self._state = journal if isinstance(journal, ProviderState) else None

    # mediator methods here...
    def run(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        self._stop_event = stop_event
        heartbeat_worker = None
        heartbeat_errors = []

        def keep_available():
            while not stop_event.wait(HEARTBEAT_INTERVAL_SECONDS):
                try:
                    self._heartbeat()
                except requests.RequestException as error:
                    heartbeat_errors.append(error)
                    stop_event.set()
                    return

        try:
            if self._state is not None:
                self.runner.enable_recovery(self._state, stop_event)
                cached_gpus = self._state.snapshot().get('registered_gpus')
                if cached_gpus is not None:
                    self.runner.gpus = [GpuInfo(**gpu) for gpu in cached_gpus]
                    self._recover_before_registration(stop_event)
                    if stop_event.is_set():
                        return

            profile = self.benchmark.do_benchmark()
            self.server.post_benchmark(profile)
            self._check_wallet_matches()
            # Only cache hardware after successful authenticated registration.
            if self.runner is not None:
                self.runner.gpus = [gpu for gpu in profile.gpus if gpu.usable]
                if self._state is not None:
                    gpus = [asdict(gpu) for gpu in self.runner.gpus]
                    self._state.update(lambda data: data.update(registered_gpus=gpus))

            # Advertise only once registration succeeds, then renew independently.
            self._heartbeat()
            heartbeat_worker = threading.Thread(target=keep_available, name='provider-heartbeat', daemon=True)
            heartbeat_worker.start()
            next_assignment_check = 0
            while not stop_event.is_set():
                try:
                    self._poll_events(stop_event)
                    if self._state is not None and not stop_event.is_set():
                        active = self._resume_jobs()
                        if not active and time.monotonic() >= next_assignment_check:
                            self._restore_assignment()
                            next_assignment_check = time.monotonic() + HEARTBEAT_INTERVAL_SECONDS
                except RECOVERY_RETRY_ERRORS as error:
                    if self._state is None:
                        raise
                    print(f'Recovery will retry ({type(error).__name__}).', file=sys.stderr)
                stop_event.wait(1)
        finally:
            stop_event.set()
            if heartbeat_worker is not None:
                heartbeat_worker.join()
            with self._job_lock:
                workers = list(self._workers)
            for job_worker in workers:
                job_worker.join()
        if heartbeat_errors:
            raise heartbeat_errors[0]

    def _recover_before_registration(self, stop_event):
        # Benchmarking or a slow registration should never consume an active job's deadline.
        # Continue polling even when the job has no action until the next on-chain phase.
        while not stop_event.is_set():
            try:
                self._poll_events(stop_event)
                if not self._resume_jobs():
                    return
            except RECOVERY_RETRY_ERRORS as error:
                print(f'Existing job recovery will retry ({type(error).__name__}).', file=sys.stderr)
            stop_event.wait(1)

    def _poll_events(self, stop_event):
        for event in self.blockchain.pollEvents():
            if stop_event.is_set():
                return
            if self._state is None:
                self._handle_event(event)
            elif isinstance(event, ProviderSelectedEvent) and event.provider_selected.lower() == self.blockchain.owner.lower():
                self.blockchain.remember_assignment(event.jobId, event.block_number, event.block_hash)
        if self._state is not None:
            self.blockchain.acknowledgeEvents()

    def _restore_assignment(self):
        # Covers upgrades from a client that had no journal yet. Chain state must still
        # confirm this assignment before any work, stake, or commitment can be sent.
        try:
            job_id = self.server.get_active_assignment()
        except requests.RequestException as error:
            print(f'Assignment lookup failed ({type(error).__name__}); continuing chain recovery.', file=sys.stderr)
            return
        if job_id is not None:
            self.blockchain.remember_assignment(job_id)

    def _resume_jobs(self):
        active_job = False
        for job_id, action, remaining in self.blockchain.recovery_actions(include_waiting=True):
            active_job = True
            if action == 'wait':
                continue
            with self._job_lock:
                # Recovery runs one job action at a time; the others wait for the next poll.
                if self._workers or job_id in self._running_jobs:
                    continue
                self._running_jobs.add(job_id)
                worker = threading.Thread(target=self._recover_job, args=(job_id, action, remaining), daemon=True)
                self._workers.add(worker)
                worker.start()
        with self._job_lock:
            return active_job or bool(self._workers)

    def _recover_job(self, job_id, action, remaining):
        try:
            if self._stop_event.is_set():
                return
            if action != 'cleanup':
                self.blockchain.assert_assignment_identity(job_id)
            if action == 'stake':
                self.blockchain.stake(job_id, remaining)
            elif action == 'execute':
                job = self._state.job(job_id)
                manifest = job.get('manifest')
                if manifest is None:
                    started = time.monotonic()
                    manifest = self.server.getDockerManifest(job_id)
                    self._state.save_job(job_id, manifest=manifest)
                    remaining -= time.monotonic() - started
                remaining -= COMMIT_MARGIN_SECONDS
                if remaining > 0:
                    self.blockchain.assert_assignment_identity(job_id)
                    self.runner.prepareJob(manifest, job_id)
                    self._runAndCommit(job_id, remaining)
            elif action == 'commit':
                self.blockchain.commit(job_id, bytes.fromhex(self._state.job(job_id)['result']))
            elif action == 'reveal':
                self.blockchain.reveal(job_id)
            elif action == 'deliver':
                result = bytes.fromhex(self._state.job(job_id)['result'])
                self._deliverResult(job_id, self.runner.output_directory(job_id), result, remaining)
            elif action == 'cleanup':
                self.runner.cleanupJob(job_id)
        except RECOVERY_RETRY_ERRORS as error:
            print(f'Job {job_id}: {action} will retry ({type(error).__name__}).', file=sys.stderr)
        except Exception as error:
            self._report_error(job_id, f'Recovery {action} failed: {error}')
        finally:
            with self._job_lock:
                self._running_jobs.discard(job_id)
                self._workers.discard(threading.current_thread())

    # The server assigns jobs to the wallet the API key was issued to; the session key acts for
    # credentials.owner. If those differ, this machine would never see its own assignments.
    def _check_wallet_matches(self) -> None:
        if self.credentials is None or self.credentials.owner is None:
            return
        api_wallet = self.server.get_hardware_address()
        if api_wallet is not None and api_wallet.lower() != self.credentials.owner.lower():
            raise WalletMismatch(
                f"The API key belongs to wallet {api_wallet}, but the session key acts for {self.credentials.owner}. "
                "Sign in to the frontend with the wallet that authorized this session key and copy its API key."
            )

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
            if str(event.provider_selected).lower() == str(self.blockchain.owner).lower():
                self.handleAssignment(event.jobId, event.stake)

        elif isinstance(event, CommitPhaseStartEvent):
            print("Handling commit phase start")
            self.handleCommitPhaseStart(event.jobId, block_number=event.block_number, commit_deadline=event.commit_deadline)

        elif isinstance(event, RevealPhaseStartEvent):
            print("Handling reveal phase start")
            self.blockchain.reveal(event.jobId)

        elif isinstance(event, DeliveryPhaseStartEvent):
            print("Handling delivery phase start")
            self.handleDeliveryPhaseStart(event.jobId)

        elif isinstance(event, (DeliveredEvent, CanceledEvent, NoQuorumEvent)):
            # The job is over on chain: nothing left to run for it.
            print(f"Handling end of job ({type(event).__name__})")
            self.runner.forgetJob(event.jobId)

        else:    
            raise ValueError(f"Unknown event of type: {event.type}")
        
        # here, will need to mux the events and orchestrate client workflow
    
    # Stake first: an unstaked provider is dropped when staking closes, so there's nothing to prepare.
    def handleAssignment(self, jobId, stake=0):
        print(f"Handling assignment for: {jobId} (stake {stake} wei)")
        try:
            self.blockchain.stake(jobId, stake)
        except Exception as error:
            self._report_error(jobId, f'Staking failed: {error}')
            return
        try:
            manifest = self.server.getDockerManifest(jobId)
            self.runner.prepareJob(manifest, jobId)
        except Exception as error:
            self._report_error(jobId, f'Job preparation failed: {error}')

    # deadline: seconds the container may run. Otherwise it's derived from commit_deadline (the
    # event's chain-time deadline, less time for the commitment to land), or else from the
    # manifest timeout counted from the event's block.
    def handleCommitPhaseStart(self, jobId, deadline=None, block_number=None, commit_deadline=None):
        with self._job_lock:
            # Commit-phase events are broadcast to every provider, including
            # machines that were not selected for this job.
            manifest = self.runner.manifests.get(jobId)
            if manifest is None or jobId in self._running_jobs:
                return
            if deadline is None and commit_deadline is not None:
                try:
                    deadline = self.blockchain.seconds_until(commit_deadline) - COMMIT_MARGIN_SECONDS
                except Exception:
                    self._report_error(jobId, 'Cannot read the commit deadline.')
                    return
            if deadline is None:
                try:
                    deadline = self.blockchain.execution_window(block_number, manifest['timeout_s'])
                except Exception:
                    self._report_error(jobId, 'Cannot read the commit execution window.')
                    return
            if deadline <= 0:
                self._report_error(jobId, 'The commit execution window has expired; execution was skipped.')
                return
            self._running_jobs.add(jobId)
        threading.Thread(target=self._runAndCommit, args=(jobId, deadline), daemon=True).start()

    def handleDeliveryPhaseStart(self, job_id):
        with self._job_lock:
            result = self._results.get(job_id)
            if result is None or job_id in self._delivering:
                return
            self._delivering.add(job_id)
        threading.Thread(target=self._deliverResult, args=(job_id, *result), daemon=True).start()

    # The delivery window is 30s on chain; stop retrying a little before it closes.
    DELIVERY_RETRY_S = 25
    DELIVERY_RETRY_INTERVAL_S = 2

    def _deliverResult(self, job_id, output_dir, result_hash, remaining=DELIVERY_RETRY_S):
        give_up_at = time.monotonic() + min(remaining, self.DELIVERY_RETRY_S)
        stop = self._stop_event or threading.Event()
        try:
            while True:
                try:
                    self.server.deliver_result(job_id, output_dir, result_hash, self._stop_event)
                    if self._state is not None:
                        self._state.save_job(job_id, delivered=True)
                    print(f'Job {job_id}: result delivered.')
                    return
                except DeliveryError as error:
                    # The client sees DELIVERY_PHASE_START about when the server does, so the
                    # first upload can land before the server opens the job for delivery (409).
                    if not error.retryable and self._state is not None:
                        self._state.save_job(job_id, delivery_failed=True)
                    if not error.retryable or time.monotonic() >= give_up_at or stop.is_set():
                        print(f'Job {job_id}: result delivery failed: {error}', file=sys.stderr)
                        return
                    print(f'Job {job_id}: result delivery not accepted yet ({error}); retrying', file=sys.stderr)
                    stop.wait(self.DELIVERY_RETRY_INTERVAL_S)
                except Exception as error:
                    # Other errors can carry credentials; report only the type.
                    print(f'Job {job_id}: result delivery failed ({type(error).__name__}).', file=sys.stderr)
                    return
        finally:
            with self._job_lock:
                self._delivering.discard(job_id)

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
                result_hash = (self.runner.hash_dir(result.output_dir, self._stop_event)
                               if self._state is not None else self.runner.hash_dir(result.output_dir))
                self.blockchain.commit(jobId, result_hash)
                with self._job_lock:
                    self._results[jobId] = (result.output_dir, result_hash)
            else:
                details = getattr(result, 'message', None) or 'No output was produced.'
                self._report_error(jobId, f'Execution {result.status} (exit code {result.exitCode}): {details}')
        except ExecutionPaused as error:
            print(f'Job {jobId}: {error}', file=sys.stderr)
        except RECOVERY_RETRY_ERRORS as error:
            if self._state is None:
                self._report_error(jobId, f'Execution or commitment failed: {error}')
            else:
                print(f'Job {jobId}: execution or commitment will retry ({type(error).__name__}).', file=sys.stderr)
        except Exception as error:
            self._report_error(jobId, f'Execution or commitment failed: {error}')
        finally:
            with self._job_lock:
                self._running_jobs.discard(jobId)
