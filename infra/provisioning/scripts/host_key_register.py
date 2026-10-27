#!/usr/bin/env python3
"""Host-key register: each estate host's SSH public host key, by role.

The register is one reviewed file of `role ssh-ed25519 base64` lines. A host
is named by role, never by address; the address is supplied by whoever fills
a `known_hosts` file, at fill time. A key not in the register is refused, never
accepted on first use. The tool never contacts a network or runs `ssh-keyscan`.
The functions are the interface (the provisioning controller imports them);
the command line is a thin layer over them. Narrative: host_key_register.md.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import os
import re
import struct
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

KEY_TYPE = "ssh-ed25519"
DEFAULT_REGISTER = Path(__file__).resolve().parent.parent / "host-key-register.txt"

# The longest key line or register this tool reads. A real ed25519 key line is
# about 100 bytes; anything near this limit is not a key.
_MAX_INPUT = 64 * 1024

_ROLE = re.compile(r"[a-z][a-z0-9-]{0,31}")
_BASE64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")
_REGISTER_LINE = re.compile(r"([a-z][a-z0-9-]{0,31}) ssh-ed25519 ([A-Za-z0-9+/]+={0,2})")
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")

_HEADER = (
    "# known_hosts, written from the host-key register by\n"
    "# infra/provisioning/scripts/host_key_register.py in the platform repository.\n"
    "# See host_key_register.md there. Do not edit by hand.\n"
)


class RegisterError(ValueError):
    """The register, a key line, a role or an address cannot be trusted."""


def _validate_role(role: str) -> str:
    if not isinstance(role, str) or not _ROLE.fullmatch(role):
        raise RegisterError(f"{role!r} is not a valid host role (lowercase letters, digits and hyphens, starting with a letter, at most 32 characters)")
    return role


def _blob_error(body: str) -> str | None:
    """Why `body` is not the base64 of an ssh-ed25519 public key blob, or None."""
    if not _BASE64.fullmatch(body):
        return "the key is not base64"
    try:
        blob = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError):
        return "the key is not valid base64"
    # Exactly 51 bytes, a multiple of three, so there is no padding and no
    # second spelling of one key: the length check below is the canonical form.
    name = KEY_TYPE.encode("ascii")
    expected = struct.pack(">I", len(name)) + name + struct.pack(">I", 32)
    if len(blob) != len(expected) + 32 or not blob.startswith(expected):
        return f"the key is not an {KEY_TYPE} public key blob"
    return None


def parse_key_line(line: str) -> str:
    """Return the base64 body of one `ssh-ed25519 <base64> [comment]` line.

    Takes the first two fields only and drops any trailing comment. Refuses a
    leading field that is not `ssh-ed25519` (an address, options or another key
    type), a body that is not strict base64 of an ed25519 key blob, and
    anything that is not exactly one line.
    """
    if not isinstance(line, str) or len(line) > _MAX_INPUT:
        raise RegisterError("expected one key line")
    if line.endswith("\n"):
        line = line[:-1]
    if line.endswith("\r"):
        line = line[:-1]
    if "\n" in line or "\r" in line:
        raise RegisterError("expected exactly one key line, got several")
    fields = line.split()
    if not fields:
        raise RegisterError("the key line is empty")
    if fields[0] != KEY_TYPE:
        raise RegisterError(
            f"the key line must start with {KEY_TYPE}: an address, options or another key type in front is refused"
        )
    if len(fields) < 2:
        raise RegisterError("the key line has no key after the key type")
    body = fields[1]
    reason = _blob_error(body)
    if reason:
        raise RegisterError(reason)
    return body


def parse_register(text: str) -> dict[str, str]:
    """`role ssh-ed25519 base64` per line; blank lines and column-0 `#` comments ignored.

    Refuses any other line, a repeated role, and one key listed under two roles.
    """
    if not isinstance(text, str) or len(text) > _MAX_INPUT:
        raise RegisterError("the register is not text of a sensible size")
    keys: dict[str, str] = {}
    owner_of: dict[str, str] = {}
    for number, line in enumerate(text.split("\n"), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        match = _REGISTER_LINE.fullmatch(line)
        if not match:
            raise RegisterError(f"line {number}: expected exactly `role {KEY_TYPE} <base64>` and nothing else")
        role, body = match.groups()
        reason = _blob_error(body)
        if reason:
            raise RegisterError(f"line {number}: {reason}")
        if role in keys:
            raise RegisterError(f"line {number}: role {role!r} is listed more than once")
        if body in owner_of:
            raise RegisterError(f"line {number}: roles {owner_of[body]!r} and {role!r} share one key")
        keys[role] = body
        owner_of[body] = role
    return keys


def record(text: str, role: str, key_line: str) -> str:
    """Return `text` with `role`'s key added. Never overwrites.

    Refuses a role already recorded with a different key, and a key already
    recorded under another role. Recording the identical pair again changes
    nothing. Rotating a host's key is a reviewed edit to the file, not this.
    """
    _validate_role(role)
    body = parse_key_line(key_line)
    existing = parse_register(text)
    if role in existing:
        if existing[role] == body:
            return text
        raise RegisterError(
            f"role {role!r} is already recorded with a different key; rotation is a reviewed edit to the register file, never a record"
        )
    for other, other_body in existing.items():
        if other_body == body:
            raise RegisterError(f"this key is already recorded under role {other!r}; one key belongs to one host")
    if text and not text.endswith("\n"):
        text += "\n"
    return f"{text}{role} {KEY_TYPE} {body}\n"


def validate_address(address: str) -> str:
    """Return `address` if it is a plain IPv4 address or DNS name, else refuse.

    No IPv6, no port, no wildcard or negated pattern, no list, no marker: each
    would make one known_hosts line vouch for more than the host named.
    """
    if not isinstance(address, str) or not address:
        raise RegisterError("the address is empty")
    try:
        parsed = ipaddress.IPv4Address(address)
    except ValueError:
        parsed = None
    if parsed is not None:
        if str(parsed) != address:
            raise RegisterError(f"{address!r} is not a plain dotted IPv4 address")
        return address
    if len(address) > 253:
        raise RegisterError("the address is longer than a DNS name can be")
    labels = address.split(".")
    if not all(_DNS_LABEL.fullmatch(label) for label in labels):
        raise RegisterError(f"{address!r} is neither a plain IPv4 address nor a DNS name")
    # A last label of digits only would be a malformed IP, not a name.
    if labels[-1].isdigit():
        raise RegisterError(f"{address!r} is neither a plain IPv4 address nor a DNS name")
    return address


def fill(text: str, role: str, address: str) -> str:
    """Return a `known_hosts` body for `role` at `address`: a comment header and one line.

    Refuses an unknown or empty role and an address that is not a plain IPv4
    address or DNS name.
    """
    _validate_role(role)
    validate_address(address)
    keys = parse_register(text)
    if role not in keys:
        raise RegisterError(f"role {role!r} is not in the host-key register")
    return f"{_HEADER}{address} {KEY_TYPE} {keys[role]}\n"


def check(text: str, require: Iterable[str] = ()) -> None:
    """Validate the whole register; refuse a missing required role."""
    keys = parse_register(text)
    for role in require:
        _validate_role(role)
        if role not in keys:
            raise RegisterError(f"role {role!r} is not in the host-key register")


def fingerprint(body: str) -> str:
    """The OpenSSH SHA256 fingerprint of a key body, as `ssh-keygen -lf` prints it."""
    digest = hashlib.sha256(base64.b64decode(body, validate=True)).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _read_register(path: Path) -> str:
    try:
        with open(path, "rb") as handle:
            data = handle.read(_MAX_INPUT + 1)
    except OSError as error:
        raise RegisterError(f"cannot read the register {path}: {error.strerror or error}") from error
    if len(data) > _MAX_INPUT:
        raise RegisterError(f"the register {path} is larger than {_MAX_INPUT} bytes")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RegisterError(f"the register {path} is not UTF-8 text") from error


def _write_atomic(path: Path, text: str) -> None:
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    )
    try:
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, 0o644)
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def _read_key_input(key_file: str | None) -> str:
    try:
        if key_file:
            with open(key_file, "rb") as handle:
                data = handle.read(_MAX_INPUT + 1)
        else:
            data = sys.stdin.buffer.read(_MAX_INPUT + 1)
    except OSError as error:
        raise RegisterError(f"cannot read the key: {error.strerror or error}") from error
    if len(data) > _MAX_INPUT:
        raise RegisterError("the key input is far larger than a key line")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RegisterError("the key input is not UTF-8 text") from error


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record, fill from and check the host-key register. Offline: no network, no ssh-keyscan."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="add a role's ed25519 public key from a key line (stdin or --key-file)")
    rec.add_argument("role")
    rec.add_argument("--key-file", help="read the key line from this file instead of stdin")
    rec.add_argument("--register", type=Path, default=DEFAULT_REGISTER)

    fil = sub.add_parser("fill", help="print a known_hosts body for a role at an address")
    fil.add_argument("role")
    fil.add_argument("address")
    fil.add_argument("--register", type=Path, default=DEFAULT_REGISTER)

    chk = sub.add_parser("check", help="validate the whole register")
    chk.add_argument("--require", action="append", default=[], metavar="ROLE", help="refuse unless this role is recorded (repeatable)")
    chk.add_argument("--register", type=Path, default=DEFAULT_REGISTER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        text = _read_register(args.register)
        if args.command == "record":
            key_line = _read_key_input(args.key_file)
            new_text = record(text, args.role, key_line)
            body = parse_register(new_text)[args.role]
            if new_text == text:
                print(f"already recorded {args.role} {fingerprint(body)}")
            else:
                _write_atomic(args.register, new_text)
                print(f"recorded {args.role} {fingerprint(body)}")
        elif args.command == "fill":
            sys.stdout.write(fill(text, args.role, args.address))
        else:
            check(text, args.require)
            roles = sorted(parse_register(text))
            print(f"register ok: {len(roles)} host(s){': ' + ', '.join(roles) if roles else ''}")
    except RegisterError as error:
        print(f"host_key_register: refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
