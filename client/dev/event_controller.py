# DEV ONLY: interactive controller that emits OffBalance events on the local
# Hardhat node through OffBalanceEventMock, so you can watch how a provider
# client reacts. Point the client at EVENT_MOCK_ADDRESS (see dev.env).
#
#   cd blockchain && npm run dev                       # chain + deploy
#   client/.venv/bin/python client/dev/event_controller.py            # shell
#   client/.venv/bin/python client/dev/event_controller.py select 1 p1  # one-shot
import cmd
import json
import shlex
import sys
import time
from pathlib import Path

from web3 import Web3

REPO_ROOT = Path(__file__).resolve().parents[2]

# OffBalance emits the job's executionTime as COMMIT_PHASE_START's deadline
DEFAULT_DEADLINE = 60


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key] = value
    return env


def event_signatures(abi: list[dict]) -> dict[str, list]:
    return {
        e["name"]: [(i["name"], i["type"]) for i in e["inputs"]]
        for e in abi if e["type"] == "event"
    }


class EventController(cmd.Cmd):
    intro = "OffBalance event controller. Type 'help' for commands, 'accounts' for aliases."
    prompt = "events> "

    def __init__(self):
        super().__init__()
        self.env = load_env(REPO_ROOT / "dev.env")
        deployment = json.loads((REPO_ROOT / self.env["OFFBALANCE_DEPLOYMENT"]).read_text())

        # the mock must emit exactly what OffBalance declares, or the test is lying
        real, mock = event_signatures(deployment["abi"]), event_signatures(deployment["eventMock"]["abi"])
        if real != mock:
            sys.exit(f"Event mismatch between OffBalance and OffBalanceEventMock:\n  real: {real}\n  mock: {mock}")

        self.w3 = Web3(Web3.HTTPProvider(self.env["RPC_URL"]))
        if not self.w3.is_connected():
            sys.exit(f"Can't reach node at {self.env['RPC_URL']}. Run `npm run dev` in blockchain/.")

        address = Web3.to_checksum_address(deployment["eventMock"]["address"])
        if not self.w3.eth.get_code(address):
            sys.exit(f"No contract at {address}. Restart the node and redeploy.")
        self.mock = self.w3.eth.contract(address=address, abi=deployment["eventMock"]["abi"])
        self.sender = self.w3.eth.account.from_key(self.env["SERVER_PRIVATE_KEY"])

        # aliases: server, buyer, p1..p4
        self.aliases = {"server": self.env["SERVER_ADDRESS"], "buyer": self.env["BUYER_ADDRESS"]}
        for key, value in self.env.items():
            if key.startswith("PROVIDER_") and key.endswith("_ADDRESS"):
                self.aliases[f"p{key.split('_')[1]}"] = value

    # ---------- helpers ----------
    def resolve(self, who: str) -> str:
        if who.lower() in self.aliases:
            return self.aliases[who.lower()]
        if Web3.is_address(who):
            return Web3.to_checksum_address(who)
        raise ValueError(f"unknown account '{who}' (use {', '.join(self.aliases)} or a 0x address)")

    def send(self, fn_name: str, *args):
        fn = getattr(self.mock.functions, fn_name)(*args)
        tx = fn.build_transaction({
            "from": self.sender.address,
            "nonce": self.w3.eth.get_transaction_count(self.sender.address),
        })
        signed = self.sender.sign_transaction(tx)
        receipt = self.w3.eth.wait_for_transaction_receipt(self.w3.eth.send_raw_transaction(signed.raw_transaction))
        for log in receipt["logs"]:
            event = self.mock.events[self._event_name(log)]().process_log(log)
            print(f"  block {receipt['blockNumber']}: {event['event']}({dict(event['args'])})")

    def _event_name(self, log) -> str:
        topic = log["topics"][0]
        for abi in self.mock.abi:
            if abi["type"] == "event":
                sig = f"{abi['name']}({','.join(i['type'] for i in abi['inputs'])})"
                if Web3.keccak(text=sig) == topic:
                    return abi["name"]
        raise ValueError(f"unknown log topic {topic.hex()}")

    def pop_option(self, parts: list[str], flag: str, default: float) -> float:
        if flag not in parts:
            return default
        i = parts.index(flag)
        value = float(parts[i + 1])
        del parts[i:i + 2]
        return value

    def parse(self, arg: str, min_args: int, usage: str) -> list[str]:
        parts = shlex.split(arg)
        if len(parts) < min_args:
            raise ValueError(f"usage: {usage}")
        return parts

    def onecmd(self, line):
        try:
            return super().onecmd(line)
        except Exception as e:  # keep the shell alive on bad input / reverts
            print(f"error: {e}")

    def emptyline(self):
        pass

    # ---------- single events ----------
    def do_submit(self, arg):
        "submit JOB              emit JOB_SUBMITTED"
        job, = self.parse(arg, 1, "submit JOB")
        self.send("jobSubmitted", int(job))

    def do_select(self, arg):
        "select JOB WHO [WHO..]  emit PROVIDER_SELECTED for each provider (p1, 0x.., ...)"
        job, *who = self.parse(arg, 2, "select JOB WHO [WHO..]")
        self.send("providersSelected", int(job), [self.resolve(w) for w in who])

    def do_commit(self, arg):
        f"commit JOB [DEADLINE]   emit COMMIT_PHASE_START (deadline defaults to {DEFAULT_DEADLINE})"
        job, *deadline = self.parse(arg, 1, "commit JOB [DEADLINE]")
        self.send("commitPhaseStart", int(job), int(deadline[0]) if deadline else DEFAULT_DEADLINE)

    def do_reveal(self, arg):
        "reveal JOB              emit REVEAL_PHASE_START"
        job, = self.parse(arg, 1, "reveal JOB")
        self.send("revealPhaseStart", int(job))

    def do_consensus(self, arg):
        "consensus JOB           emit CONSENSUS_VERIFICATION_START"
        job, = self.parse(arg, 1, "consensus JOB")
        self.send("consensusVerificationStart", int(job))

    def do_delivery(self, arg):
        "delivery JOB            emit DELIVERY_PHASE_START"
        job, = self.parse(arg, 1, "delivery JOB")
        self.send("deliveryPhaseStart", int(job))

    def do_delivered(self, arg):
        "delivered JOB           emit DELIVERED"
        job, = self.parse(arg, 1, "delivered JOB")
        self.send("delivered", int(job))

    def do_paid(self, arg):
        "paid JOB WHO            emit PAID"
        job, who = self.parse(arg, 2, "paid JOB WHO")
        self.send("paid", int(job), self.resolve(who))

    def do_slashed(self, arg):
        "slashed JOB WHO         emit SLASHED"
        job, who = self.parse(arg, 2, "slashed JOB WHO")
        self.send("slashed", int(job), self.resolve(who))

    def do_cancel(self, arg):
        "cancel JOB              emit CANCELED"
        job, = self.parse(arg, 1, "cancel JOB")
        self.send("canceled", int(job))

    def do_noquorum(self, arg):
        "noquorum JOB            emit NO_QUORUM"
        job, = self.parse(arg, 1, "noquorum JOB")
        self.send("noQuorum", int(job))

    def do_committed(self, arg):
        "committed WHO           emit COMMIT_SUBMITTED_BY"
        who, = self.parse(arg, 1, "committed WHO")
        self.send("commitSubmittedBy", self.resolve(who))

    # ---------- sequences ----------
    def do_assign(self, arg):
        "assign JOB WHO [WHO..] [--deadline D]  PROVIDER_SELECTED for each + COMMIT_PHASE_START (like assignProviders)"
        parts = self.parse(arg, 2, "assign JOB WHO [WHO..] [--deadline D]")
        deadline = int(self.pop_option(parts, "--deadline", DEFAULT_DEADLINE))
        job, *who = parts
        self.do_select(shlex.join([job, *who]))
        self.do_commit(f"{job} {deadline}")

    def do_flow(self, arg):
        "flow JOB WHO [WHO..] [--delay S] [--deadline D]  full happy path, pausing S seconds (default 3) between phases"
        parts = self.parse(arg, 2, "flow JOB WHO [WHO..] [--delay S] [--deadline D]")
        delay = self.pop_option(parts, "--delay", 3.0)
        deadline = int(self.pop_option(parts, "--deadline", DEFAULT_DEADLINE))
        job, *who = parts
        steps = [
            lambda: self.do_submit(job),
            lambda: self.do_assign(shlex.join([job, *who, "--deadline", str(deadline)])),
            lambda: self.do_reveal(job),
            lambda: self.do_consensus(job),
            lambda: self.do_delivery(job),
            lambda: self.do_delivered(job),
            *[lambda w=w: self.do_paid(f"{job} {w}") for w in who],
        ]
        for i, step in enumerate(steps):
            step()
            if i < len(steps) - 1:
                time.sleep(delay)

    # ---------- chain utilities ----------
    def do_advance(self, arg):
        "advance SECONDS         move chain time forward and mine a block (for real-contract deadlines)"
        seconds, = self.parse(arg, 1, "advance SECONDS")
        self.w3.provider.make_request("evm_increaseTime", [int(seconds)])
        self.do_mine("")

    def do_mine(self, arg):
        "mine                    mine an empty block"
        self.w3.provider.make_request("evm_mine", [])
        block = self.w3.eth.get_block("latest")
        print(f"  block {block['number']} @ timestamp {block['timestamp']}")

    def do_accounts(self, arg):
        "accounts                list account aliases"
        for alias, address in self.aliases.items():
            print(f"  {alias:<7} {address}")
        print(f"  (events are sent from server; mock at {self.mock.address})")

    def do_exit(self, arg):
        "exit                    quit"
        return True

    do_quit = do_exit
    do_EOF = do_exit


if __name__ == "__main__":
    controller = EventController()
    if len(sys.argv) > 1:
        controller.onecmd(shlex.join(sys.argv[1:]))
    else:
        controller.cmdloop()
