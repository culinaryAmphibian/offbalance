# The provider's credentials, collected once at startup and held in memory for the client's lifetime.
#
#   api_key  bearer token from the frontend's Provider Setup page; identifies the provider's
#            wallet ("owner") to the server
#   session  session key from "Authorize provider client" on the same page; signs every
#            transaction and acts on-chain for the owner (OffBalance.providerOf)
#   owner    the wallet the session key acts for: the provider's on-chain identity, which the
#            server assigns and the contract pays. Filled in from the chain after startup.
from __future__ import annotations

from dataclasses import dataclass, replace
from getpass import getpass
import os
import re
import sys
from typing import Callable

from Crypto.Hash import SHA256
from Crypto.Protocol.KDF import HKDF
from eth_account import Account
from eth_account.signers.local import LocalAccount

_PRIVATE_KEY_RE = re.compile(r'^(0x)?[0-9a-fA-F]{64}$')
_SEED_CONTEXT = b'offbalance-commit-seed-v1'


@dataclass(frozen=True)
class Credentials:
    api_key: str
    session: LocalAccount
    owner: str | None = None

    @property
    def session_address(self) -> str:
        return self.session.address

    # Seed for the per-job commitment salts, derived from the session key so there's no third
    # secret to enter. Stable for as long as the same session key is used.
    @property
    def key_seed(self) -> bytes:
        seed = HKDF(bytes(self.session.key), 32, b'', SHA256, num_keys=1, context=_SEED_CONTEXT)
        assert isinstance(seed, bytes)
        return seed

    def with_owner(self, owner: str) -> Credentials:
        return replace(self, owner=owner)

    def __repr__(self) -> str:  # never print secrets
        return f"Credentials(session={self.session.address}, owner={self.owner})"


def parse_api_key(value: str) -> str:
    key = value.strip()
    if not key or any(c.isspace() for c in key):
        raise ValueError("the API key is empty or has spaces in it; copy it from the Provider Setup page")
    return key


def parse_session_key(value: str) -> LocalAccount:
    key = value.strip()
    if not _PRIVATE_KEY_RE.match(key):
        raise ValueError("the session key must be 64 hex characters (optionally starting with 0x)")
    return Account.from_key(key)


def _ask(parse: Callable[[str], object], env_names: tuple[str, ...], prompt: Callable[[], str], attempts: int):
    for name in env_names:
        if value := os.environ.get(name):
            return parse(value)  # a bad env value is a config error: fail instead of looping
    for attempt in range(attempts):
        try:
            return parse(prompt())
        except (EOFError, KeyboardInterrupt):
            raise SystemExit("\nNo input; run the container with -it so it can ask for your credentials.")
        except ValueError as error:
            remaining = attempts - attempt - 1
            print(f"Invalid input: {error}." + (f" {remaining} tries left." if remaining else ""), file=sys.stderr)
    raise SystemExit("Too many invalid attempts.")


def prompt_credentials(attempts: int = 3) -> Credentials:
    api_key = _ask(parse_api_key, ('OFFBALANCE_API_KEY',),
                   lambda: input("OffBalance API key (from Provider Setup): "), attempts)
    session = _ask(parse_session_key, ('OFFBALANCE_SESSION_KEY', 'PROVIDER_PRIVATE_KEY'),
                   lambda: getpass("Session key (from Authorize provider client): "), attempts)
    return Credentials(api_key=api_key, session=session)
