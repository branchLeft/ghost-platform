#!/usr/bin/env python3
"""Render the demo host's broker tunnel account: one key, one -L forward, no shell.

Usage:
  render_broker_tunnel.py authorized-keys --public-key-file FILE
  render_broker_tunnel.py sshd
  render_broker_tunnel.py check-authorized-keys FILE

The control plane on ops1 reaches the broker through an SSH tunnel to demo1
(the owner's ruling control=a). This program is the one statement of what
that tunnel's account may do. It renders the account's authorized key line
and its sshd drop-in, and checks an authorized keys file against the grant.
It writes nothing on a host: the demo1_build role in branchLeft/shared-infra
installs what it renders. See render_broker_tunnel.md.
"""

from __future__ import annotations

import argparse
import base64
import re
import struct
import sys
from typing import Sequence

ACCOUNT = "brokertunnel"
NOLOGIN = "/usr/sbin/nologin"

# The broker listens here and nowhere else (services/broker, PORT=8090 on
# loopback). The key may open this one destination and no other.
BROKER_OPEN = "127.0.0.1:8090"

AUTHORIZED_KEYS_DIR = "/etc/ssh/branchleft-broker-tunnel"
AUTHORIZED_KEYS = f"{AUTHORIZED_KEYS_DIR}/authorized_keys"
SSHD_DROPIN = "/etc/ssh/sshd_config.d/50-branchleft-broker-tunnel.conf"

# The options on the one key, in this order and no others. `restrict` turns
# off every forwarding, the pty, the agent, X11 and user rc; `port-forwarding`
# turns TCP forwarding back on; `permitopen` limits -L to the broker.
KEY_OPTIONS: tuple[str, ...] = (
    "restrict",
    "port-forwarding",
    f'permitopen="{BROKER_OPEN}"',
)

KEY_TYPE = "ssh-ed25519"
ED25519_KEY_BYTES = 32
COMMENT_PATTERN = re.compile(r"[A-Za-z0-9@._-]{1,64}")


class BrokerTunnelError(Exception):
    """A refusal: the input is not one this program will render."""


def _ed25519_key_length(blob: bytes) -> int:
    """Length of the key material in an ssh-ed25519 wire blob, or -1."""
    fields: list[bytes] = []
    offset = 0
    while offset < len(blob):
        if offset + 4 > len(blob):
            return -1
        (size,) = struct.unpack(">I", blob[offset : offset + 4])
        offset += 4
        if offset + size > len(blob):
            return -1
        fields.append(blob[offset : offset + size])
        offset += size
    if len(fields) != 2 or fields[0] != KEY_TYPE.encode():
        return -1
    return len(fields[1])


def validate_public_key(line: str) -> str:
    """Return the key as `ssh-ed25519 <blob> [comment]`, or refuse it."""
    text = line.strip()
    if "\n" in text or "\r" in text:
        raise BrokerTunnelError("the public key must be exactly one line")
    fields = text.split(" ")
    if len(fields) not in (2, 3) or any(not field for field in fields):
        raise BrokerTunnelError(
            "the public key must be `ssh-ed25519 <base64> [comment]`, with no options in front"
        )
    if fields[0] != KEY_TYPE:
        raise BrokerTunnelError(f"only {KEY_TYPE} keys are accepted")
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except ValueError as exc:
        raise BrokerTunnelError("the key's base64 body does not decode") from exc
    if _ed25519_key_length(blob) != ED25519_KEY_BYTES:
        raise BrokerTunnelError("the key body is not a well-formed ed25519 public key")
    if len(fields) == 3 and not COMMENT_PATTERN.fullmatch(fields[2]):
        raise BrokerTunnelError("the key comment may hold only letters, digits and @._-")
    return " ".join(fields)


def render_authorized_keys(public_key: str) -> str:
    """The account's whole authorized keys file: one line, the grant's options."""
    return f"{','.join(KEY_OPTIONS)} {validate_public_key(public_key)}\n"


def render_sshd_dropin() -> str:
    """The Match block that sets every restriction a second time, in sshd."""
    lines = [
        "# Rendered by ghost-platform demo-host/provision/render_broker_tunnel.py. Do not edit by hand.",
        "# The broker tunnel account may hold one -L forward, to the broker, and run nothing.",
        f"Match User {ACCOUNT}",
        f"    AuthorizedKeysFile {AUTHORIZED_KEYS}",
        "    AuthenticationMethods publickey",
        "    AllowTcpForwarding local",
        f"    PermitOpen {BROKER_OPEN}",
        "    PermitListen none",
        "    GatewayPorts no",
        "    AllowAgentForwarding no",
        "    AllowStreamLocalForwarding no",
        "    X11Forwarding no",
        "    PermitTTY no",
        "    PermitTunnel no",
        "    PermitUserRC no",
        f"    ForceCommand {NOLOGIN}",
        "# Ends the Match block, so lines after this drop-in are not read as part of it.",
        "Match all",
    ]
    return "\n".join(lines) + "\n"


def expected_effective() -> dict[str, str]:
    """`sshd -T -C user=brokertunnel,...` keywords and the one value each must resolve to."""
    return {
        "authorizedkeysfile": AUTHORIZED_KEYS,
        "authenticationmethods": "publickey",
        "allowtcpforwarding": "local",
        "permitopen": BROKER_OPEN,
        "permitlisten": "none",
        "gatewayports": "no",
        "allowagentforwarding": "no",
        "allowstreamlocalforwarding": "no",
        "x11forwarding": "no",
        "permittty": "no",
        "permittunnel": "no",
        "permituserrc": "no",
        "forcecommand": NOLOGIN,
    }


def _split_options(text: str) -> list[str]:
    """Split an authorized_keys options field on commas outside double quotes."""
    options: list[str] = []
    current: list[str] = []
    quoted = False
    for char in text:
        if char == '"':
            quoted = not quoted
        if char == "," and not quoted:
            options.append("".join(current))
            current = []
        else:
            current.append(char)
    options.append("".join(current))
    return options


def check_authorized_keys(text: str) -> list[str]:
    """Every way an authorized keys file differs from the grant; empty when it is the grant."""
    lines = [line for line in text.split("\n") if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) != 1:
        return [f"the file must hold exactly one key, it holds {len(lines)}"]
    line = lines[0]
    if not line.startswith(KEY_OPTIONS[0] + ","):
        return ["the key must start with the grant's options, `restrict` first"]
    options_field, _, key = line.partition(" ")
    problems: list[str] = []
    options = _split_options(options_field)
    if tuple(options) != KEY_OPTIONS:
        problems.append(f"the key's options are {options!r}, the grant is {list(KEY_OPTIONS)!r}")
    opens = [option for option in options if option.lower().startswith("permitopen=")]
    if opens != [f'permitopen="{BROKER_OPEN}"']:
        problems.append(f"the key may open {opens!r}; the grant is only {BROKER_OPEN}")
    try:
        validate_public_key(key)
    except BrokerTunnelError as exc:
        problems.append(str(exc))
    return problems


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="action", required=True)
    keys = sub.add_parser("authorized-keys", help="print the authorized keys file")
    keys.add_argument("--public-key-file", required=True)
    sub.add_parser("sshd", help="print the sshd drop-in")
    check = sub.add_parser("check-authorized-keys", help="check a file against the grant")
    check.add_argument("path")
    return parser


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError as exc:
        raise BrokerTunnelError(f"cannot read {path}: {type(exc).__name__}") from exc


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.action == "authorized-keys":
            sys.stdout.write(render_authorized_keys(_read(args.public_key_file)))
        elif args.action == "sshd":
            sys.stdout.write(render_sshd_dropin())
        else:
            problems = check_authorized_keys(_read(args.path))
            for problem in problems:
                print(f"render_broker_tunnel: {problem}", file=sys.stderr)
            return 1 if problems else 0
    except BrokerTunnelError as exc:
        print(f"render_broker_tunnel: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
