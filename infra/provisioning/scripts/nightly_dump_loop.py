#!/usr/bin/env python3
"""The nightly loop `backup_worker.py`'s own module docstring leaves
open: this is that loop, one `run_tenant_dump` call per tenant, dumped
strictly serially and refusing (never queuing) a second, overlapping
invocation of itself. See README.md in this directory for why both of
those are separate, deliberate guarantees, how tenants are named (no
registry lives in this repository), and how one tenant's failure is kept
from stopping the rest of the run.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import os
import sys
import time
from collections.abc import Callable, Iterable, Sequence

import backup_worker as bw
from dial_in_transport import DialInTransport, LocalProcessTransport, RemoteMysqldumpTransport


class NightlyLoopAlreadyRunning(Exception):
    """Another invocation of this script already holds the run lock."""


class _RunLock:
    """A non-blocking, whole-run `flock` -- see the module docstring's
    point 2. Held for the duration of `main()`'s loop, not per tenant:
    per-tenant serialisation is already structural (a plain `for` loop),
    this lock exists only to refuse a second, OVERLAPPING invocation of
    the whole script."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._handle = None

    def __enter__(self) -> "_RunLock":
        # Opened before the flock attempt so the file exists for a caller
        # to inspect even if the lock is refused.
        self._handle = open(self._path, "a+", encoding="utf-8")
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._handle.close()
            self._handle = None
            raise NightlyLoopAlreadyRunning(
                f"another nightly_dump_loop run already holds {self._path!r} -- refusing to "
                "start a second, overlapping run rather than dumping two tenants at once"
            ) from exc
        return self

    def __exit__(self, *exc_info: object) -> None:
        if self._handle is not None:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            self._handle.close()
            self._handle = None


@dataclasses.dataclass(frozen=True)
class TenantOutcome:
    """One tenant's result, whatever shape the failure took -- a floor
    miss inside `run_tenant_dump` (already a `DumpResult` with `ok=False`)
    or an exception `run_tenant_dump` itself raised or propagated
    (`crashed=True`, `result=None`). The loop's own report is built from a
    list of these, one per tenant attempted, in the order attempted."""

    tenant: str
    result: bw.DumpResult | None
    crashed: bool
    error: str | None

    @property
    def ok(self) -> bool:
        return self.result is not None and self.result.ok


def _dump_one_tenant(
    *,
    tenant: str,
    transport: DialInTransport,
    mysql_pwd: str,
    age_recipient: str,
    dump_tenant_path: str,
    socket_path: str,
) -> TenantOutcome:
    """Runs exactly one tenant's dump through the real `run_tenant_dump`
    entry point, never letting an exception escape -- this is the seam
    `WiringSabotageForResilienceTests` sabotages (by letting the exception
    propagate) to prove one tenant's crash would otherwise abort every
    tenant after it in the loop."""
    try:
        copies = bw._copies_from_env(tenant=tenant)
        result = bw.run_tenant_dump(
            tenant=tenant,
            transport=transport,
            mysql_pwd=mysql_pwd,
            age_recipient=age_recipient,
            copies=copies,
            dump_tenant_path=dump_tenant_path,
            socket_path=socket_path,
        )
    except SystemExit as exc:
        # `_copies_from_env` (via `_copy_target_from_env`) reports a
        # misconfigured copy this way -- a real, operator-facing defect,
        # not a per-tenant one, but still never allowed to take the rest
        # of the night down with it.
        return TenantOutcome(tenant=tenant, result=None, crashed=True, error=str(exc))
    except Exception as exc:  # noqa: BLE001 -- deliberately broad: see the module and function docstrings
        return TenantOutcome(tenant=tenant, result=None, crashed=True, error=f"{type(exc).__name__}: {exc}")

    return TenantOutcome(tenant=tenant, result=result, crashed=False, error=result.error)


def run_nightly_loop(
    *,
    tenants: Sequence[str],
    transport: DialInTransport,
    mysql_pwd: str,
    age_recipient: str,
    dump_tenant_path: str,
    socket_path: str,
    metrics_dir: str,
    now: Callable[[], float] = time.time,
) -> list[TenantOutcome]:
    """The serial loop itself: one `_dump_one_tenant` call per tenant, in
    order, never concurrent, never short-circuited by an earlier tenant's
    failure. Records both metrics per tenant -- the lock-wait gauge
    whenever a wait was measured (success or failure alike), the
    backup-age gauge only on a floor-verified success -- via the SAME
    functions `backup_worker.main()` uses for the on-demand path, so the
    two callers can never drift into writing the metric two different
    ways."""
    outcomes: list[TenantOutcome] = []
    for tenant in tenants:
        outcome = _dump_one_tenant(
            tenant=tenant,
            transport=transport,
            mysql_pwd=mysql_pwd,
            age_recipient=age_recipient,
            dump_tenant_path=dump_tenant_path,
            socket_path=socket_path,
        )
        outcomes.append(outcome)

        result = outcome.result
        if result is not None and result.lock_wait_seconds is not None:
            bw.record_lock_wait_metric(tenant=tenant, metrics_dir=metrics_dir, wait_seconds=result.lock_wait_seconds)
        if result is not None and result.ok:
            bw.record_backup_age_metric(tenant=tenant, metrics_dir=metrics_dir, now=now())

    return outcomes


def _dedupe_preserving_order(names: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def _read_tenants_file(path: str) -> list[str]:
    tenants = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                tenants.append(stripped)
    return tenants


def _report_line(outcome: TenantOutcome) -> str:
    if outcome.ok:
        assert outcome.result is not None
        wait = outcome.result.lock_wait_seconds
        wait_text = f"{wait:.3f}s" if wait is not None else "unmeasured"
        return (
            f"nightly_dump_loop: {outcome.tenant}: ok, lock wait {wait_text}, "
            f"stored to {list(outcome.result.copies_written)}"
        )
    return f"nightly_dump_loop: {outcome.tenant}: FAILED: {outcome.error}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--tenant", dest="tenants", action="append", default=[], help="a tenant slug; repeatable"
    )
    parser.add_argument(
        "--tenants-file",
        help="a file naming one tenant slug per line (blank lines and #-comments ignored)",
    )
    parser.add_argument("--socket", dest="socket_path", default=bw.DEFAULT_SOCKET)
    parser.add_argument("--dump-tenant-path", default=str(bw._DUMP_TENANT_SOURCE))
    parser.add_argument(
        "--run-lock-path",
        default=os.environ.get("NIGHTLY_DUMP_LOOP_RUN_LOCK_PATH", "/run/branchleft/nightly-dump-loop.lock"),
        help="refuses to start a second run while this file is locked by an earlier one",
    )
    parser.add_argument(
        "--local-test-transport",
        action="store_true",
        help=(
            "use LocalProcessTransport instead of running mysqldump for real, over "
            "dial_in_transport.py's RemoteMysqldumpTransport -- local proof only"
        ),
    )
    args = parser.parse_args(argv)

    tenants = list(args.tenants)
    if args.tenants_file:
        tenants.extend(_read_tenants_file(args.tenants_file))
    tenants = _dedupe_preserving_order(tenants)

    if not tenants:
        print("nightly_dump_loop: no tenants named (--tenant / --tenants-file) -- nothing to do", file=sys.stderr)
        return 1

    transport: DialInTransport
    if args.local_test_transport:
        transport = LocalProcessTransport()
    else:
        transport = RemoteMysqldumpTransport(
            host=bw._require_env("BACKUP_WORKER_DB_HOST"),
            user=bw._require_env("BACKUP_WORKER_MYSQL_USER"),
            ssl_ca=bw._require_env("BACKUP_WORKER_MYSQL_SSL_CA"),
            port=int(os.environ.get("BACKUP_WORKER_DB_PORT", "3306")),
        )

    mysql_pwd = bw._require_env("DB_DUMP_MYSQL_PWD")
    age_recipient = bw._require_env("AGE_RECIPIENT_PUBLIC_KEY")
    metrics_dir = os.environ.get("BACKUP_WORKER_METRICS_DIR", bw.DEFAULT_BACKUP_AGE_METRICS_DIR)

    try:
        with _RunLock(args.run_lock_path):
            outcomes = run_nightly_loop(
                tenants=tenants,
                transport=transport,
                mysql_pwd=mysql_pwd,
                age_recipient=age_recipient,
                dump_tenant_path=args.dump_tenant_path,
                socket_path=args.socket_path,
                metrics_dir=metrics_dir,
            )
    except NightlyLoopAlreadyRunning as exc:
        print(f"nightly_dump_loop: {exc}", file=sys.stderr)
        return 1

    for outcome in outcomes:
        print(_report_line(outcome))

    failed = [outcome for outcome in outcomes if not outcome.ok]
    print(f"nightly_dump_loop: {len(outcomes) - len(failed)}/{len(outcomes)} tenants ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
