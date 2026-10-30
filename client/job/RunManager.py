# job manager that is called by provider client
import docker 
from docker.errors import ImageNotFound, NotFound, APIError
from requests.exceptions import ConnectionError, ReadTimeout
from pathlib import Path
import os
from job.JobResult import JobResult
import hashlib
import shutil
import time
import threading
from blockchain.State import StateConflict, ExecutionPaused

class RunManager():
    def __init__(self):
        self.isActive = False # starts out not running anything
        self.currentJobId = None
        self.currentManifest = None
        self.client = docker.from_env(timeout=5)
        self.jobs_dir = Path.home() / '.offbalance' / 'jobs'
        self.out_dir = None
        self.state = None
        self.stop_event = threading.Event()

    def prepareJob(self, manifest, jobId):
        self.currentJobId = None
        self.currentManifest = None
        self.out_dir = None
        out_dir = self.jobs_dir / str(jobId) / 'output'
        out_dir.mkdir(parents=True, exist_ok=True)
        self.currentJobId = jobId
        self.currentManifest = manifest
        self.out_dir = out_dir


    def container_user(self):
        # Rootless container root maps to the ordinary user running the daemon.
        options = self.client.info().get('SecurityOptions') or []
        if any(option.split(',')[0] == 'name=rootless' for option in options):
            return '0:0'
        return f"{os.getuid()}:{os.getgid()}"

    @staticmethod
    def _remove_container(container):
        if container is not None:
            container.remove(force=True)

    @staticmethod
    def _logs(container):
        return container.logs(tail=20).decode('utf-8', errors='replace')[-2000:]

    def _pull_image(self, image, expires):
        # Docker's streaming pull has no overall timeout. The helper only downloads;
        # it cannot create a container, sign a transaction or touch the journal.
        finished = threading.Event()
        errors = []
        def pull():
            try:
                self.client.images.pull(image)
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()
        threading.Thread(target=pull, name='provider-image-pull', daemon=True).start()
        while not finished.wait(0.1):
            if self.stop_event.is_set():
                raise ExecutionPaused('Provider stopping during image download; no job container was started.')
            if time.time() >= expires:
                raise ExecutionPaused('Image download exceeded the execution window; no job container was started.')
        if errors:
            raise errors[0]

    def _execution(self, job_id, **fields):
        if self.state is not None:
            record = self.state.job(job_id).get('execution', {})
            record.update(fields)
            self.state.save_job(job_id, execution=record)

    def _check_daemon(self):
        daemon_id = self.client.info().get('ID')
        if not isinstance(daemon_id, str) or not daemon_id:
            raise StateConflict('Docker daemon identity is unavailable; refusing unsafe execution recovery.')
        saved = self.state.snapshot().get('docker_daemon')
        if saved is not None and saved != daemon_id:
            raise StateConflict('Docker daemon changed; recover the original daemon before resuming this journal.')
        if saved is None:
            self.state.update(lambda data: data.update(docker_daemon=daemon_id))

    def _labels(self, job_id):
        return {'offbalance.provider': self.state.directory.name, 'offbalance.job': str(job_id)}

    def _existing_container(self, name, job_id):
        try:
            container = self.client.containers.get(name)
        except NotFound:
            return None
        labels = container.attrs.get('Config', {}).get('Labels') or {}
        if any(labels.get(key) != value for key, value in self._labels(job_id).items()):
            raise StateConflict(f'Container {name} is not owned by this provider/job journal.')
        return container

    def cleanupJob(self, job_id):
        self._check_daemon()
        execution = self.state.job(job_id).get('execution', {})
        name = execution.get('container')
        if name:
            self._remove_container(self._existing_container(name, job_id))
            self._execution(job_id, cleaned=True)

    def startJob(self, jobId: int, deadline: int):
        if jobId != self.currentJobId or self.currentManifest is None or self.out_dir is None:
            raise RuntimeError('Load the assigned job manifest before starting it.')
        if deadline <= 0:
            raise ValueError('Execution window must be positive.')
        self.isActive = True
        container = None
        preserve = False
        try:
            if self.stop_event.is_set():
                preserve = True
                raise ExecutionPaused('Provider stopping; execution will resume from its journal.')
            execution = self.state.job(jobId).get('execution', {}) if self.state is not None else {}
            name = execution.get('container')
            if self.state is not None:
                self._check_daemon()
                name = name or f'offbalance-{self.state.directory.name[:24]}-{jobId}'
                container = self._existing_container(name, jobId)
                if execution.get('status') == 'ready':
                    return JobResult(status='ok', output_dir=self.out_dir)
                if execution.get('status') == 'failed':
                    return JobResult(status='failed', message='Previous execution failed; it will not be rerun automatically.')
            expires = execution.get('expires', time.time() + deadline)
            # Store the identity before Docker create, so a crash after create can reconnect.
            self._execution(jobId, container=name, expires=expires, status='running', cleaned=False)
            if container is None:
                if self.state is not None:
                    # No managed container can still write here. Never mix two attempts' output.
                    shutil.rmtree(self.out_dir)
                    self.out_dir.mkdir()
                if time.time() >= expires:
                    self._execution(jobId, status='failed')
                    return JobResult(status='timeout', message='Execution deadline passed while the provider was stopped.')
                image = self.currentManifest['image']
                try:
                    self.client.images.get(image)
                except ImageNotFound:
                    self._pull_image(image, expires)
                options = {}
                if self.state is not None:
                    options = dict(name=name, labels=self._labels(jobId))
                env = dict(self.currentManifest.get('env') or {})
                if self.currentManifest.get('input_url'):
                    env['INPUT_URL'] = self.currentManifest['input_url']
                if self.stop_event.is_set():
                    raise ExecutionPaused('Provider stopping; no job container was started.')
                if time.time() >= expires:
                    self._execution(jobId, status='failed')
                    return JobResult(status='timeout', message='Execution deadline passed during preparation.')
                container = self.client.containers.run(
                    image, command=self.currentManifest['command'], environment=env,
                    network_disabled=not self.currentManifest.get('input_url'),
                    volumes={str(self.out_dir): {'bind': '/output', 'mode': 'rw'}},
                    user=self.container_user(), detach=True, **options,
                )
            while True:
                if self.stop_event.is_set():
                    preserve = True
                    raise ExecutionPaused('Provider stopping; detached container retained for restart.')
                remaining = min(deadline, expires - time.time())
                if remaining <= 0:
                    self._execution(jobId, status='failed')
                    return JobResult(status='timeout', message='Container exceeded its execution window.')
                try:
                    result = container.wait(timeout=min(remaining, 1))
                    break
                except ReadTimeout:
                    # A bounded long-poll timing out is not an execution timeout.
                    self.stop_event.wait(min(0.05, remaining))
            container.reload()
            if container.attrs['State'].get('OOMKilled'):
                self._execution(jobId, status='failed')
                return JobResult(status='oom', message='Container was killed for exceeding memory.')
            if result['StatusCode'] != 0:
                self._execution(jobId, status='failed')
                return JobResult(status='failed', exitCode=result['StatusCode'], message=self._logs(container))
            # This precedes removal and hashing; restart can reuse output without rerunning.
            self._execution(jobId, status='ready')
            return JobResult(status='ok', output_dir=self.out_dir)
        except (ConnectionError, ReadTimeout) as error:
            preserve = True
            raise ExecutionPaused('Docker transport interrupted; container retained for recovery.') from error
        except APIError as error:
            if error.response is not None and error.response.status_code >= 500:
                preserve = True
                raise ExecutionPaused('Docker daemon unavailable; container retained for recovery.') from error
            raise
        finally:
            try:
                if not preserve:
                    self._remove_container(container)
                if not preserve and container is not None and self.state is not None and self.state.job(jobId).get('execution'):
                    self._execution(jobId, cleaned=True)
            finally:
                self.isActive = False

    # deterministic sha256 over the contents of out_dir, so every honest provider
    # that ran the same image gets the same digest. Only relative paths and file
    # bytes count: mtimes, permissions, owners and empty dirs are ignored.
    @staticmethod
    def hash_dir(out_dir: Path, stop_event=None) -> bytes:
        def check_stop():
            if stop_event is not None and stop_event.is_set():
                raise ExecutionPaused('Provider stopping during output hashing; completed output retained.')
        check_stop()
        out_dir = Path(out_dir)
        outer = hashlib.sha256()

        # sorted POSIX-style relative paths, so walk order and OS don't matter
        entries = sorted(
            (p.relative_to(out_dir).as_posix(), p)
            for p in out_dir.rglob('*')
            if check_stop() is None and (p.is_symlink() or p.is_file())
        )
        for rel, path in entries:
            check_stop()
            # never follow symlinks: the container wrote them, and a link to e.g.
            # /etc/passwd would get resolved on this machine, not inside the container
            if path.is_symlink():
                kind, digest = b'L', hashlib.sha256(os.readlink(path).encode()).digest()
            else:
                kind, digest = b'F', RunManager._hash_file(path, stop_event)

            # length-prefix the path so ("a", "bc") and ("ab", "c") can't collide
            rel_bytes = rel.encode('utf-8')
            outer.update(kind)
            outer.update(len(rel_bytes).to_bytes(8, 'big'))
            outer.update(rel_bytes)
            outer.update(digest)

        # 32 bytes, fits a bytes32 commitment directly
        return outer.digest()

    @staticmethod
    def _hash_file(path: Path, stop_event=None) -> bytes:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                if stop_event is not None and stop_event.is_set():
                    raise ExecutionPaused('Provider stopping during output hashing; completed output retained.')
                h.update(chunk)
        return h.digest()
