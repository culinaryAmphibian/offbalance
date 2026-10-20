# DEV ONLY: interactive controller for the real OffBalance contract on the local
# Hardhat node. Every contract function becomes a command, built from the ABI,
# so it stays in sync as the contract changes. You play whichever account you
# need (buyer, server, p1..p4) with --as.
#
#   cd blockchain && npm run dev                                    # chain + deploy
#   client/.venv/bin/python client/dev/contract_controller.py       # shell
#   client/.venv/bin/python client/dev/contract_controller.py submitJob 1 100 3 2 60 img --value 100
#   (payable calls take --value WEI: submitJob escrows the price, submitCommitment posts STAKE)
import cmd
import json
import shlex
import sys
import threading
import time

from web3 import Web3
from web3.exceptions import ContractLogicError

from event_controller import REPO_ROOT, load_env

# who sends each function when --as is not given (everything else: server)
DEFAULT_SENDER = {
    "submitJob": "buyer",
    "cancelJob": "buyer",
    "submitCommitment": "p1",
    "submitReveal": "p1",
}


class ContractController(cmd.Cmd):
    intro = "OffBalance controller. 'functions' lists contract calls, 'help' for the rest."
    prompt = "offbalance> "

    def __init__(self):
        super().__init__()
        self.env = load_env(REPO_ROOT / "dev.env")
        deployment = json.loads((REPO_ROOT / self.env["OFFBALANCE_DEPLOYMENT"]).read_text())

        artifact = REPO_ROOT / "blockchain/artifacts/contracts/OffBalance.sol/OffBalance.json"
        if json.loads(artifact.read_text())["abi"] != deployment["abi"]:
            print("WARNING: OffBalance was recompiled since it was deployed. Restart `npm run dev` to redeploy.")

        self.w3 = Web3(Web3.HTTPProvider(self.env["RPC_URL"]))
        if not self.w3.is_connected():
            sys.exit(f"Can't reach node at {self.env['RPC_URL']}. Run `npm run dev` in blockchain/.")

        address = Web3.to_checksum_address(deployment["address"])
        if not self.w3.eth.get_code(address):
            sys.exit(f"No contract at {address}. Restart the node and redeploy.")
        self.contract = self.w3.eth.contract(address=address, abi=deployment["abi"])
        self.functions = {f["name"]: f for f in deployment["abi"] if f["type"] == "function"}
        self.sent = set()               # tx hashes sent from this shell; their events print inline
        self.lock = threading.Lock()    # keeps the watcher from racing a send

        # aliases -> signing accounts: server, buyer, p1..p4
        self.accounts = {
            "server": self.w3.eth.account.from_key(self.env["SERVER_PRIVATE_KEY"]),
            "buyer": self.w3.eth.account.from_key(self.env["BUYER_PRIVATE_KEY"]),
        }
        for key, value in self.env.items():
            if key.startswith("PROVIDER_") and key.endswith("_PRIVATE_KEY"):
                self.accounts[f"p{key.split('_')[1]}"] = self.w3.eth.account.from_key(value)

    # ---------- argument parsing ----------
    def resolve(self, who: str) -> str:
        if who.lower() in self.accounts:
            return self.accounts[who.lower()].address
        if Web3.is_address(who):
            return Web3.to_checksum_address(who)
        raise ValueError(f"unknown account '{who}' (use {', '.join(self.accounts)} or a 0x address)")

    def convert(self, value: str, abi_input: dict):
        # turns a command-line word into the python value web3 expects for this ABI type
        t = abi_input["type"]
        if t == "tuple":
            parts = value.split(",")
            components = abi_input["components"]
            if len(parts) != len(components):
                raise ValueError(f"{abi_input['name']} needs {len(components)} comma-separated values: {self.describe(abi_input)}")
            return tuple(self.convert(p, c) for p, c in zip(parts, components))
        if t.endswith("[]"):
            return [self.convert(v, {**abi_input, "type": t[:-2]}) for v in value.split(",") if v]
        if t.startswith(("uint", "int")):
            return int(value, 0)
        if t == "address":
            return self.resolve(value)
        if t == "bool":
            if value.lower() not in ("true", "false", "1", "0"):
                raise ValueError(f"{abi_input['name']} must be true/false, got '{value}'")
            return value.lower() in ("true", "1")
        if t.startswith("bytes"):
            return bytes.fromhex(value.removeprefix("0x"))
        return value

    def describe(self, abi_input: dict) -> str:
        if abi_input["type"] == "tuple":
            return f"{abi_input['name']}=(" + ",".join(f"{c['name']}:{c['type']}" for c in abi_input["components"]) + ")"
        return f"{abi_input['name']}:{abi_input['type']}"

    def usage(self, name: str) -> str:
        return f"{name} " + " ".join(self.describe(i) for i in self.functions[name]["inputs"])

    # ---------- contract calls ----------
    def run_function(self, name: str, words: list[str]):
        fn_abi = self.functions[name]
        sender = DEFAULT_SENDER.get(name, "server")
        if "--as" in words:
            i = words.index("--as")
            sender = words[i + 1].lower()
            del words[i:i + 2]
        value = 0
        if "--value" in words:
            i = words.index("--value")
            value = int(words[i + 1], 0)
            del words[i:i + 2]
        if len(words) != len(fn_abi["inputs"]):
            raise ValueError(f"usage: {self.usage(name)} [--as WHO] [--value WEI]")
        args = [self.convert(w, i) for w, i in zip(words, fn_abi["inputs"])]
        fn = getattr(self.contract.functions, name)(*args)

        # view functions are free reads, no transaction
        if fn_abi["stateMutability"] in ("view", "pure"):
            print(f"  {name} = {fn.call()}")
            return

        if sender not in self.accounts:
            raise ValueError(f"--as must be one of {', '.join(self.accounts)}")
        account = self.accounts[sender]
        try:
            tx = fn.build_transaction({
                "from": account.address,
                "value": value,
                "nonce": self.w3.eth.get_transaction_count(account.address),
            })
        except ContractLogicError as e:
            # gas estimation simulates the call, so a failing require shows up here
            print(f"  reverted: {e.message or 'a require() failed'} (sent as {sender})")
            return
        signed = account.sign_transaction(tx)
        with self.lock:
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            self.sent.add(tx_hash)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        block = self.w3.eth.get_block(receipt["blockNumber"])
        print(f"  {name} ok as {sender}, block {receipt['blockNumber']} @ timestamp {block['timestamp']}")
        for log in receipt["logs"]:
            event = self.contract.events[self._event_name(log)]().process_log(log)
            print(f"    {event['event']}({dict(event['args'])})")

    def _event_name(self, log) -> str:
        topic = log["topics"][0]
        for abi in self.contract.abi:
            if abi["type"] == "event":
                sig = f"{abi['name']}({','.join(i['type'] for i in abi['inputs'])})"
                if Web3.keccak(text=sig) == topic:
                    return abi["name"]
        raise ValueError(f"unknown log topic {topic.hex()}")

    # ---------- events from other senders (clients, server) ----------
    def watch_events(self, interval=1.0):
        # own Web3 so the thread doesn't share a connection with the shell
        w3 = Web3(Web3.HTTPProvider(self.env["RPC_URL"]))
        next_block = w3.eth.block_number + 1
        while True:
            time.sleep(interval)
            try:
                latest = w3.eth.block_number
                if latest < next_block:
                    continue
                with self.lock:
                    logs = w3.eth.get_logs({"address": self.contract.address, "fromBlock": next_block, "toBlock": latest})
                    for log in logs:
                        if log["transactionHash"] in self.sent:
                            continue
                        event = self.contract.events[self._event_name(log)]().process_log(log)
                        sender = w3.eth.get_transaction(log["transactionHash"])["from"]
                        print(f"\n  [block {log['blockNumber']}] {event['event']}({dict(event['args'])}) from {self.alias(sender)}")
                    if logs:
                        print(self.prompt, end="", flush=True)
                next_block = latest + 1
            except Exception as e:  # node restarting etc.; keep watching
                print(f"\n  [watcher] {e}")

    def alias(self, address: str) -> str:
        for name, account in self.accounts.items():
            if account.address == address:
                return name
        return address

    def preloop(self):
        threading.Thread(target=self.watch_events, daemon=True).start()

    def default(self, line):
        name, *words = shlex.split(line)
        if name not in self.functions:
            print(f"unknown command '{name}'. 'functions' lists contract calls, 'help' for the rest.")
            return
        self.run_function(name, words)

    def completenames(self, text, *ignored):
        return super().completenames(text, *ignored) + [n for n in self.functions if n.startswith(text)]

    def onecmd(self, line):
        try:
            return super().onecmd(line)
        except Exception as e:  # keep the shell alive on bad input
            print(f"error: {e}")

    def emptyline(self):
        pass

    # ---------- built-in commands ----------
    def do_functions(self, arg):
        "functions               list contract functions and their arguments"
        for name in sorted(self.functions):
            sender = "read" if self.functions[name]["stateMutability"] in ("view", "pure") else f"as {DEFAULT_SENDER.get(name, 'server')}"
            print(f"  {self.usage(name):<70} ({sender})")
        print("  lists: a,b,c   tuples: v1,v2,v3   accounts: server, buyer, p1..p4 or 0x..   override sender: --as WHO   send ETH: --value WEI")

    def do_advance(self, arg):
        "advance SECONDS         move chain time forward and mine a block (to pass phase deadlines)"
        seconds, = shlex.split(arg) or [""]
        self.w3.provider.make_request("evm_increaseTime", [int(seconds)])
        self.do_mine("")

    def do_mine(self, arg):
        "mine                    mine an empty block"
        self.w3.provider.make_request("evm_mine", [])
        block = self.w3.eth.get_block("latest")
        print(f"  block {block['number']} @ timestamp {block['timestamp']}")

    def do_accounts(self, arg):
        "accounts                list account aliases"
        for alias, account in self.accounts.items():
            print(f"  {alias:<7} {account.address}")
        print(f"  (contract at {self.contract.address})")

    def do_exit(self, arg):
        "exit                    quit"
        return True

    do_quit = do_exit
    do_EOF = do_exit


if __name__ == "__main__":
    controller = ContractController()
    if len(sys.argv) > 1:
        controller.onecmd(shlex.join(sys.argv[1:]))
    else:
        controller.cmdloop()
