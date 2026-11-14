#!/usr/bin/python3 -I
"""The pre-swap scratch-copy gate, part 1. Restores a tenant's newest verified
backup into a throwaway MySQL server and refuses, with a nonzero exit, unless
the restored database equals what the backup recorded about itself. It holds no
address for the tenant's database host and never connects to it. See
scratch_preflight.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import os
import pathlib
import secrets
import shutil
import signal
import sys
from collections.abc import Mapping, Sequence

# `-I` drops the script's own directory from the import path; the siblings this
# imports by name are put back explicitly, from this file's resolved location.
_HERE = str(pathlib.Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import backup_manifest  # noqa: E402
import backup_worker as bw  # noqa: E402
import restore_drill as rd  # noqa: E402
import shared_objectstorage  # noqa: E402

restore_drained = rd.restore_drained

SCRATCH_LABEL = "branchleft.scratch-preflight"
RUN_DIR_PREFIX = "preflight-run-"
LOCK_NAME = "preflight.lock"
EXIT_REFUSED = 1
EXIT_NOT_RUN = 2


class ScratchStartError(rd.DrillError):
    """The throwaway server could not be created."""


# What Docker says, in either of its wordings, about a thing that is not there.
ALREADY_GONE = ("no such", "not found")


class ScratchDiscardError(rd.DrillError):
    """Something the gate created could not be removed."""


def run_removals(runner: rd.Runner, commands: Sequence[list[str]]) -> None:
    """Runs every removal whatever an earlier one did, so one that fails never
    leaves the rest undone, then raises once, naming each that did. A thing that
    is already gone is not a failure. A SIGTERM or an interrupt that lands in
    the middle is held until every removal has been tried, then raised."""
    failures: list[str] = []
    held: BaseException | None = None
    for argv in commands:
        what = " ".join(argv[1:3])
        try:
            result = runner(argv, capture_output=True, text=True, check=False, env=rd._child_env())
        except BaseException as exc:  # noqa: BLE001 -- the removals after this one must still run
            if not isinstance(exc, Exception) and held is None:
                held = exc
            failures.append(f"{what}: {type(exc).__name__}: {exc}")
            continue
        stderr = (result.stderr or "").strip()
        if result.returncode != 0 and not any(gone in stderr.lower() for gone in ALREADY_GONE):
            failures.append(f"{what}: {stderr or 'docker exited nonzero'}")
    if held is not None:
        raise held
    if failures:
        raise ScratchDiscardError("could not remove the scratch copy: " + "; ".join(failures))


@dataclasses.dataclass
class ScratchMysql:
    """One throwaway MySQL server, on a Docker network with no route out of the
    host, whose datadir is memory. Everything it holds goes with it."""

    runner: rd.Runner
    run_id: str
    image: str
    memory: str
    password: str = dataclasses.field(default_factory=lambda: secrets.token_urlsafe(24), repr=False)

    @property
    def network(self) -> str:
        return f"scratch-preflight-{self.run_id}"

    @property
    def container(self) -> str:
        return f"scratch-preflight-mysql-{self.run_id}"

    def _docker(self, argv: list[str], *, env_extra: Mapping[str, str] | None = None) -> str:
        result = self.runner(
            ["docker", *argv], capture_output=True, text=True, check=False, env=rd._child_env(env_extra)
        )
        if result.returncode != 0:
            raise ScratchStartError(f"docker {argv[0]} failed: {(result.stderr or '').strip()}")
        return result.stdout or ""

    def start(self) -> None:
        label = ["--label", f"{SCRATCH_LABEL}={self.run_id}"]
        self._docker(["network", "create", "--internal", *label, self.network])
        self._docker(
            ["run", "-d", "--name", self.container, "--network", self.network, "--memory", self.memory,
             "--tmpfs", f"{rd.MYSQL_DATADIR}:rw,noexec,nosuid,size={rd.MYSQL_TMPFS_SIZE}", *label,
             "-e", "MYSQL_ROOT_PASSWORD", self.image],
            env_extra={"MYSQL_ROOT_PASSWORD": self.password},
        )

    def mysql_runner(self, recovery_image: str) -> rd.Runner:
        """Every `mysql` call runs in the pinned recovery image, on this server's
        network, with the password as an environment value and never in argv."""
        return rd.container_mysql_runner(runner=self.runner, image=recovery_image, network=self.network)

    def discard(self) -> None:
        """Safe to call whether or not `start` got as far as creating anything.
        The network cannot go while a container is attached, so the server goes
        first; both are tried, and a removal that failed is raised after."""
        run_removals(self.runner, [
            ["docker", "rm", "-f", "-v", self.container],
            ["docker", "network", "rm", self.network],
        ])


def sweep_leftovers(runner: rd.Runner) -> None:
    """Removes every labelled server and network a killed run left behind."""
    def docker(argv: list[str]) -> str:
        result = runner(["docker", *argv], capture_output=True, text=True, check=False, env=rd._child_env())
        if result.returncode != 0:
            raise rd.DrillError(f"docker {argv[0]} failed: {(result.stderr or '').strip()}")
        return result.stdout or ""

    ids = docker(["ps", "-aq", "--filter", f"label={SCRATCH_LABEL}"]).split()
    if ids:
        docker(["rm", "-f", "-v", *ids])
    nets = docker(["network", "ls", "-q", "--filter", f"label={SCRATCH_LABEL}"]).split()
    if nets:
        docker(["network", "rm", *nets])


def sweep_stale_run_dirs(work_dir: pathlib.Path) -> list[pathlib.Path]:
    """Removes the run directories (decrypted dumps) an earlier, killed run left."""
    removed = sorted(work_dir.glob(f"{RUN_DIR_PREFIX}*")) if work_dir.is_dir() else []
    for stale in removed:
        shutil.rmtree(stale, ignore_errors=True)
    return removed


@dataclasses.dataclass
class GateReport:
    tenant: str
    copy: str
    ok: bool = False
    error: str | None = None
    object_key: str | None = None
    object_age_s: float | None = None
    bytes_recovered: int = 0
    restore_s: float | None = None
    interrupted: bool = False
    manifest: backup_manifest.Manifest | None = None
    content: rd.RestoredContent | None = None
    # Set only when the caller asked to keep the server and the gate passed;
    # that caller then owns `discard()`.
    scratch: ScratchMysql | None = None


def run_gate(
    *, config: rd.DrillConfig, tenant: str, hooks: rd.Hooks, copy_name: str | None = None, keep: bool = False,
) -> GateReport:
    """The whole gate. Never raises: every failure is recorded on the report with
    `ok` false, and the throwaway server and the decrypted dump are removed
    whatever happened. With `keep`, a passing run hands the server over instead."""
    started = hooks.now()
    if copy_name is None:
        copy = config.copies[0]
    else:
        named = [c for c in config.copies if c.name == copy_name]
        if not named:
            return GateReport(tenant=tenant, copy=copy_name, error=f"no configured copy named {copy_name!r}")
        copy = named[0]
    report = GateReport(tenant=tenant, copy=copy.name)
    scratch = ScratchMysql(runner=hooks.runner, run_id=hooks.run_id(), image=config.images.mysql,
                           memory=config.mysql_memory)
    run_dir = config.work_dir / f"{RUN_DIR_PREFIX}{scratch.run_id}"
    handed_over = False
    try:
        bw.validate_tenant_name(tenant)
        own_identity = rd.identity_path(config, tenant)
        backup = rd.newest_backup(hooks.store, copy, tenant)
        report.object_key = backup.key
        report.object_age_s = (started - backup.taken_at).total_seconds()
        if report.object_age_s > config.max_backup_age_s:
            raise rd.StaleBackupError(
                f"the newest backup of {tenant} on {copy.name} ({backup.key}) is "
                f"{report.object_age_s / 3600:.1f}h old; the gate accepts {config.max_backup_age_s / 3600:.1f}h"
            )
        ciphertext = hooks.store.get(copy, backup.key)
        rd.check_single_recipient(ciphertext, f"{copy.name}:{backup.key}")

        sweep_leftovers(hooks.runner)
        config.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        sweep_stale_run_dirs(config.work_dir)
        rd.ensure_images(hooks.runner, (config.images.recovery, config.images.mysql))
        if config.require_volatile_work_dir:
            rd.require_volatile(config.work_dir)
        run_dir.mkdir(mode=0o700, parents=True, exist_ok=False)

        restore_started = hooks.clock()
        decrypted = rd.age_decrypt(
            runner=hooks.runner, image=config.images.recovery, ciphertext=ciphertext, identity_paths=[own_identity]
        )
        if decrypted.returncode != 0:
            raise rd.DecryptError(
                f"{tenant}'s own key did not decrypt {backup.key}: {decrypted.stderr.decode(errors='replace').strip()}"
            )
        report.manifest = rd.read_manifest(decrypted.stdout)
        dump_path = run_dir / "dump.sql"
        fd = os.open(dump_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(decrypted.stdout)
        report.bytes_recovered = len(decrypted.stdout)
        del decrypted

        scratch.start()
        mysql_run = scratch.mysql_runner(config.images.recovery)
        restore_drained.restore_only(
            dump_path=str(dump_path), host=scratch.container, port=3306, user="root", password=scratch.password,
            mysql_ready_timeout_s=180.0, run=mysql_run, sleep=hooks.sleep, now=hooks.clock,
        )
        database = bw._naming.database_and_user_name(bw._naming.sql_identifier(tenant))
        report.content = rd.snapshot_restored_content(
            run=mysql_run, host=scratch.container, password=scratch.password, database=database
        )
        rd.compare_with_manifest(report.content, report.manifest)
        report.restore_s = hooks.clock() - restore_started
        report.ok = True
        if keep:
            report.scratch = scratch
            handed_over = True
    except (rd.DrillError, restore_drained.RestoreError, shared_objectstorage.ObjectStorageError,
            bw.InvalidTenantName, OSError) as exc:
        report.error = f"{type(exc).__name__}: {exc}"
    except rd.DrillInterrupted:
        report.interrupted = True
        report.error = "DrillInterrupted: stopped by SIGTERM before the gate finished"
    except Exception as exc:  # noqa: BLE001 -- a failure nobody foresaw refuses the swap like any other
        report.error = f"UnexpectedError: {type(exc).__name__}: {exc}"
    finally:
        discard_error: str | None = None
        try:
            if not handed_over:
                scratch.discard()
        except ScratchDiscardError as exc:
            discard_error = f"{type(exc).__name__}: {exc}"
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)
        if discard_error is not None:
            # A copy that could not be removed is a refusal, whatever else passed.
            report.ok = False
            report.scratch = None
            report.error = discard_error if report.error is None else f"{report.error}; {discard_error}"
    return report


def format_report(report: GateReport) -> list[str]:
    lines = [f"scratch_preflight: tenant={report.tenant} copy={report.copy} object={report.object_key}"]
    if report.manifest:
        m = report.manifest
        lines.append(
            f"scratch_preflight: backed up: title={m.site_title!r} users={m.users} published_posts={m.published_posts} "
            f"members={m.members} newest_post={m.newest_post_title!r}"
        )
    if report.content:
        c = report.content
        lines.append(
            f"scratch_preflight: restored {report.bytes_recovered} bytes; title={c.site_title!r} users={c.users} "
            f"published_posts={c.published_posts} members={c.members} newest_post={c.newest_post_title!r}"
        )
    if report.ok:
        lines.append(
            f"scratch_preflight: PASS restore={report.restore_s:.1f}s object_age={report.object_age_s / 3600:.1f}h"
        )
    else:
        lines.append(f"scratch_preflight: REFUSED {report.error}")
    return lines


def main(argv: Sequence[str] | None = None, *, hooks: rd.Hooks | None = None,
         environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", help="the tenant whose newest backup is restored")
    parser.add_argument("--copy", dest="copy_name", help="restore from this copy instead of the primary")
    parser.add_argument("--max-age-hours", type=float, help="refuse a newest backup older than this")
    parser.add_argument("--cleanup", action="store_true",
                        help="remove what a killed run left behind (the caller's cleanup step); run nothing")
    parser.add_argument("--allow-disk-work-dir", action="store_true",
                        help="local proof only: skip the tmpfs check. The environment cannot")
    args = parser.parse_args(argv)
    hooks = hooks or rd.Hooks()
    environ = os.environ if environ is None else environ
    if args.cleanup:
        return cleanup(environ, hooks)
    if not args.tenant:
        print("scratch_preflight: --tenant is required", file=sys.stderr)
        return EXIT_NOT_RUN
    try:
        config = rd.config_from_env(environ)
        if args.allow_disk_work_dir:
            config = dataclasses.replace(config, require_volatile_work_dir=False)
        if args.max_age_hours is not None:
            if not 0 < args.max_age_hours < float("inf"):
                raise rd.DrillConfigError("--max-age-hours must be a positive number")
            config = dataclasses.replace(config, max_backup_age_s=args.max_age_hours * 3600)
    except rd.DrillConfigError as exc:
        print(f"scratch_preflight: {exc}", file=sys.stderr)
        return EXIT_NOT_RUN
    try:
        config.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = open(config.work_dir / LOCK_NAME, "w")  # noqa: SIM115 -- held for the whole run
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        print(f"scratch_preflight: another gate run holds the lock, or it cannot be taken: {exc}", file=sys.stderr)
        return EXIT_NOT_RUN
    previous = signal.signal(signal.SIGTERM, rd._on_sigterm)
    try:
        with lock:
            report = run_gate(config=config, tenant=args.tenant, hooks=hooks, copy_name=args.copy_name)
    finally:
        signal.signal(signal.SIGTERM, previous)
    for line in format_report(report):
        print(line, file=sys.stdout if report.ok else sys.stderr)
    if report.interrupted:
        return 128 + signal.SIGTERM
    return 0 if report.ok else EXIT_REFUSED


def cleanup(environ: Mapping[str, str], hooks: rd.Hooks) -> int:
    """Whatever a run that was killed outright left behind: servers, networks
    and run directories."""
    work_dir = pathlib.Path(environ.get(f"{rd.ENV_PREFIX}WORK_DIR", rd.DEFAULT_WORK_DIR))
    try:
        sweep_leftovers(hooks.runner)
    except rd.DrillError as exc:
        print(f"scratch_preflight: cleanup could not remove containers: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    for stale in sweep_stale_run_dirs(work_dir):
        print(f"scratch_preflight: removed {stale}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
