#!/usr/bin/env python3
"""Restore a tenant's dump onto a drained colour, and undrain it last.

Implements the one ordered chain design 09's own measurement names: MySQL
readiness on the recovery target, the dump import, a content assertion
against the colour that just came up, and only then clearing the drain
flag. The chain never runs in any other order -- see `run_drained_restore`'s
own doc comment for why a failure at any stage must leave the flag alone.

**The control this module exists to make impossible to skip:** a Ghost
pointed at a schema with no data still boots its own migrations and serves
`200`. `verify_tenant_content` never treats a `200` as success by itself;
it polls for a named, tenant-specific string in the rendered page, and an
empty restore fails that check for as long as it is asked -- loudly,
because "the colour came up" was never the assertion.

**Where this restores to, and where it must never restore to.** The dump
this reads is exactly what `dump_tenant.py` writes: one tenant's
`--databases` dump, carrying its own `CREATE DATABASE IF NOT EXISTS` and
`USE`. Imported onto a target that already holds a database of that name,
those two statements restore INTO it rather than beside it -- the same
collision `db/RUNBOOK-db.md`'s own restore-drill note describes for the
estate-wide dump. `host`/`port` here are never `db1` (or whatever host
currently serves this tenant); they name the drained colour's own,
otherwise-empty database target -- and `restore_only` now checks that
itself before importing anything: it refuses, without touching the
target, if it already holds any non-system database at all. A recovery
target is expected to be a fresh host with nothing on it yet, not merely
a different one, so "empty" is the whole bar rather than a name match
against the tenant being restored.

**Why this never touches the flag itself, except to clear it.** LLD-2's
broker owns the drain flag (`services/broker/src/drainFlag.ts`) and is what
brings a colour up already drained, before this module's `host`/`port` ever
answer a query. This module only ever removes the flag file, as its last
successful step -- `services/drain-sidecar`'s own contract is mere presence
via `lstat`, so clearing is exactly the file removal
`services/broker/src/drainFlag.ts`'s `removeFileIfPresent` performs, done
here in Python because this process has no Node runtime to call into. It
never sets the flag: setting it is the bring-up step that must already have
happened before restore starts, not this module's job.
"""

from __future__ import annotations

import argparse
import http.client
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_MYSQL_READY_TIMEOUT_S = 60.0
DEFAULT_CONTENT_TIMEOUT_S = 90.0
POLL_INTERVAL_S = 1.0

# What every MySQL 8.0 server carries before anything is provisioned on it --
# the bar a recovery target must clear, not a name to match against the
# tenant being restored.
SYSTEM_DATABASES = frozenset({"information_schema", "mysql", "performance_schema", "sys"})

# Same shape as dump_tenant.py's own child-process allowlist: PATH so the
# mysql binary resolves by name, MYSQL_PWD added per call as a value rather
# than carried here as a name.
CHILD_ENV_ALLOWLIST = ("PATH",)


class RestoreError(Exception):
    """A stage of the restore-onto-a-drained-colour chain did not complete."""


class ReadinessError(RestoreError):
    """The recovery target never answered `SELECT 1` within the deadline."""


class DumpImportError(RestoreError):
    """`mysql` exited non-zero while importing the dump."""


class LiveDatabaseCollisionError(RestoreError):
    """The recovery target already holds at least one non-system database.
    Raised before anything is imported: the dump's own `CREATE DATABASE IF
    NOT EXISTS`/`USE` statements would restore INTO whatever is already
    there rather than beside it, so a target that fails this check must
    never reach `restore_dump` at all."""


class ContentVerificationError(RestoreError):
    """The colour never served the expected tenant content before the
    deadline -- either because nothing ever answered `200`, or because it
    answered `200` without the expected content. The two are reported
    differently on purpose: the second is design 09's own control case
    (an empty restore), and collapsing it into "didn't come up" would hide
    exactly the failure this module exists to catch."""


def _child_env(password: str) -> dict[str, str]:
    env = {name: os.environ[name] for name in CHILD_ENV_ALLOWLIST if name in os.environ}
    env["MYSQL_PWD"] = password
    return env


def wait_for_mysql_ready(
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    timeout_s: float = DEFAULT_MYSQL_READY_TIMEOUT_S,
    poll_s: float = POLL_INTERVAL_S,
    run=subprocess.run,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """Polls a real `SELECT 1` rather than `mysqladmin ping` -- design 09
    07c's own measurement draws this distinction, because `ping` answers
    before a server that is still applying its own startup work can
    actually serve a query."""
    deadline = now() + timeout_s
    last_error = "never attempted"
    while True:
        result = run(
            ["mysql", "--host", host, "--port", str(port), "--user", user, "-e", "SELECT 1;"],
            env=_child_env(password),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return
        last_error = result.stderr.strip()
        if now() >= deadline:
            break
        sleep(poll_s)
    raise ReadinessError(f"mysql at {host}:{port} did not answer SELECT 1 within {timeout_s}s: {last_error}")


def assert_target_has_no_live_database(
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    run=subprocess.run,
) -> None:
    """The refusal a per-tenant dump's own `CREATE DATABASE IF NOT EXISTS`/
    `USE` statements make necessary: they restore INTO whatever database of
    that name already exists on `host`:`port`, so a target that already
    holds one is corrupted by import, not merely at risk of it. Lists every
    database the target already has and refuses on the first one that
    isn't a stock MySQL system database -- never a name match against the
    tenant being restored, because the whole point is that a recovery
    target must be an empty host, not merely a different one. Touches
    nothing: `SHOW DATABASES` is read-only, and this raises before
    `restore_dump` is ever called."""
    result = run(
        ["mysql", "--host", host, "--port", str(port), "--user", user, "-N", "-B", "-e", "SHOW DATABASES;"],
        env=_child_env(password),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReadinessError(f"mysql at {host}:{port} could not list its databases: {result.stderr.strip()}")
    present = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    live = sorted(present - SYSTEM_DATABASES)
    if live:
        raise LiveDatabaseCollisionError(
            f"{host}:{port} already holds {', '.join(live)} -- refusing to import onto a recovery target "
            "that is not empty. Restoring here would write into whatever already has that name, not "
            "beside it; point this at a fresh host with nothing provisioned on it yet."
        )


def restore_dump(
    *,
    dump_path: str,
    host: str,
    port: int,
    user: str,
    password: str,
    run=subprocess.run,
) -> None:
    """Imports a plain SQL dump -- exactly what `dump_tenant.py` writes to
    its stdout, saved to `dump_path` unmodified -- into whatever server
    `host`:`port` names. See the module docstring for why that target must
    never be a host already holding a live copy of this tenant's database."""
    with open(dump_path, "rb") as dump_file:
        result = run(
            ["mysql", "--host", host, "--port", str(port), "--user", user],
            stdin=dump_file,
            env=_child_env(password),
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise DumpImportError(
            f"mysql import of {dump_path} into {host}:{port} exited {result.returncode}: {result.stderr.strip()}"
        )


def _default_get(url: str, timeout_s: float) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"X-Forwarded-Proto": "https"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310 -- fixed http(s) URL, not user input
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
        return 0, str(exc)


def verify_tenant_content(
    *,
    base_url: str,
    expected_post_body: str,
    timeout_s: float = DEFAULT_CONTENT_TIMEOUT_S,
    poll_s: float = POLL_INTERVAL_S,
    get=_default_get,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """The one assertion this whole module exists to make: a `200` is never
    read as success on its own. Polls until `expected_post_body` appears in
    the rendered page (real success) or the deadline passes. Distinguishes,
    in what it raises, "never answered 200 at all" from "answered 200
    without the expected content" -- the second is the empty-database
    control, and it must fail this check for as long as it is asked, not
    merely until Ghost happens to finish booting."""
    deadline = now() + timeout_s
    saw_200 = False
    last_status = 0
    while True:
        status, body = get(base_url, timeout_s=min(poll_s * 5, 10))
        if status == 200:
            saw_200 = True
            if expected_post_body in body:
                return
        last_status = status
        if now() >= deadline:
            break
        sleep(poll_s)
    if not saw_200:
        raise ContentVerificationError(
            f"{base_url} never answered 200 within {timeout_s}s (last status: {last_status})"
        )
    raise ContentVerificationError(
        f"{base_url} answered 200 but never carried the expected content ({expected_post_body!r} not found) -- "
        "a Ghost on an empty database serves 200 too; presence of a response is never the check"
    )


def clear_drain_flag(flag_path: str) -> None:
    """Presence is the whole contract (`services/drain-sidecar`'s own
    `createFileDrainFlag`), so clearing is exactly removing the directory
    entry -- mirroring `services/broker/src/drainFlag.ts`'s
    `removeFileIfPresent`, not calling into it, since this process has no
    Node runtime to call into."""
    try:
        os.remove(flag_path)
    except FileNotFoundError:
        pass


def restore_only(
    *,
    dump_path: str,
    host: str,
    port: int,
    user: str,
    password: str,
    mysql_ready_timeout_s: float = DEFAULT_MYSQL_READY_TIMEOUT_S,
    run=subprocess.run,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """The first half of the chain, for a caller that must start the colour's
    own Ghost process in between restoring the dump and verifying it --
    Ghost has to exist against a populated (or, in the control case,
    deliberately empty) database before anything can be asked of it over
    HTTP. Touches the flag not at all.

    Refuses -- via `assert_target_has_no_live_database`, unconditionally,
    with no flag to bypass it -- before importing anything, if the target
    already holds a non-system database. That call sits between readiness
    and the import on purpose: it needs a live connection to list what is
    already there, and it must run before `restore_dump` gets anywhere
    near the target, not merely before this function returns."""
    wait_for_mysql_ready(
        host=host, port=port, user=user, password=password,
        timeout_s=mysql_ready_timeout_s, run=run, sleep=sleep, now=now,
    )
    assert_target_has_no_live_database(host=host, port=port, user=user, password=password, run=run)
    restore_dump(dump_path=dump_path, host=host, port=port, user=user, password=password, run=run)


def verify_and_undrain(
    *,
    base_url: str,
    expected_post_body: str,
    flag_path: str,
    content_timeout_s: float = DEFAULT_CONTENT_TIMEOUT_S,
    get=_default_get,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """The second half: the same verify-then-undrain tail `run_drained_restore`
    ends with, exposed on its own so a caller who ran `restore_only` and then
    started the colour's Ghost process can complete the chain against it."""
    verify_tenant_content(
        base_url=base_url, expected_post_body=expected_post_body,
        timeout_s=content_timeout_s, get=get, sleep=sleep, now=now,
    )
    clear_drain_flag(flag_path)


def run_drained_restore(
    *,
    dump_path: str,
    host: str,
    port: int,
    user: str,
    password: str,
    base_url: str,
    expected_post_body: str,
    flag_path: str,
    mysql_ready_timeout_s: float = DEFAULT_MYSQL_READY_TIMEOUT_S,
    content_timeout_s: float = DEFAULT_CONTENT_TIMEOUT_S,
    run=subprocess.run,
    get=_default_get,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """The ordered chain design 09 07c names, and the only thing this
    function promises: readiness, restore, verify tenant-specific content,
    and only then clear the flag. `flag_path` must already be set -- by
    whatever brought the colour up drained -- before this runs; this
    function never sets it, only ever clears it, and only as the last thing
    it does on success. A failure at any earlier stage propagates without
    touching the flag, so a restore that turns out wrong is discarded by
    leaving the colour drained, never by undoing an undrain that already
    happened. Composed from `restore_only` and `verify_and_undrain` rather
    than repeating their bodies -- a caller whose colour's Ghost process
    must start in between the two (the ordinary case) calls those directly;
    this exists for a caller whose target already has a running Ghost
    process to verify against."""
    restore_only(
        dump_path=dump_path,
        host=host,
        port=port,
        user=user,
        password=password,
        mysql_ready_timeout_s=mysql_ready_timeout_s,
        run=run,
        sleep=sleep,
        now=now,
    )
    verify_and_undrain(
        base_url=base_url,
        expected_post_body=expected_post_body,
        flag_path=flag_path,
        content_timeout_s=content_timeout_s,
        get=get,
        sleep=sleep,
        now=now,
    )


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RestoreError(f"{name} must be set")
    return value


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--mode",
        choices=("full", "restore-only", "verify-and-undrain"),
        default="full",
        help=(
            "full: the whole chain against an already-running colour (default). "
            "restore-only: readiness + import, before that colour's Ghost process exists. "
            "verify-and-undrain: the tail, once that Ghost process is up."
        ),
    )
    parser.add_argument("--dump", dest="dump_path", help="path to a plain SQL dump on disk (full, restore-only)")
    parser.add_argument("--host", help="the recovery target's MySQL host -- never a live tenant host (full, restore-only)")
    parser.add_argument("--port", type=int, default=3306)
    parser.add_argument("--user", default="root")
    parser.add_argument("--base-url", dest="base_url", help="the drained colour's own origin (full, verify-and-undrain)")
    parser.add_argument("--expect", dest="expected_post_body", help="a known, tenant-specific string (full, verify-and-undrain)")
    parser.add_argument("--flag-path", dest="flag_path", help="cleared only on full success (full, verify-and-undrain)")
    parser.add_argument(
        "--mysql-ready-timeout", type=float, default=DEFAULT_MYSQL_READY_TIMEOUT_S, dest="mysql_ready_timeout_s"
    )
    parser.add_argument(
        "--content-timeout", type=float, default=DEFAULT_CONTENT_TIMEOUT_S, dest="content_timeout_s"
    )
    args = parser.parse_args(argv)

    def require(name: str, value: object) -> None:
        if not value:
            raise RestoreError(f"--{name} is required for --mode {args.mode}")

    try:
        if args.mode in ("full", "restore-only"):
            require("dump", args.dump_path)
            require("host", args.host)
        if args.mode in ("full", "verify-and-undrain"):
            require("base-url", args.base_url)
            require("expect", args.expected_post_body)
            require("flag-path", args.flag_path)

        if args.mode == "restore-only":
            password = _require_env("RESTORE_MYSQL_PWD")
            restore_only(
                dump_path=args.dump_path,
                host=args.host,
                port=args.port,
                user=args.user,
                password=password,
                mysql_ready_timeout_s=args.mysql_ready_timeout_s,
            )
            print(f"restore_drained: imported {args.dump_path} into {args.host}:{args.port}")
        elif args.mode == "verify-and-undrain":
            verify_and_undrain(
                base_url=args.base_url,
                expected_post_body=args.expected_post_body,
                flag_path=args.flag_path,
                content_timeout_s=args.content_timeout_s,
            )
            print(f"restore_drained: verified and undrained {args.flag_path}")
        else:
            password = _require_env("RESTORE_MYSQL_PWD")
            run_drained_restore(
                dump_path=args.dump_path,
                host=args.host,
                port=args.port,
                user=args.user,
                password=password,
                base_url=args.base_url,
                expected_post_body=args.expected_post_body,
                flag_path=args.flag_path,
                mysql_ready_timeout_s=args.mysql_ready_timeout_s,
                content_timeout_s=args.content_timeout_s,
            )
            print(f"restore_drained: restored, verified and undrained {args.flag_path}")
    except RestoreError as exc:
        print(f"restore_drained: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 -- an operator's terminal, mid-incident, gets a clean line, not a traceback
        # Every real call path above raises RestoreError (or its own
        # subclass) before `clear_drain_flag` is ever reached, so an
        # exception this broad still leaves the flag exactly where a
        # RestoreError would have -- this widens what gets a clean message,
        # never what is allowed to undrain.
        print(f"restore_drained: unexpected error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
