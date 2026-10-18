# job manager that is called by provider client
import docker 
from docker.errors import ImageNotFound
from requests.exceptions import ConnectionError, ReadTimeout
from pathlib import Path
import os
from job.JobResult import JobResult
import hashlib

class RunManager():
    def __init__(self):
        self.isActive = False # starts out not running anything
        self.currentJobId = None
        self.currentManifest = None
        self.client = docker.from_env()
        self.jobs_dir = Path.home() / '.offbalance' / 'jobs'
        self.out_dir = None

    def prepareJob(self, manifest, jobId):
        self.currentJobId = jobId
        self.currentManifest = manifest
        self.out_dir = self.jobs_dir / str(jobId) / 'output'
        self.out_dir.mkdir(parents=True, exist_ok = True)


    def startJob(self, jobId: int, deadline: int): 
        if jobId != self.currentJobId or self.currentManifest == None or self.out_dir == None:
            raise Exception("Current jobId does not match the job I need to start. Did you load it from the server first?")

        print(f"Running Job: {jobId}")
        
        self.isActive = True

        image = self.currentManifest['image']

        try:
            self.client.images.get(image)
        except ImageNotFound:
            self.client.images.pull(image)

        env = dict(self.currentManifest.get('env') or {})
        if self.currentManifest.get('input_url'):
            env['INPUT_URL'] = self.currentManifest['input_url']

        container = self.client.containers.run(
            image,
            command = self.currentManifest['command'],
            environment=env,
            network_disabled = not self.currentManifest.get('input_url'),
            volumes={str(self.out_dir): {'bind': '/output', 'mode': 'rw'}},
            user = f"{os.getuid()}:{os.getgid()}",
            detach=True,
        )

        try:
            result = container.wait(timeout = deadline)
        
        except (ReadTimeout, ConnectionError):
            container.kill()
            return JobResult(status="timeout")

        container.reload()
        if container.attrs['State']['OOMKilled']:
            return JobResult(status='oom')
        if result['StatusCode'] != 0:
            return JobResult(status='failed', exitCode=result['StatusCode'])
        
        return JobResult(status='ok', output_dir=self.out_dir)
        

    # deterministic sha256 over the contents of out_dir, so every honest provider
    # that ran the same image gets the same digest. Only relative paths and file
    # bytes count: mtimes, permissions, owners and empty dirs are ignored.
    @staticmethod
    def hash_dir(out_dir: Path) -> bytes:
        out_dir = Path(out_dir)
        outer = hashlib.sha256()

        # sorted POSIX-style relative paths, so walk order and OS don't matter
        entries = sorted(
            (p.relative_to(out_dir).as_posix(), p)
            for p in out_dir.rglob('*')
            if p.is_symlink() or p.is_file()
        )
        for rel, path in entries:
            # never follow symlinks: the container wrote them, and a link to e.g.
            # /etc/passwd would get resolved on this machine, not inside the container
            if path.is_symlink():
                kind, digest = b'L', hashlib.sha256(os.readlink(path).encode()).digest()
            else:
                kind, digest = b'F', RunManager._hash_file(path)

            # length-prefix the path so ("a", "bc") and ("ab", "c") can't collide
            rel_bytes = rel.encode('utf-8')
            outer.update(kind)
            outer.update(len(rel_bytes).to_bytes(8, 'big'))
            outer.update(rel_bytes)
            outer.update(digest)

        # 32 bytes, fits a bytes32 commitment directly
        return outer.digest()

    @staticmethod
    def _hash_file(path: Path) -> bytes:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        return h.digest()
