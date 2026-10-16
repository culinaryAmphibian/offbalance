from pathlib import Path

class JobResult():
    def __init__(self, status, exitCode=None, output_dir=None | Path):
        self.status = status
        self.exitCode = exitCode
        self.output_dir = output_dir