#!/usr/bin/env python3
"""The one channel an org/control-side worker dials a tenant host over:
`DialInTransport` (the interface), `LocalProcessTransport` (a local test
double), and `RemoteMysqldumpTransport` (the real channel: `mysqldump`,
run locally on the worker's own host, connecting to the tenant database
host's existing MySQL port over TLS -- no new listener anywhere, and the
database host gains no new service). A dump endpoint listening on the
database host was tried first and superseded on review: `db/RUNBOOK-db.md`'s
"Backup worker account" section carries why.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import threading
from collections.abc import Mapping, Sequence
from typing import BinaryIO, Protocol

# Every prefix naming a storage or encryption credential in this estate's
# convention, restated from db/provision/dump_tenant.py's own
# FORBIDDEN_ENV_PREFIXES rather than imported: this module is the
# org/control side of the same trust boundary, checking the same property
# independently. None of AWS_* / DB_BACKUP_* / AGE_* may ever reach the
# environment a producer command is invoked with.
FORBIDDEN_ENV_PREFIXES = ("AWS_", "DB_BACKUP_", "AGE_")

# What a local subprocess is allowed to see beyond the caller's own,
# explicit env dict -- PATH only, so a binary can be resolved by name.
# Never a forward of this process's own os.environ: the worker legitimately
# holds AWS_*/AGE_* itself (for the storage and encryption calls
# `pull_encrypt_store.py` makes), and an allowlist is the only shape that
# cannot leak them into a producer invocation by accident.
_CHILD_ENV_ALLOWLIST = ("PATH",)

# `db/provision/naming.py`'s own `TENANT_NAME_PATTERN` and database-name
# derivation, restated rather than imported -- same reasoning as
# `FORBIDDEN_ENV_PREFIXES` above: this module is on the org/control side
# of the trust boundary, and it is the layer that puts a tenant name into
# a `mysqldump --databases` argument, so it checks and derives that value
# itself rather than trusting whatever validated it on its way here.
TENANT_NAME_PATTERN = re.compile(r"\A[a-z]([a-z0-9-]*[a-z0-9])?\Z")
_TENANT_DB_PREFIX = "ghost_"


class DialInTransportError(Exception):
    """The transport itself could not run the producer at all -- distinct
    from the producer's own nonzero exit, which is an ordinary, expected
    outcome this pipeline handles by discarding whatever streamed."""


def assert_no_forbidden_env(env: Mapping[str, str]) -> None:
    """Refuses an env dict carrying a storage or encryption credential
    prefix, before it ever reaches a transport. `pull_encrypt_store.py`
    calls this exact function too, at its own boundary -- two call sites
    sharing one implementation, not two independent ones: a bug in this
    function would defeat the check at both sites at once. The two-call-site
    shape still matters -- a caller of either module gets the refusal at
    the earliest point it invokes -- but it is not defense in depth against
    a defect in this function itself."""
    present = sorted(name for name in env if name.startswith(FORBIDDEN_ENV_PREFIXES))
    if present:
        raise DialInTransportError(
            "refusing to dial in: the environment a producer would be invoked with carries "
            f"{', '.join(present)} -- the per-tenant dump producer's own caller contract is "
            "that this invocation channel must never carry a storage or encryption "
            "credential, regardless of whether the producer at the other end would refuse "
            "to start with one present"
        )


class DialInTransport(Protocol):
    """One call: run `command` with exactly `env` (nothing else, nothing
    ambient), stream its stdout to `stdout` as it arrives, and return the
    exit code once the process ends. A caller decides what to do with a
    nonzero exit; this interface only ever reports it faithfully."""

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int: ...


class LocalProcessTransport:
    """A TEST DOUBLE, not the production channel: proves the pipeline's
    controls against a real local producer and database without a network
    hop. Streams line-by-line, mirroring `dump_tenant.py`'s own
    `run_mysqldump`, since a caller watching for a floor-table `INSERT`
    needs whole lines.
    """

    def __init__(self, *, popen=subprocess.Popen) -> None:
        self._popen = popen

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        child_env = {name: os.environ[name] for name in _CHILD_ENV_ALLOWLIST if name in os.environ}
        child_env.update(env)

        process = self._popen(list(command), env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for line in process.stdout:
                stdout.write(line)
        finally:
            process.stdout.close()
        process.stderr.close()
        return process.wait()



# The pattern `run_tenant_dump` builds its own `command` argument with --
# see backup_worker.py: `[python_executable, dump_tenant_path, tenant,
# "--socket", socket_path]`. `RemoteMysqldumpTransport` runs `mysqldump`
# itself rather than that argv (there is no remote producer script to
# invoke any more -- see the module docstring); the tenant name is the
# only thing it extracts from `command`, at this fixed position, the same
# convention the pull-model design already used.
_TENANT_COMMAND_INDEX = 2


def _tenant_from_command(command: Sequence[str]) -> str:
    if len(command) <= _TENANT_COMMAND_INDEX:
        raise DialInTransportError(
            f"cannot derive a tenant name: {list(command)!r} is shorter than the "
            "[python, dump_tenant_path, tenant, ...] shape run_tenant_dump always builds"
        )
    return command[_TENANT_COMMAND_INDEX]


class RemoteMysqldumpTransport:
    """The real dial-in channel: `mysqldump`, local subprocess, TLS to the
    tenant database host's existing port. Grants: `db/RUNBOOK-db.md`'s
    "Backup worker account" section. Re-validates the tenant independently
    -- this is the layer that turns it into a `--databases` argument.
    `env["DB_DUMP_MYSQL_PWD"]` reaches `mysqldump` only as the child's own
    `MYSQL_PWD`, never argv, so it never appears in a process listing."""

    def __init__(
        self,
        *,
        host: str,
        user: str,
        ssl_ca: str,
        port: int = 3306,
        timeout_seconds: float = 1800.0,
        popen=subprocess.Popen,
    ) -> None:
        self._host = host
        self._port = port
        self._user = user
        self._ssl_ca = ssl_ca
        self._timeout_seconds = timeout_seconds
        self._popen = popen

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        tenant = _tenant_from_command(command)
        if not TENANT_NAME_PATTERN.match(tenant):
            raise DialInTransportError(f"refusing to dial in: {tenant!r} is not a strictly valid tenant slug")
        mysql_pwd = env.get("DB_DUMP_MYSQL_PWD")
        if not mysql_pwd:
            raise DialInTransportError(
                "refusing to dial in: env carries no DB_DUMP_MYSQL_PWD for the mysqldump child"
            )

        db_name = _TENANT_DB_PREFIX + tenant.replace("-", "_")
        argv = [
            "mysqldump",
            "--host", self._host,
            "--port", str(self._port),
            "--user", self._user,
            "--ssl-mode=VERIFY_CA",
            "--ssl-ca", self._ssl_ca,
            "--single-transaction",
            "--source-data=2",
            "--routines",
            "--triggers",
            "--set-gtid-purged=OFF",
            "--databases", db_name,
        ]
        child_env = {name: os.environ[name] for name in _CHILD_ENV_ALLOWLIST if name in os.environ}
        child_env["MYSQL_PWD"] = mysql_pwd

        # start_new_session so a kill on timeout reaches the whole process
        # group `mysqldump` heads, not just the one pid this class holds --
        # otherwise a child it spawned could keep the stdout pipe's write
        # end open after the parent is gone, and the read loop below would
        # block for however long that child took to exit on its own,
        # rather than for this transport's own timeout.
        process = self._popen(
            argv, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True
        )
        timed_out = threading.Event()

        def _on_timeout() -> None:
            timed_out.set()
            self._kill_process_group(process)

        timer = threading.Timer(self._timeout_seconds, _on_timeout)
        timer.start()
        try:
            try:
                for line in process.stdout:
                    stdout.write(line)
            finally:
                process.stdout.close()
            process.stderr.close()
            exit_code = process.wait()
        finally:
            timer.cancel()

        if timed_out.is_set():
            raise DialInTransportError(
                f"mysqldump against {self._host}:{self._port} exceeded its {self._timeout_seconds}s "
                "timeout and was killed -- refusing to treat this as an ordinary producer failure"
            )
        return exit_code

    @staticmethod
    def _kill_process_group(process) -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (AttributeError, ProcessLookupError, PermissionError, OSError):
            # AttributeError: a test double with no real pid/session.
            # ProcessLookupError: already exited. PermissionError/OSError:
            # os.killpg unavailable (e.g. Windows) or the group is gone --
            # either way, falling back to killing this one pid is strictly
            # weaker, never worse than doing nothing.
            process.kill()
