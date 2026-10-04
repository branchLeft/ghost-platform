#!/usr/bin/env python3
"""The one channel an org/control-side worker dials a tenant host over:
`DialInTransport` (the interface), `LocalProcessTransport` (a local test
double), and `RemoteMysqldumpTransport` (the real channel: `mysqldump`,
run locally on the worker's own host, connecting to the tenant database
host's existing MySQL port over TLS -- no new listener anywhere, and the
database host gains no new service). See dial_in_transport.md#module-overview.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
from collections.abc import Mapping, Sequence
from typing import BinaryIO, Protocol


def _load_bounded_snapshot():
    """`db/provision/bounded_snapshot.py`, by path: the one implementation
    db1's nightly dump also runs. A missing file fails the import loudly."""
    if "bounded_snapshot" in sys.modules:
        return sys.modules["bounded_snapshot"]
    source = pathlib.Path(__file__).resolve().parents[3] / "db" / "provision" / "bounded_snapshot.py"
    spec = importlib.util.spec_from_file_location("bounded_snapshot", source)
    if spec is None or spec.loader is None or not source.is_file():
        raise ImportError(f"{source} is missing -- check out the whole of branchLeft/ghost-platform")
    module = importlib.util.module_from_spec(spec)
    sys.modules["bounded_snapshot"] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules["bounded_snapshot"]
        raise
    return module


bounded_snapshot = _load_bounded_snapshot()

# What `run` returns when no consistent snapshot could be taken: a producer
# failure like any other nonzero exit, with the reason already on stderr.
SNAPSHOT_FAILED_EXIT_CODE = 75

# Every prefix that names a storage or encryption credential in this
# estate's convention, restated here rather than imported since the two
# sides proving the same property independently is the point, not a
# maintenance burden. See dial_in_transport.md#forbidden_env_prefixes.
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

# How much of mysqldump's own stderr this class ever holds in memory or
# quotes back -- a chatty failure must not turn into an unbounded read.
_STDERR_CAPTURE_LIMIT = 16 * 1024


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
    """Runs the producer as an ordinary local subprocess. A TEST DOUBLE, not
    the production channel. Streams line-by-line, mirroring
    `db/provision/dump_tenant.py`'s own `run_mysqldump`, since a caller
    watching for a floor-table `INSERT` pattern needs whole lines.
    See dial_in_transport.md#localprocesstransport.
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
    tenant database host's existing port. Re-validates the tenant itself,
    since this layer turns it into a `--databases` argument. The snapshot
    is `bounded_snapshot`'s: this tenant's tables only, bounded wait and
    hold, never `--source-data`. `last_snapshot` and `last_snapshot_aborts`
    describe the latest run. See dial_in_transport.md#remotemysqldumptransport."""

    def __init__(
        self,
        *,
        host: str,
        user: str,
        ssl_ca: str,
        port: int = 3306,
        timeout_seconds: float = 1800.0,
        popen=subprocess.Popen,
        limits: "bounded_snapshot.Limits | None" = None,
        sleep=time.sleep,
    ) -> None:
        self._host = host
        self._port = port
        self._user = user
        self._ssl_ca = ssl_ca
        self._timeout_seconds = timeout_seconds
        self._popen = popen
        self._limits = limits or bounded_snapshot.Limits()
        self._sleep = sleep
        self.last_snapshot: bounded_snapshot.SnapshotReport | None = None
        self.last_snapshot_aborts = 0

    def dump_args(self, db_name: str) -> list[str]:
        return [
            "--single-transaction",
            "--source-data=2",
            "--routines",
            "--triggers",
            "--set-gtid-purged=OFF",
            "--no-tablespaces",
            "--databases",
            db_name,
        ]

    def run(self, *, command: Sequence[str], env: Mapping[str, str], stdout: BinaryIO) -> int:
        assert_no_forbidden_env(env)
        self.last_snapshot = None
        self.last_snapshot_aborts = 0
        tenant = _tenant_from_command(command)
        if not TENANT_NAME_PATTERN.match(tenant):
            raise DialInTransportError(f"refusing to dial in: {tenant!r} is not a strictly valid tenant slug")
        mysql_pwd = env.get("DB_DUMP_MYSQL_PWD")
        if not mysql_pwd:
            raise DialInTransportError(
                "refusing to dial in: env carries no DB_DUMP_MYSQL_PWD for the mysqldump child"
            )

        db_name = _TENANT_DB_PREFIX + tenant.replace("-", "_")
        child_env = {name: os.environ[name] for name in _CHILD_ENV_ALLOWLIST if name in os.environ}
        factory = bounded_snapshot.ClientFactory(
            connection_args=[
                "--host", self._host,
                "--port", str(self._port),
                "--user", self._user,
                "--ssl-mode=VERIFY_CA",
                "--ssl-ca", self._ssl_ca,
            ],
            password=mysql_pwd,
            env=child_env,
            popen=self._popen,
        )

        try:
            dump, report = bounded_snapshot.take_bounded_snapshot(
                factory=factory,
                schemas=[db_name],
                dump_args=self.dump_args(db_name),
                limits=self._limits,
                sleep=self._sleep,
                log=lambda message: print(f"dial_in_transport: {tenant}: {message}", file=sys.stderr),
            )
        except bounded_snapshot.SnapshotError as exc:
            self.last_snapshot_aborts = exc.aborted_attempts
            print(
                f"dial_in_transport: {tenant}: no consistent snapshot of {self._host}:{self._port}: {exc}",
                file=sys.stderr,
            )
            return SNAPSHOT_FAILED_EXIT_CODE
        self.last_snapshot = report
        self.last_snapshot_aborts = report.aborted_attempts

        process = dump.process
        timed_out = threading.Event()

        def _on_timeout() -> None:
            timed_out.set()
            bounded_snapshot.kill_process(process)

        timer = threading.Timer(self._timeout_seconds, _on_timeout)
        timer.start()
        try:
            try:
                stdout.write(report.coordinates_comment())
                for line in process.stdout:
                    stdout.write(line)
            finally:
                process.stdout.close()
            exit_code = process.wait()
        except BaseException:
            bounded_snapshot.kill_process(process)
            raise
        finally:
            timer.cancel()

        dump.stderr.join(5.0)
        stderr_tail = dump.stderr.text()[-_STDERR_CAPTURE_LIMIT:]

        if timed_out.is_set():
            raise DialInTransportError(
                f"mysqldump against {self._host}:{self._port} exceeded its {self._timeout_seconds}s "
                "timeout and was killed -- refusing to treat this as an ordinary producer failure. "
                f"stderr so far: {stderr_tail!r}"
            )
        if exit_code != 0:
            # Not raised: a nonzero producer exit is pull_encrypt_store.py's
            # ordinary, expected outcome, reported through the return value.
            print(
                f"dial_in_transport: mysqldump against {self._host}:{self._port} exited "
                f"{exit_code}: {stderr_tail}",
                file=sys.stderr,
            )
        return exit_code
