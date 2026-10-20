from pathlib import Path

class JobResult():
    def __init__(self, status, exitCode=None, output_dir:Path | None = None, message: str | None = None):
        self.status = status
        self.exitCode = exitCode
        self.output_dir = output_dir
        self.message = message
