#!/usr/bin/python3 -I
"""The pre-swap scratch-copy gate, part 2 (and, through scratch_migrate, part 3).
Runs part 1 (a tenant's verified backup restored into a throwaway MySQL), then
boots the green colour against that copy with no public traffic and refuses,
with a nonzero exit, unless every smoke check passes, the colour's migrations
included. It holds no address for the tenant's database host and publishes no
port. See scratch_boot_smoke.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import os
import pathlib
import shutil
import signal
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence

# `-I` drops the script's own directory from the import path; the siblings this
# imports by name are put back explicitly, from this file's resolved location.
_HERE = str(pathlib.Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import backup_worker as bw  # noqa: E402
import restore_drill as rd  # noqa: E402
import scratch_migrate as sm  # noqa: E402
import scratch_preflight as sp  # noqa: E402

restore_drained = rd.restore_drained

FLAG_DIR_PREFIX = "preflight-flag-"
EXIT_REFUSED = sp.EXIT_REFUSED
EXIT_NOT_RUN = sp.EXIT_NOT_RUN
EXEC_SLACK_S = 15.0

# Run inside the colour's own container, so the check never needs a published
# port: it reads the status and the body of one URL on the colour's loopback.
PROBE_JS = (
    "const [url, seconds] = process.argv.slice(1);"
    "fetch(url, {headers: {'x-forwarded-proto': 'https'}, signal: AbortSignal.timeout(seconds * 1000)})"
    ".then(async (r) => process.stdout.write(`${r.status}\\n${await r.text()}`))"
    ".catch((e) => process.stdout.write(`0\\n${e.message}`));"
)

Getter = Callable[..., tuple[int, str]]


class ColourStartError(rd.DrillError):
    """The green colour's containers could not be created."""


class SmokeCheckError(rd.DrillError):
    """A smoke check on the green colour failed."""


def exec_get(runner: rd.Runner, container: str) -> Getter:
    """An HTTP getter that asks the colour's own container to fetch the URL,
    so the colour needs no published port and the host reaches nothing."""

    def get(url: str, timeout_s: float) -> tuple[int, str]:
        argv = ["docker", "exec", container, "node", "-e", PROBE_JS, url, str(timeout_s)]
        try:
            result = runner(
                argv, capture_output=True, text=True, check=False, env=rd._child_env(),
                timeout=timeout_s + EXEC_SLACK_S,
            )
        except subprocess.TimeoutExpired:
            return 0, "docker exec timed out"
        if result.returncode != 0:
            return 0, (result.stderr or "").strip()
        status_line, _, body = (result.stdout or "").partition("\n")
        try:
            return int(status_line), body
        except ValueError:
            return 0, result.stdout or ""

    return get


@dataclasses.dataclass
class GreenColour:
    """The candidate Ghost and its drain sidecar, on the scratch server's
    internal network and nowhere else. Nothing is published to the host."""

    runner: rd.Runner
    scratch: sp.ScratchMysql
    ghost_image: str
    sidecar_image: str
    memory: str
    flag_dir: pathlib.Path

    @property
    def ghost(self) -> str:
        return f"scratch-preflight-ghost-{self.scratch.run_id}"

    @property
    def sidecar(self) -> str:
        return f"scratch-preflight-sidecar-{self.scratch.run_id}"

    def _docker(self, argv: list[str], *, env_extra: Mapping[str, str] | None = None) -> None:
        result = self.runner(
            ["docker", *argv], capture_output=True, text=True, check=False, env=rd._child_env(env_extra)
        )
        if result.returncode != 0:
            raise ColourStartError(f"docker {argv[0]} failed: {(result.stderr or '').strip()}")

    def start(self, database: str) -> None:
        label = ["--label", f"{sp.SCRATCH_LABEL}={self.scratch.run_id}"]
        env_args: list[str] = []
        for name, value in rd.GHOST_STATIC_ENV:
            env_args += ["-e", f"{name}={value}"]
        env_args += [
            "-e", f"url=http://127.0.0.1:{rd.GHOST_PORT}",
            "-e", f"database__connection__host={self.scratch.container}",
            "-e", f"database__connection__database={database}",
            "-e", "database__connection__password",
        ]
        self._docker(
            ["run", "-d", "--name", self.ghost, "--network", self.scratch.network, "--memory", self.memory,
             *label, *env_args, self.ghost_image],
            env_extra={"database__connection__password": self.scratch.password},
        )
        self._docker(
            ["run", "-d", "--name", self.sidecar, "--network", f"container:{self.ghost}", *label,
             "-v", f"{self.flag_dir}:{rd.FLAG_MOUNT_DIR}:ro",
             "-e", f"DRAIN_FLAG_PATH={rd.FLAG_MOUNT_DIR}/{rd.FLAG_NAME}",
             "-e", f"GHOST_HEALTH_URL=http://127.0.0.1:{rd.GHOST_PORT}/",
             "-e", f"PORT={rd.SIDECAR_PORT}", self.sidecar_image],
        )

    def remove(self) -> None:
        """Safe whether or not `start` got as far as creating anything. The
        network cannot go while a colour container is attached to it, so the
        scratch server's `discard` runs after this. Both are tried, and one that
        failed is raised after."""
        sp.run_removals(self.runner, [["docker", "rm", "-f", "-v", name] for name in (self.sidecar, self.ghost)])


@dataclasses.dataclass
class BootReport:
    gate: sp.GateReport
    ok: bool = False
    error: str | None = None
    interrupted: bool = False
    checks: list[str] = dataclasses.field(default_factory=list)
    boot_s: float | None = None
    # What the colour's migrations did to the copy; None until they were read.
    migrations: sm.MigrationOutcome | None = None


def run_smoke_checks(
    *, report: BootReport, get: Getter, flag_path: pathlib.Path, hooks: rd.Hooks,
    migrations: Callable[[], sm.MigrationOutcome],
) -> None:
    """The five checks, in order; the first to fail raises and the rest do not
    run. Each is recorded on the report as it passes. `migrations` reads what the
    colour's boot migrations did to the copy, once the colour answers."""
    manifest = report.gate.manifest
    expected = rd.expected_from_manifest(manifest) if manifest else ()
    if not expected:
        raise SmokeCheckError("the backup names no site title or post to look for; nothing could be proven")
    sidecar_url = f"http://127.0.0.1:{rd.SIDECAR_PORT}/healthz"
    ghost_url = f"http://127.0.0.1:{rd.GHOST_PORT}/"
    page_get = rd.unescaping_get(get)

    def step(name: str, action: Callable[[], None]) -> None:
        try:
            action()
        except (rd.DrillError, restore_drained.RestoreError) as exc:
            raise SmokeCheckError(f"check {name!r} failed: {type(exc).__name__}: {exc}") from exc
        report.checks.append(name)

    step("drained at boot", lambda: rd.wait_for_status(
        get=get, url=sidecar_url, want=503, timeout_s=hooks.sidecar_timeout_s, sleep=hooks.sleep, now=hooks.clock))
    step("serves", lambda: rd.wait_for_status(
        get=get, url=ghost_url, want=200, timeout_s=hooks.content_timeout_s, sleep=hooks.sleep, now=hooks.clock))

    def migrated() -> None:
        report.migrations = migrations()

    step("migrations", migrated)

    def content() -> None:
        for text in expected:
            restore_drained.verify_tenant_content(
                base_url=ghost_url, expected_post_body=text, timeout_s=hooks.content_timeout_s,
                get=page_get, sleep=hooks.sleep, now=hooks.clock,
            )

    step("tenant content", content)

    def undrain() -> None:
        restore_drained.clear_drain_flag(str(flag_path))
        rd.wait_for_status(
            get=get, url=sidecar_url, want=200, timeout_s=hooks.sidecar_timeout_s, sleep=hooks.sleep, now=hooks.clock)

    step("ready once undrained", undrain)


def discard_everything(colour: GreenColour, scratch: sp.ScratchMysql, flag_dir: pathlib.Path) -> str | None:
    """Removes the colour, the scratch server and the drain flag. Each is tried
    whatever an earlier one did, so one failing never leaves another behind.
    Returns what could not be removed, or None. An interrupt that lands in the
    middle is held until all three have been tried, then raised."""
    failures: list[str] = []
    held: BaseException | None = None
    for what, action in (
        ("colour", colour.remove),
        ("scratch server", scratch.discard),
        ("drain flag", lambda: shutil.rmtree(flag_dir, ignore_errors=True)),
    ):
        try:
            action()
        except BaseException as exc:  # noqa: BLE001 -- the removals after this one must still run
            if not isinstance(exc, Exception) and held is None:
                held = exc
            failures.append(f"{what}: {type(exc).__name__}: {exc}")
    if held is not None:
        raise held
    return "; ".join(failures) or None


def run_boot_gate(
    *, config: rd.DrillConfig, tenant: str, hooks: rd.Hooks, copy_name: str | None = None,
    make_get: Callable[[str], Getter] | None = None,
) -> BootReport:
    """Part 1, then the green colour on its restored copy, then the colour's
    migrations read back from that copy (part 3). Never raises: every failure,
    one nobody foresaw included, is recorded on the report with `ok` false, and
    the colour, the scratch server, the plaintext and the drain flag are removed
    whatever happened. A copy that could not be removed is a failure too.
    `config.images.ghost` is the colour under test."""
    started = hooks.clock()
    make_get = make_get or (lambda container: exec_get(hooks.runner, container))

    def early(error: str, *, interrupted: bool = False) -> BootReport:
        gate = sp.GateReport(tenant=tenant, copy=copy_name or "", error=error, interrupted=interrupted)
        return BootReport(gate=gate, error=error, interrupted=interrupted)

    try:
        rd.ensure_images(hooks.runner, (config.images.ghost, config.images.sidecar))
    except (rd.DrillError, OSError) as exc:
        return early(f"{type(exc).__name__}: {exc}")
    except rd.DrillInterrupted:
        return early("DrillInterrupted: stopped by SIGTERM before the gate finished", interrupted=True)
    except Exception as exc:  # noqa: BLE001 -- a failure nobody foresaw refuses the swap like any other
        return early(f"UnexpectedError: {type(exc).__name__}: {exc}")
    gate = sp.run_gate(config=config, tenant=tenant, hooks=hooks, copy_name=copy_name, keep=True)
    report = BootReport(gate=gate, interrupted=gate.interrupted)
    scratch = gate.scratch
    if scratch is None:
        report.error = gate.error
        return report
    flag_dir = config.flag_root / f"{FLAG_DIR_PREFIX}{scratch.run_id}"
    colour = GreenColour(
        runner=hooks.runner, scratch=scratch, ghost_image=config.images.ghost,
        sidecar_image=config.images.sidecar, memory=config.ghost_memory, flag_dir=flag_dir,
    )
    try:
        flag_dir.mkdir(mode=0o755, parents=True, exist_ok=False)
        os.chmod(flag_dir, 0o755)
        flag_path = flag_dir / rd.FLAG_NAME
        flag_path.touch(mode=0o644)
        database = bw._naming.database_and_user_name(bw._naming.sql_identifier(tenant))
        mysql_run = scratch.mysql_runner(config.images.recovery)

        def read_migrations() -> sm.MigrationState:
            return sm.read_state(run=mysql_run, host=scratch.container, password=scratch.password, database=database)

        # Read before the colour exists: what it migrates is the difference.
        before = read_migrations()
        colour.start(database)

        def migrations() -> sm.MigrationOutcome:
            return sm.wait_for_migrations(
                read=read_migrations, before=before, timeout_s=hooks.sidecar_timeout_s, sleep=hooks.sleep,
                now=hooks.clock,
            )

        run_smoke_checks(
            report=report, get=make_get(colour.ghost), flag_path=flag_path, hooks=hooks, migrations=migrations,
        )
        report.boot_s = hooks.clock() - started
        report.ok = True
    except (rd.DrillError, restore_drained.RestoreError, OSError) as exc:
        report.error = f"{type(exc).__name__}: {exc}"
    except rd.DrillInterrupted:
        report.interrupted = True
        report.error = "DrillInterrupted: stopped by SIGTERM before the gate finished"
    except Exception as exc:  # noqa: BLE001 -- a failure nobody foresaw refuses the swap like any other
        report.error = f"UnexpectedError: {type(exc).__name__}: {exc}"
    finally:
        discard_error = discard_everything(colour, scratch, flag_dir)
        if discard_error is not None:
            # A copy that could not be removed refuses the swap, whatever else passed.
            report.ok = False
            report.error = discard_error if report.error is None else f"{report.error}; {discard_error}"
    return report


def format_report(report: BootReport) -> list[str]:
    lines = sp.format_report(report.gate)
    if not report.gate.ok:
        lines[-1] = lines[-1].replace("scratch_preflight: REFUSED", "scratch_boot_smoke: REFUSED before boot:")
        return lines
    # Part 1's own PASS is not the gate's verdict: only the last line is.
    lines[-1] = lines[-1].replace("scratch_preflight: PASS", "scratch_preflight: restore ok")
    lines += [f"scratch_boot_smoke: check passed: {name}" for name in report.checks]
    if report.migrations is not None:
        lines.append(f"scratch_boot_smoke: {report.migrations.summary()}")
    if report.ok:
        lines.append(f"scratch_boot_smoke: PASS checks={len(report.checks)} boot={report.boot_s:.1f}s")
    else:
        lines.append(f"scratch_boot_smoke: REFUSED {report.error}")
    return lines


def main(argv: Sequence[str] | None = None, *, hooks: rd.Hooks | None = None,
         environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", help="the tenant whose newest backup is restored")
    parser.add_argument("--copy", dest="copy_name", help="restore from this copy instead of the primary")
    parser.add_argument("--ghost-image", help="the green colour's Ghost image, by digest (default: the drill's)")
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
        print("scratch_boot_smoke: --tenant is required", file=sys.stderr)
        return EXIT_NOT_RUN
    try:
        config = rd.config_from_env(environ)
        if args.allow_disk_work_dir:
            config = dataclasses.replace(config, require_volatile_work_dir=False)
        if args.ghost_image is not None:
            if not rd.DIGEST_PINNED.match(args.ghost_image):
                raise rd.DrillConfigError("--ghost-image must name an image by sha256 digest")
            config = dataclasses.replace(config, images=dataclasses.replace(config.images, ghost=args.ghost_image))
        if args.max_age_hours is not None:
            if not 0 < args.max_age_hours < float("inf"):
                raise rd.DrillConfigError("--max-age-hours must be a positive number")
            config = dataclasses.replace(config, max_backup_age_s=args.max_age_hours * 3600)
    except rd.DrillConfigError as exc:
        print(f"scratch_boot_smoke: {exc}", file=sys.stderr)
        return EXIT_NOT_RUN
    lock = None
    try:
        config.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = open(config.work_dir / sp.LOCK_NAME, "w")  # noqa: SIM115 -- closed by `with lock` once held, or below if refused
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if lock is not None:
            lock.close()
        print(f"scratch_boot_smoke: another gate run holds the lock, or it cannot be taken: {exc}", file=sys.stderr)
        return EXIT_NOT_RUN
    previous = signal.signal(signal.SIGTERM, rd._on_sigterm)
    try:
        with lock:
            report = run_boot_gate(config=config, tenant=args.tenant, hooks=hooks, copy_name=args.copy_name)
    finally:
        signal.signal(signal.SIGTERM, previous)
    for line in format_report(report):
        print(line, file=sys.stdout if report.ok else sys.stderr)
    if report.interrupted:
        return 128 + signal.SIGTERM
    return 0 if report.ok else EXIT_REFUSED


def cleanup(environ: Mapping[str, str], hooks: rd.Hooks) -> int:
    """Part 1's cleanup, which removes every labelled container (the colour's
    included) and network and the run directories, then the drain-flag
    directories this part adds."""
    status = sp.cleanup(environ, hooks)
    flag_root = pathlib.Path(environ.get(f"{rd.ENV_PREFIX}FLAG_ROOT", rd.DEFAULT_FLAG_ROOT))
    for stale in sorted(flag_root.glob(f"{FLAG_DIR_PREFIX}*")) if flag_root.is_dir() else []:
        shutil.rmtree(stale, ignore_errors=True)
        print(f"scratch_boot_smoke: removed {stale}")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
