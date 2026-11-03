import unittest
from unittest.mock import Mock, patch
from blockchain.EventData import *
from ProviderClient import ProviderClient
from job.JobResult import JobResult
from pathlib import Path
import threading

class FakeBlockchain:
    def __init__(self, addr):
        self.address = addr
        self.owner = addr  # --dev style: the provider wallet signs for itself
        self.stakes = []
        self._pending = []
        self.reveals = []
        self.commits = []
        self.committed = threading.Event()

    def emit(self, event):
        self._pending.append(event)

    def pollEvents(self):
        events, self._pending = self._pending, []
        return events

    def stake(self, jobId, amount):
        self.stakes.append((jobId, amount))

    def commit(self, jobId, result_hash): 
        self.committed.set()
        self.commits.append((jobId, result_hash))

    def reveal(self, jobId):
        self.reveals.append(jobId)

class FakeRunner:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.currentJobId = None
        self.currentManifest = None

    def prepareJob(self, manifest, jobId):
        self.currentJobId = jobId
        self.currentManifest= manifest

    def startJob(self, jobId, deadline):
        self.started.set()
        self.release.wait(timeout=2)
        return JobResult("ok", 0, Path("output.txt"))

    def hash_dir(self, dir):
        return "bogus hash"
    

class BlockchainIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.addr = 0x1
        self.jobId = 1
        self.block = 1
        self.deadline = 1
        self.mockManifest = {"image": "alpine", "cmd": ["echo", "hi"]}

        bc = FakeBlockchain(self.addr)

        benchmark = Mock()  # dependency is not used
        server = Mock()     # 
        server.getDockerManifest.return_value = self.mockManifest
        runner = FakeRunner()
        self.client = ProviderClient(benchmark, bc, server, runner)


    # concurrency testing, more involved mock example
    def test_duplicate_commit_phase_does_not_restart_job(self):
        runner, bc = self.client.runner, self.client.blockchain
        runner.currentJobId = self.jobId
        
        with patch('ProviderClient.threading.Thread', wraps=threading.Thread) as thread_cls:
            self.client.handleCommitPhaseStart(self.jobId, self.deadline)

            self.assertTrue(runner.started.wait(timeout=1))

            self.client.handleCommitPhaseStart(self.jobId, self.deadline)
            self.assertEqual(thread_cls.call_count, 1)

        runner.release.set()
        self.assertTrue(bc.committed.wait(timeout=1))
        self.assertEqual(bc.commits, [(self.jobId, "bogus hash")])



    def test_handleAssignment_assigns_jobId_and_manifest(self):
            self.client.runner = Mock()
            event = ProviderSelectedEvent(self.block, BlockchainEvent.PROVIDER_SELECTED, self.jobId, self.addr, 123)
            self.client._handle_event(event)

            # stakes the amount fixed at assignment before preparing the job
            self.assertEqual(self.client.blockchain.stakes, [(self.jobId, 123)])
            self.client.runner.prepareJob.assert_called_once_with(self.mockManifest, self.jobId)