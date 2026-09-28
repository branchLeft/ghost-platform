#!/usr/bin/env python3
"""The org/control-side backup worker: pulls one tenant's database dump,
encrypts it to that tenant's single `age` recipient, and stores it to both
configured copies.

`run_tenant_dump` is the single-tenant, on-demand call an upgrade pipeline
needs before bumping a tenant's Ghost: it returns a `DumpResult` carrying
the dump's FLOOR result (which floor tables the worker itself watched go
past, independent of the producer's own exit code), not just an exit code
-- see `_FloorWatcher` below for why this worker keeps its own copy of
that check rather than only trusting the producer's.

This module owns nothing about *how* the worker reaches every tenant on a
schedule -- that is the nightly loop's job, built from the same
`run_tenant_dump` call, one invocation per tenant, exactly as
`db/provision/dump_tenant.py`'s own docstring says: "usable both as the
nightly per-tenant loop's one step and as the on-demand dump the upgrade
ring needs before a bump: the same operation, invoked at a different
moment, never a second code path."

DESIGN DECISION -- where `DB_DUMP_MYSQL_PWD` comes from under the pull
model: the dump account's password lives in the SAME place this worker's
`age` recipients already live -- the password manager, read into
org/control's own environment at run time, never written to any file on
the tenant database host, and never the push model's on-host
EnvironmentFile. `run_tenant_dump` takes it as a plain argument for
exactly that reason: the caller (the nightly loop, or an on-demand
invocation) is the one place that secret is resolved, and it is handed to
`pull_encrypt_and_store` as a single-purpose env entry for one invocation,
never persisted anywhere this module touches. `db/provision/dump_tenant.py`'s
own docstring already anticipated this and left the question open for this
module to close; this is that closure.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import fcntl
import importlib.util
import os
import pathlib
import re
import sys
import tempfile
import time
from collections.abc import Callable

import shared_objectstorage
from dial_in_transport import (
    DialInTransport,
    DialInTransportError,
    DumpEndpointTransport,
    LocalProcessTransport,
)
from pull_encrypt_store import CopyTarget, PullEncryptStoreError, pull_encrypt_and_store

# infra/provisioning/scripts/ -> infra/provisioning/ -> infra/ -> repo root.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DUMP_TENANT_SOURCE = _REPO_ROOT / "db" / "provision" / "dump_tenant.py"
_NAMING_SOURCE = _REPO_ROOT / "db" / "provision" / "naming.py"


def _load_module(name: str, source: pathlib.Path, *, register_as: str | None = None):
    """Imports a `db/provision/` module by path, the same technique
    `shared_objectstorage.py` uses to reach `objectstorage.py` -- so
    `FLOOR_TABLES` and tenant-name validation stay defined once, on the
    producer's own side of the trust boundary, rather than drifting between
    two hand-copied constants.

    `register_as`, when given, also registers the loaded module in
    `sys.modules` under that bare name -- `dump_tenant.py` does `from
    naming import (...)` as a plain top-level import, which only resolves
    if something has already put a module named exactly `naming` in
    `sys.modules` (db/provision/ is not on this process's `sys.path`, by
    design: db/RUNBOOK-db.md copies that whole directory to the host with
    `scp -r` and runs scripts in place, never as an installed package)."""
    if not source.is_file():
        raise ImportError(
            f"{source} is missing -- check out the whole of branchLeft/ghost-platform rather "
            "than infra/provisioning/scripts alone"
        )
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise ImportError(f"{source} could not be loaded as a Python module")
    module = importlib.util.module_from_spec(spec)
    if register_as is not None:
        sys.modules[register_as] = module
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 -- surfaced as one clear import failure
        raise ImportError(f"{source} could not be executed: {error!r}") from error
    return module


_naming = _load_module("branchleft_naming", _NAMING_SOURCE, register_as="naming")
_dump_tenant = _load_module("branchleft_dump_tenant", _DUMP_TENANT_SOURCE)

FLOOR_TABLES: tuple[str, ...] = _dump_tenant.FLOOR_TABLES
DEFAULT_SOCKET: str = _dump_tenant.DEFAULT_SOCKET
InvalidTenantName = _naming.InvalidTenantName
validate_tenant_name = _naming.validate_tenant_name


class _FloorWatcher:
    """Watches the plaintext dump go past on its way into `age`'s stdin,
    for exactly the same reason `dump_tenant.py`'s own `run_mysqldump`
    watches it on the producer's side: a nonzero exit is not the only way a
    dump can be worthless, and trusting only the remote process's own
    self-report is the failure `run_tenant_dump`'s own docstring exists to
    not repeat. Independently re-derived here rather than shared across the
    trust boundary -- see the module docstring's `_load_module` note, which
    explains why `FLOOR_TABLES` itself IS shared: the boundary is about not
    letting a credential or an executable cross it, not about constants."""

    def __init__(self, floor_tables: tuple[str, ...]) -> None:
        self._patterns = {table: f"INSERT INTO `{table}` VALUES".encode() for table in floor_tables}
        self.seen: set[str] = set()

    def observe(self, line: bytes) -> None:
        for table, pattern in self._patterns.items():
            if table not in self.seen and line.startswith(pattern):
                self.seen.add(table)

    def assert_floor_met(self) -> None:
        """`pull_encrypt_and_store`'s `post_stream_check` hook -- runs after
        a 0 exit and a confirmed single-recipient ciphertext, but BEFORE any
        copy is written. Raising here is what makes this worker's own
        independent floor watch actually gate storage, rather than merely
        report on it after the copies are already written."""
        missing = frozenset(self._patterns) - self.seen
        if missing:
            raise PullEncryptStoreError(
                f"producer exited 0 but this worker's own stream watch never saw an INSERT for "
                f"{sorted(missing)} -- refusing to store a dump that fails this worker's own "
                "independent floor check, whatever the producer's exit code said"
            )


@dataclasses.dataclass(frozen=True)
class DumpResult:
    """What `run_tenant_dump` returns -- the dump's FLOOR result, not just
    an exit code, for the on-demand caller that needs to know whether the
    dump it just took is trustworthy before acting on it."""

    tenant: str
    ok: bool
    exit_code: int
    floor_tables_seen: frozenset[str]
    missing_floor_tables: frozenset[str]
    copies_written: tuple[str, ...]
    error: str | None


def run_tenant_dump(
    *,
    tenant: str,
    transport: DialInTransport,
    mysql_pwd: str,
    age_recipient: str,
    copies: list[CopyTarget],
    dump_tenant_path: str,
    socket_path: str = DEFAULT_SOCKET,
    python_executable: str = sys.executable,
) -> DumpResult:
    """The single-tenant, on-demand call. `dump_tenant_path` is the path
    `command` invokes `dump_tenant.py` from on whatever host the transport
    reaches -- for `dial_in_transport.LocalProcessTransport` (local proof)
    that is a real filesystem path; a real remote transport, once one is
    wired (see dial_in_transport.py's open item), resolves it in whatever
    way that channel's own remote environment does.

    `env` carries exactly one entry, `DB_DUMP_MYSQL_PWD` -- never
    `AWS_*`/`DB_BACKUP_*`/`AGE_*`, per the per-tenant dump producer's own
    caller contract. Every one of the parameters that WOULD carry a
    storage credential (`age_recipient`,
    `copies`) is consumed by `pull_encrypt_and_store` on this side of the
    dial-in call, never forwarded across it.
    """
    validate_tenant_name(tenant)

    watcher = _FloorWatcher(FLOOR_TABLES)
    command = [python_executable, dump_tenant_path, tenant, "--socket", socket_path]
    env = {"DB_DUMP_MYSQL_PWD": mysql_pwd}

    try:
        result = pull_encrypt_and_store(
            transport=transport,
            command=command,
            env=env,
            age_recipient=age_recipient,
            copies=copies,
            chunk_watcher=watcher.observe,
            post_stream_check=watcher.assert_floor_met,
        )
    except PullEncryptStoreError as exc:
        # `assert_floor_met` raising, a stanza count other than 1, `age`
        # failing, or a copy's `put` raising -- every one of these means no
        # copy was ever written for this run (a plain nonzero producer exit
        # does not raise; it comes back as `result.ok=False` below).
        missing = frozenset(FLOOR_TABLES) - frozenset(watcher.seen)
        return DumpResult(
            tenant=tenant,
            ok=False,
            exit_code=-1,
            floor_tables_seen=frozenset(watcher.seen),
            missing_floor_tables=missing,
            copies_written=(),
            error=str(exc),
        )

    seen = frozenset(watcher.seen)
    return DumpResult(
        tenant=tenant,
        ok=result.ok,
        exit_code=result.exit_code,
        floor_tables_seen=seen,
        missing_floor_tables=frozenset(FLOOR_TABLES) - seen,
        copies_written=tuple(result.copies_written),
        error=result.error,
    )


# The two copies' env-var prefixes. "primary" is the backup-only Hetzner
# project the platform owner has ruled this bucket belongs in -- provisioning
# it is an owner action, see the accompanying PR body, and it is REQUIRED:
# main() refuses to run at all without it. "secondary" is the off-supplier
# second copy 09-backup-and-recovery.html's own custody figure names
# ("Second copy, off-supplier -- survives losing the account, not merely
# losing a host"); which provider holds it is a still-open decision this
# module does not make, so it is OPTIONAL until that decision names one --
# entirely absent, this worker still runs with the primary copy alone,
# which is the interim plan the accompanying PR body's Owner-action section
# states. A copy that is PARTIALLY configured (some but not all of its five
# credential vars set) is never accepted either way, required or optional:
# that shape is far more likely to be a typo or a half-finished rollout than
# a deliberate choice, and running on it would silently drop the copy the
# operator thought they had just configured.
REQUIRED_COPY_NAMES: tuple[str, ...] = ("primary",)
OPTIONAL_COPY_NAMES: tuple[str, ...] = ("secondary",)

# The five credential vars every copy needs -- OBJECT_KEY_PREFIX is a
# separate, independently-defaulted override and never counts toward
# whether a copy is "configured" at all.
_COPY_CREDENTIAL_VAR_SUFFIXES: tuple[str, ...] = (
    "BUCKET",
    "ENDPOINT",
    "REGION",
    "ACCESS_KEY_ID",
    "SECRET_ACCESS_KEY",
)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"backup_worker: {name} must be set")
    return value


def _copy_target_from_env(*, copy_name: str, tenant: str, required: bool) -> CopyTarget | None:
    """Builds one `CopyTarget` from `BACKUP_WORKER_COPY_<NAME>_*` env vars,
    or returns `None` for an OPTIONAL copy that is entirely unconfigured.
    This function is the only place in this module that reads a storage
    credential, and it never returns it -- `put` below closes over it and
    the credential itself is never stored on the `CopyTarget` or logged.

    Three outcomes, never a fourth: every credential var present (a
    `CopyTarget`); none of them present and `required=False` (`None`, this
    copy is skipped); anything else -- a required copy missing any of its
    vars, or an optional copy with SOME but not all of them set -- refuses
    outright, naming exactly which vars are missing."""
    prefix = f"BACKUP_WORKER_COPY_{copy_name.upper()}_"
    var_names = tuple(prefix + suffix for suffix in _COPY_CREDENTIAL_VAR_SUFFIXES)
    values = {name: os.environ.get(name) for name in var_names}
    set_names = [name for name, value in values.items() if value]
    missing_names = [name for name, value in values.items() if not value]

    if not set_names and not required:
        return None

    if missing_names:
        raise SystemExit(
            f"backup_worker: the {copy_name!r} copy is missing {', '.join(sorted(missing_names))} -- "
            + (
                "every one of its credential vars must be set"
                if required
                else "either set every one of its credential vars, or none at all to leave this "
                "optional copy unconfigured"
            )
        )

    bucket = values[prefix + "BUCKET"]
    endpoint = values[prefix + "ENDPOINT"]
    region = values[prefix + "REGION"]
    access_key = values[prefix + "ACCESS_KEY_ID"]
    secret_key = values[prefix + "SECRET_ACCESS_KEY"]
    key_prefix = os.environ.get(prefix + "OBJECT_KEY_PREFIX", "dumps/")

    def _put(ciphertext: bytes) -> None:
        now = datetime.datetime.now(datetime.timezone.utc)
        object_key = f"{key_prefix}{tenant}/{now.strftime('%Y%m%dT%H%M%SZ')}.sql.age"
        shared_objectstorage.put_object(
            bucket=bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            key=object_key,
            data=ciphertext,
        )

    return CopyTarget(name=copy_name, put=_put)


def _copies_from_env(*, tenant: str) -> list[CopyTarget]:
    """Every copy `main()` should write to today: every REQUIRED copy
    (refuses if any is missing or partially configured), plus every
    OPTIONAL copy that is either fully configured or entirely absent --
    never one that is half set up. Which copies come back is driven by
    what is actually configured in the environment, not a fixed count."""
    copies: list[CopyTarget] = []
    for name in REQUIRED_COPY_NAMES:
        target = _copy_target_from_env(copy_name=name, tenant=tenant, required=True)
        assert target is not None  # required=True never returns None
        copies.append(target)
    for name in OPTIONAL_COPY_NAMES:
        target = _copy_target_from_env(copy_name=name, tenant=tenant, required=False)
        if target is not None:
            copies.append(target)
    return copies


# 09-backup-and-recovery.html S:signal is explicit that the monitored signal
# is "the age of the newest successful backup, per tenant, reported by the
# side that would notice it stopping" -- this worker, on the org/control
# side, never the tenant host, which under the pull model holds no way to
# report anything about its own backups at all. hetzner/monitoring already
# has one collector shaped exactly like this one needs to be
# (snds-collector: a node_exporter textfile-collector file, written
# atomically, read back and merged rather than overwritten) -- reused here
# rather than re-derived. Outside /opt/branchleft/ for the same reason that
# collector's own output directory is: a directory under /opt/branchleft/
# is what a stack's own `--delete` rsync deploy can wipe.
DEFAULT_BACKUP_AGE_METRICS_DIR = "/var/lib/branchleft/backup-worker-exporter"
BACKUP_AGE_METRIC_FILENAME = "backup_worker.prom"

BACKUP_AGE_METRIC_NAME = "backup_worker_last_success_timestamp_seconds"

# Matches exactly what render_backup_age_prometheus_text below writes for
# one tenant, so a read of this module's own prior output round-trips.
# Not a general Prometheus exposition-format parser -- it only ever reads
# back a file this module wrote (see record_backup_age_metric's merge
# below), never a foreign one.
_BACKUP_AGE_METRIC_LINE = re.compile(
    r'\A' + re.escape(BACKUP_AGE_METRIC_NAME) + r'\{tenant="([^"]*)"\}\s+([0-9]+(?:\.[0-9]+)?)\s*\Z'
)


def _escape_label_value(value: str) -> str:
    """Prometheus exposition-format escaping for a label value.
    `naming.validate_tenant_name` already restricts every tenant name this
    worker is ever called with to `[a-z0-9-]`, so nothing here can contain a
    quote, a backslash or a newline today -- this exists so a future
    relaxation of that charset cannot silently write a `.prom` file
    node_exporter fails to parse, rather than because a real tenant name
    needs it."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _parse_previous_backup_age_metrics(text: str) -> dict[str, float]:
    """Reads back whatever this module itself last wrote for every tenant.

    `main()` dumps exactly one tenant per invocation (the module docstring:
    "one invocation per tenant"), so a write that did not first read the
    existing file would erase every OTHER tenant's timestamp on each run --
    which, to the alert reading this file, looks exactly like every other
    tenant's backups had just stopped."""
    timestamps: dict[str, float] = {}
    for line in text.splitlines():
        match = _BACKUP_AGE_METRIC_LINE.match(line.strip())
        if match:
            timestamps[match.group(1)] = float(match.group(2))
    return timestamps


def render_backup_age_prometheus_text(timestamps: dict[str, float]) -> str:
    """Pure formatting -- the textfile-collector exposition format
    node_exporter reads, one gauge per tenant. Tenant names are escaped
    (see `_escape_label_value`) even though today's charset never requires
    it, matching hetzner/monitoring's own snds collector's reasoning for
    validating before, rather than trusting, a value that reaches a label."""
    lines = [
        f"# HELP {BACKUP_AGE_METRIC_NAME} Unix time this worker last wrote a successful, "
        "floor-verified dump for this tenant.",
        f"# TYPE {BACKUP_AGE_METRIC_NAME} gauge",
    ]
    for tenant in sorted(timestamps):
        lines.append(f'{BACKUP_AGE_METRIC_NAME}{{tenant="{_escape_label_value(tenant)}"}} {timestamps[tenant]}')
    return "\n".join(lines) + "\n"


BACKUP_AGE_METRIC_LOCK_FILENAME = BACKUP_AGE_METRIC_FILENAME + ".lock"


def write_textfile_atomically(path: pathlib.Path, content: str) -> None:
    """Matches hetzner/monitoring's own snds collector: node_exporter's
    `--collector.textfile.directory` polls this directory and can scrape a
    non-atomic write mid-write, as a truncated or malformed file. Writing to
    a sibling temp file and `os.replace`-ing it into place is atomic on the
    same filesystem.

    The temp name is unique per call (`tempfile.mkstemp`, not a fixed
    `<name>.tmp`) -- a fixed name is safe only for a single writer at a
    time, and this file is written by `record_backup_age_metric` under a
    lock that already serialises writers, but a lock one caller forgot to
    take (or a future second caller of this same helper) must not then be
    able to have two `.tmp` files collide and rename whichever one lost the
    race into place. A unique name removes that failure mode regardless of
    what does or does not protect the call above this one."""
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        # Not a secret -- explicit 0644 rather than trusting umask, since
        # node_exporter reads this as its own container-side user, not as
        # whoever wrote the file.
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise


def record_backup_age_metric(
    *,
    tenant: str,
    metrics_dir: str,
    now: float,
    _use_lock: bool = True,
    _after_read: Callable[[], None] | None = None,
) -> None:
    """Records `tenant`'s last-good-backup timestamp, merged with every
    OTHER tenant this module has previously recorded into the same file.
    Called from `main()` only after a floor-verified, `ok=True` result --
    never for a run that failed, so a stopped tenant's gauge simply stops
    advancing rather than being overwritten with a fresh, misleadingly
    healthy-looking timestamp.

    The read, the merge and the write are one critical section, held under
    an exclusive `fcntl.flock` on a sibling lock file for the whole
    duration. Without it, two tenants completing a floor-verified dump
    close together can both read the same prior file, and whichever writes
    second silently reverts the other's fresh, real success back to its
    stale value -- turning a HEALTHY tenant's gauge stale, which is the
    opposite failure from the one this signal exists to catch (see
    `BackupAgeMetricConcurrencyTests` for a deterministic, forced
    reproduction of exactly that loss).

    `_use_lock` and `_after_read` exist only for that test's forced
    interleave -- `main()` never passes either, so every real caller always
    takes the lock and never pauses mid-critical-section.

    Best-effort and never raises: a metrics-directory or lock-file write
    failure must never turn an already-successful, already-stored dump
    into a failed run -- the backup itself is good whether or not this
    exporter can report it, and a metric that stops advancing because this
    call itself keeps failing is caught by the same growing-age alert as a
    worker that has stopped running at all."""

    def _read_merge_write(output_path: pathlib.Path) -> None:
        try:
            existing = output_path.read_text()
        except FileNotFoundError:
            existing = ""
        timestamps = _parse_previous_backup_age_metrics(existing)
        if _after_read is not None:
            _after_read()
        timestamps[tenant] = now
        write_textfile_atomically(output_path, render_backup_age_prometheus_text(timestamps))

    try:
        output_dir = pathlib.Path(metrics_dir)
        output_dir.mkdir(parents=True, exist_ok=True, mode=0o755)
        output_path = output_dir / BACKUP_AGE_METRIC_FILENAME

        if not _use_lock:
            _read_merge_write(output_path)
            return

        lock_path = output_dir / BACKUP_AGE_METRIC_LOCK_FILENAME
        with open(lock_path, "a+", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            try:
                _read_merge_write(output_path)
            finally:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
    except OSError as exc:
        print(
            f"backup_worker: {tenant}: could not write the backup-age metric to "
            f"{metrics_dir!r}: {exc}",
            file=sys.stderr,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", required=True, help="the tenant slug, e.g. 'blog'")
    parser.add_argument("--socket", dest="socket_path", default=DEFAULT_SOCKET)
    parser.add_argument(
        "--dump-tenant-path",
        default=str(_DUMP_TENANT_SOURCE),
        help="where dump_tenant.py is reachable from the transport's own side",
    )
    parser.add_argument(
        "--local-test-transport",
        action="store_true",
        help=(
            "use LocalProcessTransport instead of the real dial-in channel -- for proof "
            "against local containers only, never for a real tenant. Without this flag, "
            "main() dials DUMP_ENDPOINT_BASE_URL for real, over dial_in_transport.py's "
            "DumpEndpointTransport"
        ),
    )
    args = parser.parse_args(argv)

    transport: DialInTransport
    if args.local_test_transport:
        transport = LocalProcessTransport()
    else:
        transport = DumpEndpointTransport(
            base_url=_require_env("DUMP_ENDPOINT_BASE_URL"),
            bearer_token=_require_env("DUMP_ENDPOINT_BEARER_TOKEN"),
        )

    mysql_pwd = _require_env("DB_DUMP_MYSQL_PWD")
    age_recipient = _require_env("AGE_RECIPIENT_PUBLIC_KEY")
    copies = _copies_from_env(tenant=args.tenant)

    try:
        result = run_tenant_dump(
            tenant=args.tenant,
            transport=transport,
            mysql_pwd=mysql_pwd,
            age_recipient=age_recipient,
            copies=copies,
            dump_tenant_path=args.dump_tenant_path,
            socket_path=args.socket_path,
        )
    except (InvalidTenantName, NotImplementedError, DialInTransportError) as exc:
        print(f"backup_worker: {exc}", file=sys.stderr)
        return 1

    if not result.ok:
        print(f"backup_worker: {args.tenant}: {result.error}", file=sys.stderr)
        return 1

    print(
        f"backup_worker: {args.tenant}: floor tables seen {sorted(result.floor_tables_seen)}, "
        f"stored to {list(result.copies_written)}"
    )
    # Only reached for a floor-verified result.ok=True, per 09-backup-and-
    # recovery.html's decision table: the monitored gauge advances on a
    # successful floor result, never on the strength of the worker having
    # merely run.
    record_backup_age_metric(
        tenant=args.tenant,
        metrics_dir=os.environ.get("BACKUP_WORKER_METRICS_DIR", DEFAULT_BACKUP_AGE_METRICS_DIR),
        now=time.time(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
