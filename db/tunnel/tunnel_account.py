#!/usr/bin/env python3
"""The tunnel account on the replica host: one key, two forwards, no shell.

See tunnel_account.md.
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import os
import re
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Callable, Sequence

ACCOUNT = "dbtunnel"
NOLOGIN = "/usr/sbin/nologin"
CONFIG_DIR = "/etc/branchleft/db-tunnel"
AUTHORIZED_KEYS = f"{CONFIG_DIR}/authorized_keys"
SSHD_DROPIN = "/etc/ssh/sshd_config.d/60-branchleft-db-tunnel.conf"
HOST_KEY = "/etc/ssh/ssh_host_ed25519_key.pub"

DEFAULT_LISTEN_PORT = 13306
DEFAULT_METRICS_PORT = 9104
LOOPBACK = "127.0.0.1"

KEY_TYPE = "ssh-ed25519"
ED25519_KEY_BYTES = 32
COMMENT_PATTERN = re.compile(r"[A-Za-z0-9@._-]{1,64}")

# Ranges a NAT egress address can never be. See tunnel_account.md#from_address.
NOT_A_NAT_ADDRESS = tuple(
    ipaddress.IPv4Network(block)
    for block in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/3",
    )
)

Runner = Callable[[Sequence[str]], subprocess.CompletedProcess]


class TunnelAccountError(Exception):
    """A refusal: the input or the host is not in a state this will write."""


@dataclass(frozen=True)
class Grant:
    """What the one key may do: listen on one port, open one port."""

    public_key: str
    from_address: str
    listen_port: int = DEFAULT_LISTEN_PORT
    metrics_port: int = DEFAULT_METRICS_PORT

    @property
    def listen(self) -> str:
        return f"{LOOPBACK}:{self.listen_port}"

    @property
    def open(self) -> str:
        return f"{LOOPBACK}:{self.metrics_port}"


def validate_public_key(line: str) -> str:
    """Return the key as `ssh-ed25519 <blob> [comment]`, or refuse it."""
    text = line.strip()
    if "\n" in text or "\r" in text:
        raise TunnelAccountError("the public key must be exactly one line")
    fields = text.split(" ")
    if len(fields) not in (2, 3) or any(not field for field in fields):
        raise TunnelAccountError(
            "the public key must be `ssh-ed25519 <base64> [comment]`, with no options in front"
        )
    if fields[0] != KEY_TYPE:
        raise TunnelAccountError(f"only {KEY_TYPE} keys are accepted, got {fields[0]!r}")
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except ValueError as exc:
        raise TunnelAccountError("the key's base64 body does not decode") from exc
    if _decode_ed25519_blob(blob) != ED25519_KEY_BYTES:
        raise TunnelAccountError("the key body is not a well-formed ed25519 public key")
    if len(fields) == 3 and not COMMENT_PATTERN.fullmatch(fields[2]):
        raise TunnelAccountError("the key comment may hold only letters, digits and @._-")
    return " ".join(fields)


def _decode_ed25519_blob(blob: bytes) -> int:
    """Length of the key material in an ssh-ed25519 wire blob, or -1."""
    fields = []
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


def validate_from_address(value: str) -> str:
    """One public IPv4 address: the only source the key is accepted from."""
    try:
        address = ipaddress.IPv4Address(value.strip())
    except ValueError as exc:
        raise TunnelAccountError(
            f"--from-address must be a single IPv4 address, got {value!r}"
        ) from exc
    if any(address in network for network in NOT_A_NAT_ADDRESS):
        raise TunnelAccountError(
            f"--from-address {address} is not a public address; see tunnel_account.md#from_address"
        )
    return str(address)


def validate_port(value: int, name: str) -> int:
    if not 1024 <= value <= 65535:
        raise TunnelAccountError(f"{name} must be between 1024 and 65535, got {value}")
    return value


def make_grant(public_key: str, from_address: str, listen_port: int, metrics_port: int) -> Grant:
    if listen_port == metrics_port:
        raise TunnelAccountError("the listen port and the metrics port must differ")
    return Grant(
        public_key=validate_public_key(public_key),
        from_address=validate_from_address(from_address),
        listen_port=validate_port(listen_port, "--listen-port"),
        metrics_port=validate_port(metrics_port, "--metrics-port"),
    )


def render_authorized_keys(grant: Grant) -> str:
    options = ",".join(
        [
            "restrict",
            "port-forwarding",
            f'permitlisten="{grant.listen}"',
            f'permitopen="{grant.open}"',
            f'from="{grant.from_address}"',
        ]
    )
    return f"{options} {grant.public_key}\n"


def render_sshd_dropin(grant: Grant) -> str:
    lines = [
        "# Rendered by ghost-platform db/tunnel/tunnel_account.py. Do not edit by hand.",
        f"Match User {ACCOUNT}",
        f"    AuthorizedKeysFile {AUTHORIZED_KEYS}",
        "    AuthenticationMethods publickey",
        "    AllowTcpForwarding yes",
        f"    PermitListen {grant.listen}",
        f"    PermitOpen {grant.open}",
        "    GatewayPorts no",
        "    AllowAgentForwarding no",
        "    AllowStreamLocalForwarding no",
        "    X11Forwarding no",
        "    PermitTTY no",
        "    PermitTunnel no",
        "    PermitUserRC no",
        f"    ForceCommand {NOLOGIN}",
    ]
    return "\n".join(lines) + "\n"


def expected_effective(grant: Grant) -> dict[str, str]:
    """`sshd -T` keywords and the values the account must resolve to."""
    return {
        "allowtcpforwarding": "yes",
        "permitlisten": grant.listen,
        "permitopen": grant.open,
        "gatewayports": "no",
        "allowagentforwarding": "no",
        "allowstreamlocalforwarding": "no",
        "x11forwarding": "no",
        "permittty": "no",
        "permittunnel": "no",
        "forcecommand": NOLOGIN,
        "authorizedkeysfile": AUTHORIZED_KEYS,
    }


def parse_sshd_t(output: str) -> dict[str, str]:
    """First value per keyword, as `sshd -T` prints them."""
    effective: dict[str, str] = {}
    for line in output.splitlines():
        keyword, _, value = line.strip().partition(" ")
        if keyword and keyword not in effective:
            effective[keyword] = value.strip()
    return effective


def effective_mismatches(output: str, grant: Grant) -> list[str]:
    effective = parse_sshd_t(output)
    problems = []
    for keyword, expected in expected_effective(grant).items():
        actual = effective.get(keyword)
        if actual != expected:
            problems.append(f"{keyword} is {actual!r}, expected {expected!r}")
    return problems


@dataclass
class Host:
    """Where the installer writes and what it runs; tests point this elsewhere."""

    run: Runner
    authorized_keys: str = AUTHORIZED_KEYS
    sshd_dropin: str = SSHD_DROPIN
    host_key: str = HOST_KEY
    owner_uid: int = 0
    owner_gid: int = 0


def default_runner(argv: Sequence[str]) -> subprocess.CompletedProcess:
    return subprocess.run(list(argv), capture_output=True, text=True, check=False)


def _must(host: Host, argv: Sequence[str]) -> subprocess.CompletedProcess:
    result = host.run(argv)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise TunnelAccountError(f"`{' '.join(argv)}` failed ({result.returncode}): {detail}")
    return result


def ensure_account(host: Host) -> str:
    """Create the account, or confirm an existing one has no shell."""
    found = host.run(["getent", "passwd", ACCOUNT])
    if found.returncode == 2:
        _must(
            host,
            [
                "useradd",
                "--system",
                "--no-create-home",
                "--home-dir",
                "/nonexistent",
                "--shell",
                NOLOGIN,
                ACCOUNT,
            ],
        )
        _must(host, ["usermod", "--lock", ACCOUNT])
        return f"created system account {ACCOUNT} with shell {NOLOGIN}"
    if found.returncode != 0:
        raise TunnelAccountError(f"getent passwd {ACCOUNT} failed ({found.returncode})")
    shell = found.stdout.strip().split(":")[-1]
    if shell != NOLOGIN:
        raise TunnelAccountError(
            f"account {ACCOUNT} already exists with shell {shell!r}; refusing to reuse it"
        )
    _must(host, ["usermod", "--lock", ACCOUNT])
    return f"account {ACCOUNT} already exists with shell {NOLOGIN}"


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def _write_atomic(path: str, content: str, host: Host) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tunnel-account-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(tmp, 0o644)
        os.chown(tmp, host.owner_uid, host.owner_gid)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _restore(path: str, previous: str | None, host: Host) -> None:
    if previous is None:
        if os.path.exists(path):
            os.unlink(path)
    else:
        _write_atomic(path, previous, host)


def install(grant: Grant, host: Host) -> list[str]:
    """Write both files, validate sshd, reload, and read the result back."""
    log = [ensure_account(host)]
    targets = [
        (host.authorized_keys, render_authorized_keys(grant)),
        (host.sshd_dropin, render_sshd_dropin(grant)),
    ]
    previous = {path: _read(path) for path, _ in targets}
    changed = [path for path, content in targets if previous[path] != content]
    for path, content in targets:
        if path in changed:
            _write_atomic(path, content, host)
            log.append(f"wrote {path}")
        else:
            log.append(f"{path} already up to date")

    check = host.run(["sshd", "-t"])
    if check.returncode != 0:
        for path in changed:
            _restore(path, previous[path], host)
        raise TunnelAccountError(
            f"sshd -t rejected the config, previous files restored: {check.stderr.strip()}"
        )
    if changed:
        _must(host, ["systemctl", "reload", "ssh"])
        log.append("reloaded ssh")

    resolved = _must(
        host,
        ["sshd", "-T", "-C", f"user={ACCOUNT},host=tunnel-check,addr={grant.from_address}"],
    )
    problems = effective_mismatches(resolved.stdout, grant)
    if problems:
        raise TunnelAccountError(
            "sshd's effective config for the account is not the rendered one: "
            + "; ".join(problems)
        )
    log.append(f"sshd -T for {ACCOUNT} matches: listen {grant.listen}, open {grant.open}")
    log.append(f"host key to pin on the dialling side: {read_host_key(host.host_key)}")
    return log


def read_host_key(path: str) -> str:
    """This host's ed25519 key as `ssh-ed25519 <blob>`, comment dropped."""
    text = _read(path)
    if text is None:
        raise TunnelAccountError(f"no host key at {path}")
    fields = text.split()
    if len(fields) < 2:
        raise TunnelAccountError(f"{path} is not an ssh public key")
    return validate_public_key(f"{fields[0]} {fields[1]}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=["install", "render-authorized-keys", "render-sshd"])
    parser.add_argument("--public-key-file", required=True)
    parser.add_argument("--from-address", required=True)
    parser.add_argument("--listen-port", type=int, default=DEFAULT_LISTEN_PORT)
    parser.add_argument("--metrics-port", type=int, default=DEFAULT_METRICS_PORT)
    return parser


def main(argv: Sequence[str] | None = None, host: Host | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        key_text = _read(args.public_key_file)
        if key_text is None:
            raise TunnelAccountError(f"no public key file at {args.public_key_file}")
        grant = make_grant(key_text, args.from_address, args.listen_port, args.metrics_port)
        if args.action == "render-authorized-keys":
            sys.stdout.write(render_authorized_keys(grant))
        elif args.action == "render-sshd":
            sys.stdout.write(render_sshd_dropin(grant))
        else:
            if host is None and os.geteuid() != 0:
                raise TunnelAccountError("install must run as root")
            for line in install(grant, host or Host(run=default_runner)):
                print(f"tunnel_account: {line}")
    except TunnelAccountError as exc:
        print(f"tunnel_account: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
