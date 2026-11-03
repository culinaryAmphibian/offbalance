"""Save R2 credentials locally without putting them in shell history or output."""
import getpass
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    target = root / ".env.r2.local"
    if not sys.stdin.isatty():
        raise ValueError("Run this command in an interactive terminal; credentials must not be piped.")
    ignored = subprocess.run(["git", "check-ignore", "--quiet", "--", str(target)], cwd=root)
    if ignored.returncode != 0:
        raise ValueError("Credential destination is not gitignored; refusing to write.")
    if target.exists() or target.is_symlink():
        raise ValueError(".env.r2.local already exists. Edit it privately rather than overwriting it.")
    print("Use an Object Read & Write S3 token restricted to the private OffBalance bucket.")
    account = input("Cloudflare account ID: ").strip()
    bucket = input("Private bucket name [offbalance-results]: ").strip() or "offbalance-results"
    if not re.fullmatch(r"[0-9a-fA-F]{32}", account):
        raise ValueError("Account ID must be 32 hexadecimal characters.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Use a 3-63 character lowercase bucket name with letters, digits and hyphens.")
    key = getpass.getpass("S3 Access Key ID (hidden): ").strip()
    secret = getpass.getpass("S3 Secret Access Key (hidden): ").strip()
    if not key or not secret or not all(re.fullmatch(r"[A-Za-z0-9/+_=.-]+", x) for x in (key, secret)):
        raise ValueError("Credentials are empty or contain invalid characters.")
    content = (f"RESULT_STORAGE=r2\nR2_ENABLED=true\nR2_ACCOUNT_ID={account.lower()}\n"
               f"R2_BUCKET={bucket}\nR2_ACCESS_KEY_ID={key}\nR2_SECRET_ACCESS_KEY={secret}\n")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    print("Saved server/.env.r2.local with permissions 0600. Credentials were not displayed.")
    print("Run npm run storage:check to test a tiny synthetic upload/download and cleanup.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyboardInterrupt, EOFError):
        print("Configuration not saved. Check the destination, account ID and bucket; retry in a terminal.", file=sys.stderr)
        sys.exit(1)
