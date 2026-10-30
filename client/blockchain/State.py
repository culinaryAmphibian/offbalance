"""Private, atomic provider journal. One process owns a chain/contract/signer."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading


class StateConflict(RuntimeError):
    """Recovery cannot continue safely without operator intervention."""


class ExecutionPaused(RuntimeError):
    """Execution remains journaled and can reconnect after stop/transport failure."""


class ProviderState:
    def __init__(self, identity, seed, root=None, start_block=0):
        self.identity = identity
        namespace = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.directory = Path(root or os.environ.get('OFFBALANCE_STATE_DIR', '~/.offbalance/providers')).expanduser() / namespace
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / 'state.json'
        self._mutex = threading.RLock()
        self._failed = False
        signer_identity = {key: identity.get(key) for key in ('chain_id', 'genesis', 'signer')}
        signer_hash = hashlib.sha256(json.dumps(signer_identity, sort_keys=True).encode()).hexdigest()
        self._owner = (self.directory.parent / f'.signer-{signer_hash}.lock').open('a+')
        os.chmod(self._owner.name, 0o600)
        try:
            fcntl.flock(self._owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._owner.close()
            raise StateConflict('Another provider process already owns this signer on this chain.') from None
        fingerprint = hashlib.sha256(seed).hexdigest()
        try:
            if self.path.exists():
                self._data = json.loads(self.path.read_text())
                if self._data.get('version') != 1 or self._data.get('identity') != identity:
                    raise StateConflict('Provider journal identity/version does not match.')
                if self._data.get('seed_fingerprint') != fingerprint:
                    raise StateConflict('Commitment seed changed. Restore the seed used for this provider journal.')
            else:
                self._data = dict(version=1, identity=identity, seed_fingerprint=fingerprint,
                                  next_block=start_block, anchors=[], jobs={}, transactions={})
                self._write(self._data)
        except BaseException:
            self.close()
            raise

    def _write(self, data):
        descriptor, name = tempfile.mkstemp(prefix='.state-', dir=self.directory)
        try:
            with os.fdopen(descriptor, 'w') as output:
                json.dump(data, output, sort_keys=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, self.path)
            directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def snapshot(self):
        with self._mutex:
            if self._failed:
                raise StateConflict('Provider journal write failed; restart to reconcile disk state.')
            return copy.deepcopy(self._data)

    def update(self, change):
        with self._mutex:
            if self._failed or self._owner.closed:
                raise StateConflict('Provider journal is closed or a write failed; restart to recover.')
            data = copy.deepcopy(self._data)
            change(data)
            try:
                self._write(data)
            except BaseException:
                # replace may already have succeeded: never overwrite uncertain disk state.
                self._failed = True
                raise
            self._data = data

    def job(self, job_id):
        return self.snapshot()['jobs'].get(str(job_id), {})

    def save_job(self, job_id, **fields):
        self.update(lambda data: data['jobs'].setdefault(str(job_id), {}).update(fields))

    def save_transaction(self, operation, **fields):
        self.update(lambda data: data['transactions'].setdefault(operation, {}).update(fields))

    def close(self):
        if not self._owner.closed:
            self._owner.close()
