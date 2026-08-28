#!/usr/bin/env python3
"""Writes the mysqld-exporter's `.my.cnf` from `EXPORTER_MYSQL_PWD` in
`/etc/branchleft/db.env`.

The exporter has no way to take a password that is not either a file it reads
or an environment variable. An environment variable is visible in `docker
inspect` to every account that can reach the Docker socket, so this renders a
file instead, mode 0400 and owned by the uid the container runs as.

The output lives under /etc/branchleft rather than in the stack directory.
The stack directory is an rsync target and `--delete` would remove a
host-rendered file from it on the next deploy, leaving the running container
holding the only copy through its open file handle -- invisible until the next
recreate.

Run again after a password rotation, then restart `branchleft-compose@db` to
pick it up. The stack's systemd drop-in also runs this once before every
start, so a fresh boot never serves a stale render.
"""

from __future__ import annotations

import os
import pathlib
import re
import sys

PASSWORD_VAR = "EXPORTER_MYSQL_PWD"

# The account and the socket are fixed by db/stack/compose.yml and
# db/RUNBOOK-db.md: `'exporter'@'localhost'`, reachable over the bind-mounted
# socket and nothing else. Neither is a secret, so neither is a variable.
EXPORTER_USER = "exporter"
EXPORTER_SOCKET = "/var/run/mysqld/mysqld.sock"

OUTPUT_PATH = pathlib.Path(
    os.environ.get("EXPORTER_MY_CNF_PATH", "/etc/branchleft/db-exporter.my.cnf")
)

# The exporter runs `os.ExpandEnv` over every value it parses out of this file
# (config.go's `cfg.ValueMapper`), so a password containing `$` is silently
# rewritten before it is used: `pw$with$dollars` authenticates as `pw`, the
# container stays up and serving, and only `mysql_up 0` says otherwise. The
# same parser strips a leading and trailing `"` and treats `#`, `;` and `\`
# as syntax.
#
# Allow-listed rather than escaped, because none of those has an escape that
# survives both the ini parser and the variable expansion -- `$$` expands to
# the empty string, it does not quote. A generated password has no reason to
# leave this alphabet, so the constraint costs nothing and cannot be got
# subtly wrong. 20 characters is the floor for an account reachable only over
# a host-local socket.
SAFE_PASSWORD = re.compile(r"\A[A-Za-z0-9._~-]{20,}\Z")

GENERATOR_HINT = (
    "generate one with: LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40"
)

# The container image runs as `nobody`. A bind-mounted file is read as the
# container-side uid whatever wrote it on the host, so a root-owned 0400 file
# is unreadable to the one process it exists for and the exporter exits with
# "permission denied" on the config path. Ownership moves rather than the mode
# widening: the file holds a plaintext password and 0444 would expose it to
# every other account on the host.
EXPORTER_UID = int(os.environ.get("EXPORTER_UID", "65534"))


def render(env: dict[str, str]) -> str:
    """Pure -- no I/O, so this is what the unit tests exercise."""
    password = env.get(PASSWORD_VAR, "")
    if not password:
        raise ValueError(
            f"{PASSWORD_VAR} is unset or empty -- set it in /etc/branchleft/db.env. "
            f"EXPORTER_DATA_SOURCE_NAME is not read by anything and does not "
            f"substitute for it; {GENERATOR_HINT}"
        )
    if not SAFE_PASSWORD.match(password):
        raise ValueError(
            f"{PASSWORD_VAR} must be at least 20 characters of A-Za-z0-9._~- "
            f"and nothing else -- the exporter expands `$`, unquotes `\"` and "
            f"treats `#`, `;` and `\\` as syntax, any of which authenticates as "
            f"a different string than the one MySQL holds. Rotate it: "
            f"{GENERATOR_HINT}"
        )
    return (
        "[client]\n"
        f"user = {EXPORTER_USER}\n"
        f"password = {password}\n"
        f"socket = {EXPORTER_SOCKET}\n"
    )


def write(path: pathlib.Path, content: str, uid: int, is_root: bool) -> None:
    """Writes `content` to `path`, never leaving it readable to anyone else.

    The mode is set by `os.open` rather than by a later `chmod`, so the
    password is never on disk under a wider mode even briefly, and the rename
    is atomic so a concurrent container start reads either the whole old file
    or the whole new one.
    """
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    try:
        os.write(fd, content.encode("utf-8"))
    finally:
        os.close(fd)
    if is_root:
        os.chown(tmp, uid, uid)
    os.replace(tmp, path)


def main(argv: list[str]) -> int:
    del argv
    try:
        rendered = render(dict(os.environ))
    except ValueError as exc:
        print(f"render_exporter_my_cnf: {exc}", file=sys.stderr)
        return 1

    if os.environ.get("EXPORTER_DATA_SOURCE_NAME"):
        print(
            "render_exporter_my_cnf: EXPORTER_DATA_SOURCE_NAME is still set in "
            "/etc/branchleft/db.env and nothing reads it -- remove the line, it "
            "is a password sitting in a file for no reason",
            file=sys.stderr,
        )

    write(OUTPUT_PATH, rendered, EXPORTER_UID, os.geteuid() == 0)
    print(f"render_exporter_my_cnf: wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
