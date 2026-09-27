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
import importlib.util
import os
import pathlib
import sys

import shared_objectstorage
from dial_in_transport import DialInTransport, LocalProcessTransport, UnwiredCollectorChannelTransport
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
            "main() uses UnwiredCollectorChannelTransport and refuses to run at all, because "
            "no production channel is wired yet (see dial_in_transport.py's open item)"
        ),
    )
    args = parser.parse_args(argv)

    transport: DialInTransport
    if args.local_test_transport:
        transport = LocalProcessTransport()
    else:
        transport = UnwiredCollectorChannelTransport()

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
    except (InvalidTenantName, NotImplementedError) as exc:
        print(f"backup_worker: {exc}", file=sys.stderr)
        return 1

    if not result.ok:
        print(f"backup_worker: {args.tenant}: {result.error}", file=sys.stderr)
        return 1

    print(
        f"backup_worker: {args.tenant}: floor tables seen {sorted(result.floor_tables_seen)}, "
        f"stored to {list(result.copies_written)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
