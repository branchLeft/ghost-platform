#!/usr/bin/env python3
"""The nightly loop `backup_worker.py`'s own module docstring leaves open:
"this module owns nothing about *how* the worker reaches every tenant on a
schedule -- that is the nightly loop's job, built from the same
`run_tenant_dump` call, one invocation per tenant". This is that loop.

branchLeft/workspace#1158's ruling ("lock=a"): every tenant's dump takes a
brief, server-wide `FLUSH TABLES WITH READ LOCK` (see
`backup_worker._LockWaitTimer`'s docstring), so running two dumps at once
would queue two of those locks against each other on top of whatever
ordinary write traffic is already waiting -- worse than the one-at-a-time
cost the risk was already recorded against. This loop enforces two
separate things, deliberately kept separate:

  1. Tenants are dumped ONE AT A TIME, in a plain sequential `for` loop --
     nothing here spawns a thread, a process pool or an async task per
     tenant, so there is no code path that could run two `run_tenant_dump`
     calls concurrently within a single invocation of this script.
  2. A SECOND invocation of this whole script (the scheduler firing again
     while the previous night's run is still going, e.g. after a slow
     tenant or a stuck transport) is refused outright rather than allowed
     to interleave with the first -- `--run-lock-path`, held with a
     non-blocking `flock` for the duration of the run. Refusing beats
     blocking here: a second run queued up behind a stuck first one would
     itself run into the same stuck condition, and a growing queue of
     blocked nightly loops is a worse failure than one skipped night that
     the next scheduled run corrects.

No per-tenant identity or registry lives in this repository (see this
repo's own CLAUDE.md) -- so unlike `db/provision/dump_nightly.py`'s old
`--all-databases` shape, this script is never told to "dump everything";
its caller (the scheduler, wherever the tenant registry actually lives)
must name every tenant explicitly, via `--tenant` (repeatable) and/or
`--tenants-file` (one slug per line, blank lines and `#`-comments
ignored). The two are additive, and the resulting list is de-duplicated,
order preserved, so a caller can combine a small fixed set with a
generated file without double-dumping a tenant present in both.

One tenant's failure -- a floor miss, a transport error, an unexpected
exception `run_tenant_dump` itself does not catch -- must never stop the
rest of the run: `_dump_one_tenant` catches broadly, on purpose, and the
loop always continues to the next tenant. `main()`'s exit code reports
whether every tenant succeeded, but only after every tenant has been
attempted.
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
from dial_in_transport import DialInTransport, LocalProcessTransport, UnwiredCollectorChannelTransport


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
        help="use LocalProcessTransport instead of the real dial-in channel -- local proof only",
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
        transport = UnwiredCollectorChannelTransport()

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
