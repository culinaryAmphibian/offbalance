# small startup script to automate the spin-up of all of our elements
from pathlib import Path
import argparse
import json
import os
import signal
import socket
import subprocess
import threading
import urllib.request
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from uuid import uuid4
from time import sleep

ROOT = Path(__file__).resolve().parent   # repo root, wherever you run the script from
LOG_DIR = ROOT / 'logs'
LOG_DIR.mkdir(exist_ok=True)
RPC_URL = "http://127.0.0.1:8545"
CLIENT_PYTHON = str(ROOT / "client" / ".venv" / "bin" / "python")   # web3 lives in the client venv

def start(name, cmd, subdir, env=None):
    log = open(LOG_DIR / f"{name}.log", "w", encoding="utf-8")
    return subprocess.Popen(
        cmd,
        cwd=ROOT / subdir,          # <-- this is the "cd"
        stdin=subprocess.DEVNULL,   # don't let background services read keystrokes meant for the shell
        stdout=log,
        stderr=subprocess.STDOUT,   # put errors in the same log
        text=True,
        start_new_session=True,     # own process group, so stop() reaches npm's children too
        env={**os.environ, **(env or {})},
    )

def stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

def rpc_up():
    # same check as blockchain/scripts/dev.sh: does anything answer eth_chainId?
    req = urllib.request.Request(
        RPC_URL,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=1):
            return True
    except OSError:
        return False

def start_blockchain():
    # deploying onto an already-running node shifts the contract addresses away
    # from the ones in dev.env, so refuse instead
    if rpc_up():
        raise RuntimeError(f"something is already listening on {RPC_URL}. Stop it first (e.g. another 'hardhat node')")
    return start("blockchain", ["npx", "hardhat", "node"], "blockchain")

def wait_for_rpc(proc, timeout=60):
    for _ in range(int(timeout / 0.5)):
        if proc.poll() is not None:
            raise RuntimeError(f"hardhat node exited with code {proc.returncode} -- see {LOG_DIR / 'blockchain.log'}")
        if rpc_up():
            return
        sleep(0.5)
    raise TimeoutError(f"hardhat node not reachable at {RPC_URL} after {timeout}s")

def wait_for_port(name, proc, port, timeout=30):
    for _ in range(int(timeout / 0.5)):
        if proc.poll() is not None:
            raise RuntimeError(f"{name} exited with code {proc.returncode} -- see {LOG_DIR / f'{name}.log'}")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return
        except OSError:
            sleep(0.5)
    raise TimeoutError(f"{name} not listening on port {port} after {timeout}s")

def deploy_contracts():
    # writes blockchain/deployments/localhost.json, which the server and client read
    with open(LOG_DIR / "deploy.log", "w", encoding="utf-8") as log:
        result = subprocess.run(
            ["npx", "hardhat", "run", "scripts/deploy-local.ts", "--network", "localhost"],
            cwd=ROOT / "blockchain",
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
    if result.returncode != 0:
        raise RuntimeError(f"deploy failed with code {result.returncode} -- see {LOG_DIR / 'deploy.log'}")

def development_database():
    # A fresh Hardhat chain must not reuse jobs/checkpoints from a previous chain.
    source = urlsplit(os.environ.get("MONGODB_URI", "mongodb://127.0.0.1:27017"))
    options = dict(parse_qsl(source.query))
    if source.username and "authSource" not in options:
        options["authSource"] = source.path.strip("/") or "admin"
    database = f"offbalance_dev_{uuid4().hex}"
    return urlunsplit(source._replace(path=f"/{database}", query=urlencode(options))), database


def start_server(mongodb_uri):
    # This launcher creates a fresh local Hardhat chain; its public development
    # deployer key is the server signer. The real API persists to MongoDB.
    dev_env = dict(line.split("=", 1) for line in (ROOT / "dev.env").read_text().splitlines()
                   if line.strip() and not line.lstrip().startswith("#") and "=" in line)
    subprocess.run(["npm", "run", "seed"], cwd=ROOT / "server", check=True,
                   env={**os.environ, "MONGODB_URI": mongodb_uri})
    return start("server", ["npm", "start"], "server", env={
        "CONTRACT": "real", "CHAIN": "on", "SERVER_PRIVATE_KEY": dev_env["SERVER_PRIVATE_KEY"], "MONGODB_URI": mongodb_uri,
        "RPC_URL": RPC_URL, "PORT": "5000",
        "DEPLOYMENT_FILE": str(ROOT / "blockchain" / "deployments" / "localhost.json"),
        "TLS_KEY_FILE": str(ROOT / "server" / ".local" / "tls" / "key.pem"),
        "TLS_CERT_FILE": str(ROOT / "server" / ".local" / "tls" / "cert.pem"),
    })

def start_frontend():
    return start("frontend", ["npm", "run", "dev"], "frontend", env={
        "VITE_API_MODE": "api", "VITE_API_BASE_URL": "/api", "API_PROXY_TARGET": "https://localhost:5000",
        "API_CA_FILE": str(ROOT / "server" / ".local" / "tls" / "cert.pem"),
    })

def start_client():
    return start("client", [CLIENT_PYTHON, "-u", "main.py", "--dev"], "client", env={
        "OFFBALANCE_SERVER_URL": "https://localhost:5000", "RPC_URL": RPC_URL,
        "REQUESTS_CA_BUNDLE": str(ROOT / "server" / ".local" / "tls" / "cert.pem"),
    })  # -u: unbuffered, so prints reach client.log immediately

def watch(running):
    # report each process as it exits; returns once all of them have
    while running:
        for name, p in list(running.items()):
            code = p.poll()     # None while still running
            if code is not None:
                status = "exited cleanly" if code == 0 else f"exited with code {code}"
                print(f"[startup] {name} {status} -- see {LOG_DIR / f'{name}.log'}")
                del running[name]
        sleep(0.5)

def run_contract_shell():
    # interactive client/dev/contract_controller.py in this terminal; blocks until you exit it
    subprocess.run([CLIENT_PYTHON, str(ROOT / "client" / "dev" / "contract_controller.py")], cwd=ROOT)

def main():
    parser = argparse.ArgumentParser(description="start blockchain, server, frontend and client")
    parser.add_argument("--shell", action="store_true",
                        help="open the contract controller shell once everything is up; exiting it stops everything")
    args = parser.parse_args()

    running = {}
    try:
        # Vite loads its trusted CA at startup, before the real HTTPS API starts.
        subprocess.run(["npm", "run", "cert:dev"], cwd=ROOT / "server", check=True)
        running["blockchain"] = start_blockchain()
        running["frontend"] = start_frontend()
        wait_for_rpc(running["blockchain"])
        print("[startup] hardhat node up, deploying contracts...")
        deploy_contracts()
        print("[startup] contracts deployed")
        mongodb_uri, database = development_database()
        print(f"[startup] using fresh local database {database} (retained after shutdown)")
        running["server"] = start_server(mongodb_uri)
        wait_for_port("server", running["server"], 5000, timeout=60)
    except (RuntimeError, TimeoutError, subprocess.CalledProcessError, KeyboardInterrupt) as e:
        print(f"[startup] {e or 'interrupted'}")
        for p in running.values():
            stop(p)
        return
    running["client"] = start_client()

    print("All started...")
    try:
        if args.shell:
            threading.Thread(target=watch, args=(running,), daemon=True).start()
            run_contract_shell()
        else:
            watch(running)
    except KeyboardInterrupt:   # Ctrl+C stops everything
        pass
    for p in list(running.values()):
        stop(p)

if __name__ == '__main__':
    main()
