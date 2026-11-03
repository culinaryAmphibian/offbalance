"""Bounded result archives; output links are recorded, never followed."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
import tempfile

MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_ENTRIES = 1000


def _safe_path(value):
    if not value or value.startswith('/') or '\\' in value or (len(value) > 1 and value[0].isascii() and value[0].isalpha() and value[1] == ':') or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Result archive contains an unsafe path.')
    if any(part in ('', '.', '..') for part in value.split('/')):
        raise ValueError('Result archive contains an unsafe path.')
    if len(value.encode('utf-8', errors='strict')) > 4096:
        raise ValueError('Result archive path is too long.')


class _BoundedWriter:
    def __init__(self, output, limit):
        self.output, self.limit = output, limit

    def write(self, data):
        if self.output.tell() + len(data) > self.limit:
            raise ValueError('Result archive exceeds the upload size limit.')
        return self.output.write(data)

    def __getattr__(self, name):
        return getattr(self.output, name)


class _HashingReader:
    def __init__(self, source, stop):
        self.source, self.stop = source, stop
        self.hash = hashlib.sha256()

    def read(self, size):
        self.stop()
        data = self.source.read(size)
        self.hash.update(data)
        return data


@contextmanager
def result_archive(output_dir, expected_hash, stop_event=None, max_bytes=MAX_ARCHIVE_BYTES, max_entries=MAX_ENTRIES):
    """Yield (private temporary file, byte length) only after its bytes match the commitment."""
    def check_stop():
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError('Provider stopped during result delivery.')

    check_stop()
    root_fd = os.open(Path(output_dir), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        entries, visited = [], 0

        def collect(directory, prefix=''):
            nonlocal visited
            with os.scandir(directory) as children:
                for child in children:
                    check_stop()
                    visited += 1
                    if visited > max_entries:
                        raise ValueError('Result archive has too many entries.')
                    name = prefix + child.name
                    _safe_path(name)
                    mode = child.stat(follow_symlinks=False).st_mode
                    if stat.S_ISDIR(mode):
                        fd = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        try:
                            collect(fd, name + '/')
                        finally:
                            os.close(fd)
                    elif stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                        entries.append(name)
                    else:
                        raise ValueError('Result output contains an unsupported special file.')

        collect(root_fd)
        digest = hashlib.sha256()
        with tempfile.TemporaryFile('w+b') as output:
            with tarfile.open(fileobj=_BoundedWriter(output, max_bytes), mode='w', format=tarfile.PAX_FORMAT) as archive:
                for name in sorted(entries):
                    check_stop()
                    # Resolve every ancestor with openat/O_NOFOLLOW to avoid output link races.
                    directory = os.dup(root_fd)
                    try:
                        parts = PurePosixPath(name).parts
                        for part in parts[:-1]:
                            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                            os.close(directory)
                            directory = child
                        metadata = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                        info = tarfile.TarInfo(name)
                        info.mode = 0o644
                        if stat.S_ISLNK(metadata.st_mode):
                            target = os.readlink(parts[-1], dir_fd=directory)
                            _safe_path(target)
                            info.type, info.linkname = tarfile.SYMTYPE, target
                            archive.addfile(info)
                            kind, content_hash = b'L', hashlib.sha256(target.encode('utf-8')).digest()
                        elif stat.S_ISREG(metadata.st_mode):
                            if metadata.st_size > max_bytes:
                                raise ValueError('Result archive exceeds the upload size limit.')
                            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                            with os.fdopen(descriptor, 'rb') as source:
                                current = os.fstat(source.fileno())
                                if not stat.S_ISREG(current.st_mode) or current.st_size != metadata.st_size:
                                    raise ValueError('Result changed while packaging it.')
                                info.size = current.st_size
                                reader = _HashingReader(source, check_stop)
                                archive.addfile(info, reader)
                                if source.read(1):
                                    raise ValueError('Result changed while packaging it.')
                                kind, content_hash = b'F', reader.hash.digest()
                        else:
                            raise ValueError('Result output changed to an unsupported file.')
                        encoded = name.encode('utf-8')
                        digest.update(kind + len(encoded).to_bytes(8, 'big') + encoded + content_hash)
                    finally:
                        os.close(directory)
            if digest.digest() != bytes(expected_hash):
                raise ValueError('Result output differs from the committed result; refusing delivery.')
            size = output.tell()
            output.seek(0)
            yield output, size
    finally:
        os.close(root_fd)
