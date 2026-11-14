"""Tests for branchleft-break-glass-textfile.py. See test_break_glass_textfile.md.

The program under test runs two things on the host: `docker ps`, and the break-glass
wrapper's `report`. Both are replaced here by stand-in executables that log every
call, so the tests see exactly what the program ran, with what arguments and what
environment. No Docker, no root and no network.

Each property is a `check_*` function over a module. The real program must pass all
of them. The sabotage tests then break the real source in one named place, require
that the break was applied, and require the matching check to go red: a check that
cannot fail proves nothing.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import types
import unittest
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from typing import Any
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
PROGRAM = HERE / "branchleft-break-glass-textfile.py"
SERVICE = HERE.parent / "systemd" / "branchleft-break-glass-textfile.service"
TIMER = HERE.parent / "systemd" / "branchleft-break-glass-textfile.timer"

OBSERVED = "2026-11-14T10:30:00.250Z"
GRANTED = "2026-11-14T10:00:00.000Z"
DEADLINE = "2026-11-14T14:00:00.000Z"

# The contract a later collector and the portal read. Written by hand, not derived
# from the program: epoch seconds from `date -u -j -f`.
GOLDEN = """\
# HELP branchleft_support_access_state The tenant's support account as the host's report read it: open, closed or unknown. A tenant with no series was not read; that is unknown, never closed.
# TYPE branchleft_support_access_state gauge
branchleft_support_access_state{tenant="alpha",state="open"} 1
branchleft_support_access_state{tenant="bravo",state="closed"} 1
branchleft_support_access_state{tenant="charlie",state="unknown"} 1
# HELP branchleft_support_access_lane The lane of the open grant, present only while a grant's clock is readable.
# TYPE branchleft_support_access_lane gauge
branchleft_support_access_lane{tenant="alpha",lane="consented"} 1
# HELP branchleft_support_access_granted_timestamp_seconds When the open grant was opened, in Unix seconds.
# TYPE branchleft_support_access_granted_timestamp_seconds gauge
branchleft_support_access_granted_timestamp_seconds{tenant="alpha"} 1794650400.000
# HELP branchleft_support_access_deadline_timestamp_seconds When the open grant closes by itself, in Unix seconds.
# TYPE branchleft_support_access_deadline_timestamp_seconds gauge
branchleft_support_access_deadline_timestamp_seconds{tenant="alpha"} 1794664800.000
# HELP branchleft_support_access_observed_timestamp_seconds The host's time when the report ran, in Unix seconds. A reader treats an old value as unknown.
# TYPE branchleft_support_access_observed_timestamp_seconds gauge
branchleft_support_access_observed_timestamp_seconds{tenant="alpha"} 1794652200.250
branchleft_support_access_observed_timestamp_seconds{tenant="bravo"} 1794652200.250
branchleft_support_access_observed_timestamp_seconds{tenant="charlie"} 1794652200.250
"""

EMPTY = "".join(line for line in GOLDEN.splitlines(keepends=True) if line.startswith("#"))

FORBIDDEN = ("reason", "reference", "grantId", "grant_id", "identity", "email", "token")


def ensure(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: pathlib.Path, name: str = "bg_textfile") -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    ensure(spec is not None and spec.loader is not None, f"cannot load {path}")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def report(
    tenant: str,
    state: str = "closed",
    lane: str | None = None,
    granted: str | None = None,
    deadline: str | None = None,
    observed: str = OBSERVED,
    **extra: Any,
) -> str:
    body: dict[str, object] = {
        "tenant": tenant,
        "state": state,
        "lane": lane,
        "grantedAt": granted,
        "deadline": deadline,
        "observedAt": observed,
    }
    body.update(extra)
    return json.dumps(body) + "\n"


def open_report(tenant: str, **extra: Any) -> str:
    return report(tenant, "open", "consented", GRANTED, DEADLINE, **extra)


STAND_IN = """\
#!{python}
import json, os, sys, time
base = {base!r}
who = {who!r}
with open(os.path.join(base, "calls.log"), "a") as log:
    log.write(json.dumps({{"who": who, "argv": sys.argv[1:], "env": sorted(os.environ)}}) + "\\n")
with open(os.path.join(base, who + ".json")) as handle:
    spec = json.load(handle)
if who == "wrapper":
    args = sys.argv[1:]
    tenant = args[args.index("--tenant") + 1] if "--tenant" in args else ""
    spec = spec.get(tenant, {{"stdout": "", "exit": 3}})
time.sleep(spec.get("sleep", 0))
sys.stderr.write(spec.get("stderr", ""))
sys.stdout.write(spec.get("stdout", ""))
sys.exit(spec.get("exit", 0))
"""


class Rig:
    """Stand-in `docker` and wrapper, an output directory and a config over them."""

    def __init__(
        self,
        mod: types.ModuleType,
        root: pathlib.Path,
        containers: list[tuple[str, str]],
        reports: Mapping[str, dict[str, Any]],
        ps_exit: int = 0,
        timeout: float = 20.0,
    ) -> None:
        self.mod = mod
        self.root = root
        self.out = root / "exporter"
        self.out.mkdir()
        self.set_world(containers, reports, ps_exit)
        for who in ("docker", "wrapper"):
            path = root / who
            path.write_text(STAND_IN.format(python=sys.executable, base=str(root), who=who))
            path.chmod(0o755)
        self.config = mod.Config(
            wrapper=str(root / "wrapper"),
            docker=str(root / "docker"),
            output_dir=str(self.out),
            report_timeout_s=timeout,
            list_timeout_s=timeout,
        )

    def set_world(
        self,
        containers: list[tuple[str, str]],
        reports: Mapping[str, dict[str, Any]],
        ps_exit: int = 0,
    ) -> None:
        listing = "".join(f"{project}\t{service}\n" for project, service in containers)
        (self.root / "docker.json").write_text(json.dumps({"stdout": listing, "exit": ps_exit}))
        (self.root / "wrapper.json").write_text(json.dumps(dict(reports)))
        (self.root / "calls.log").write_text("")

    def run(self) -> int:
        with contextlib.redirect_stderr(io.StringIO()):
            status: int = self.mod.collect(self.config)
        return status

    @property
    def prom(self) -> pathlib.Path:
        return pathlib.Path(self.out / self.mod.OUTPUT_NAME)

    def text(self) -> str:
        return self.prom.read_text()

    def calls(self, who: str) -> list[dict[str, Any]]:
        lines = (self.root / "calls.log").read_text().splitlines()
        return [c for c in (json.loads(line) for line in lines) if c["who"] == who]


@contextmanager
def rig(
    mod: types.ModuleType,
    containers: list[tuple[str, str]],
    reports: Mapping[str, dict[str, Any]],
    **kwargs: Any,
) -> Iterator[Rig]:
    with tempfile.TemporaryDirectory() as tmp:
        yield Rig(mod, pathlib.Path(tmp), containers, reports, **kwargs)


def ok(stdout: str) -> dict[str, Any]:
    return {"stdout": stdout, "exit": 0}


MIXED = {
    "alpha": ok(open_report("alpha")),
    "bravo": ok(report("bravo")),
    "charlie": ok(report("charlie", "unknown")),
}
MIXED_CONTAINERS = [("alpha", "ghost-a"), ("bravo", "ghost-b"), ("charlie", "ghost-a")]


def series_for(text: str, tenant: str) -> list[str]:
    return [line for line in text.splitlines() if f'tenant="{tenant}"' in line]


# ----- checks over a module -------------------------------------------------


def check_contract_text(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        ensure(r.run() == 0, "a clean run exits 0")
        ensure(r.text() == GOLDEN, "the textfile is exactly the documented contract")


def check_only_report_is_run(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        r.run()
        wrapper = r.calls("wrapper")
        ensure(
            sorted(c["argv"] for c in wrapper)
            == [["report", "--tenant", t] for t in ("alpha", "bravo", "charlie")],
            f"the wrapper is run only as `report --tenant <slug>`, once per tenant: {wrapper}",
        )
        for call in r.calls("docker"):
            ensure(call["argv"][0] == "ps", f"docker is used only to list: {call['argv']}")
        ensure(len(r.calls("docker")) == 1, "one listing per run")


def check_failure_leaves_no_series(mod: types.ModuleType) -> None:
    failures: dict[str, dict[str, Any]] = {
        "refused": {"stdout": "", "stderr": "refused: no running Ghost container", "exit": 1},
        "slow": {"stdout": open_report("slow"), "sleep": 30},
        "empty": ok(""),
        "notjson": ok("this is not json\n"),
        "twolines": ok(report("twolines") + report("twolines")),
        "array": ok("[]\n"),
        "wrongtenant": ok(report("someoneelse")),
        "badstate": ok(report("badstate", "locked")),
        "badlane": ok(report("badlane", "open", "root", GRANTED, DEADLINE)),
        "badtime": ok(report("badtime", "open", "consented", GRANTED, "tomorrow")),
        "impossible": ok(report("impossible", "open", "consented", GRANTED, "2026-13-45T10:00:00Z")),
        "noobserved": ok(report("noobserved", observed="")),
        "closedwithclock": ok(report("closedwithclock", "closed", "consented", GRANTED, DEADLINE)),
        "unknownwithlane": ok(report("unknownwithlane", "unknown", "incident")),
        "boolstate": ok(report("boolstate").replace('"closed"', "true")),
        "dupkey": ok(report("dupkey").replace('"state": "closed"', '"state": "open", "state": "closed"')),
        "huge": ok(report("huge", observed="2026-11-14T10:30:00Z" + " " * 100_000)),
    }
    containers = [("good", "ghost-a")] + [(name, "ghost-a") for name in failures]
    world = {"good": ok(report("good")), **failures}
    with rig(mod, containers, world, timeout=2.0) as r:
        ensure(r.run() == 0, "a tenant that cannot be read is not a failed run")
        text = r.text()
        ensure(series_for(text, "good"), "the readable tenant still has its series")
        for name in failures:
            ensure(not series_for(text, name), f"{name}: an unreadable tenant has no series")
        ensure("closed" not in "".join(series_for(text, "slow")), "a failure never reads closed")
        ensure(text.count('state="closed"') == 1, "only the one readable closed tenant says closed")


def check_forbidden_fields_never_reach_the_file(mod: types.ModuleType) -> None:
    secret = "ZZ-secret-reason-ZZ"
    dirty = {
        name: ok(report(name, "closed", **{name: secret}))
        for name in ("reason", "reference", "grantId", "identity")
    }
    world = {"alpha": ok(open_report("alpha")), **dirty}
    containers = [("alpha", "ghost-a")] + [(name, "ghost-a") for name in dirty]
    with rig(mod, containers, world) as r:
        r.run()
        text = r.text()
        ensure(secret not in text, "a value from a forbidden field reached the file")
        for name in dirty:
            ensure(not series_for(text, name), f"a report carrying {name} is refused whole")
        names = set(re.findall(r"^([a-z_]+)[{ ]", text, re.MULTILINE))
        ensure(
            names
            == {
                "branchleft_support_access_state",
                "branchleft_support_access_lane",
                "branchleft_support_access_granted_timestamp_seconds",
                "branchleft_support_access_deadline_timestamp_seconds",
                "branchleft_support_access_observed_timestamp_seconds",
            },
            f"the file holds only the five contract metrics: {names}",
        )
        lowered = text.lower()
        for word in FORBIDDEN:
            ensure(word.lower() not in lowered, f"the word {word} appears in the file")


def check_only_running_ghost_tenants_are_read(mod: types.ModuleType) -> None:
    containers = [
        ("alpha", "ghost-a"),
        ("alpha", "ghost-b"),  # both colours up: read once
        ("bravo", "ghost-b"),
        ("charlie", "caddy"),  # not a Ghost container
        ("delta", "ghost-a"),
        ("UPPER", "ghost-a"),  # not a slug
        ("../etc", "ghost-a"),
        ("-lead", "ghost-a"),
        ("a" * 64, "ghost-a"),
    ]
    world = {name: ok(report(name)) for name in ("alpha", "bravo", "charlie", "delta")}
    with rig(mod, containers, world) as r:
        r.run()
        asked = sorted(c["argv"][2] for c in r.calls("wrapper"))
        ensure(asked == ["alpha", "bravo", "delta"], f"asked for {asked}")
        text = r.text()
        ensure(not series_for(text, "charlie"), "a tenant with no Ghost container has no series")


def check_stopped_tenant_series_goes_away(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        r.run()
        ensure(series_for(r.text(), "alpha"), "the first run has alpha")
        r.set_world(MIXED_CONTAINERS[1:], MIXED)
        r.run()
        ensure(not series_for(r.text(), "alpha"), "alpha stopped: its series is gone next run")
        ensure(series_for(r.text(), "bravo"), "the others stay")


def check_failed_listing_clears_the_file(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        r.run()
        ensure(r.text() == GOLDEN, "setup: the first run wrote the series")
        r.set_world(MIXED_CONTAINERS, MIXED, ps_exit=1)
        ensure(r.run() == 1, "a listing that fails is a failed run")
        ensure(r.text() == EMPTY, "when no tenant can be listed, no series is left behind")
        ensure(len(r.calls("wrapper")) == 0, "no tenant is read when none can be listed")


def check_write_is_atomic_and_clean(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        seen: list[tuple[str, str]] = []
        real_replace = os.replace

        def spy(src: Any, dst: Any) -> None:
            seen.append((str(src), str(dst)))
            ensure(pathlib.Path(src).read_text() == GOLDEN, "the temporary file is complete")
            ensure(not str(src).endswith(".prom"), "the collector skips the temporary file")
            real_replace(src, dst)

        with mock.patch("os.replace", spy):
            r.run()
        ensure(len(seen) == 1, "exactly one rename")
        ensure(seen[0][1] == str(r.prom), "renamed over the one textfile")
        ensure(
            pathlib.Path(seen[0][0]).parent == r.out,
            "the temporary file is beside the textfile, so the rename is atomic",
        )
        ensure([p.name for p in r.out.iterdir()] == [r.prom.name], "no temporary file is left")
        mode = stat.S_IMODE(r.prom.stat().st_mode)
        ensure(mode == 0o644, f"the textfile is readable by node_exporter: {oct(mode)}")


def check_write_failure_removes_the_old_series(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        r.run()
        ensure(r.prom.exists(), "setup: a first file exists")
        with mock.patch("os.replace", side_effect=OSError("disk full")):
            ensure(r.run() == 1, "a failed write is a failed run")
        ensure(not r.prom.exists(), "a file that cannot be refreshed is removed, not left to go stale")
        ensure(list(r.out.iterdir()) == [], "and no temporary file is left")


def check_missing_directory_is_not_created(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        r.out.rmdir()
        ensure(r.run() == 1, "no output directory is a failed run")
        ensure(not r.out.exists(), "the program does not create the directory; the role owns it")


def check_children_get_a_clean_environment(mod: types.ModuleType) -> None:
    with rig(mod, MIXED_CONTAINERS, MIXED) as r:
        with mock.patch.dict(os.environ, {"BL_TEST_SECRET": "x", "DOCKER_HOST": "tcp://elsewhere"}):
            r.run()
        for call in r.calls("docker") + r.calls("wrapper"):
            ensure("BL_TEST_SECRET" not in call["env"], "the parent's environment is not passed on")
            ensure("DOCKER_HOST" not in call["env"], "no DOCKER_HOST: the local engine only")


CHECKS: dict[str, Callable[[types.ModuleType], None]] = {
    "contract": check_contract_text,
    "only_report": check_only_report_is_run,
    "failure_no_series": check_failure_leaves_no_series,
    "forbidden": check_forbidden_fields_never_reach_the_file,
    "ghost_only": check_only_running_ghost_tenants_are_read,
    "stopped": check_stopped_tenant_series_goes_away,
    "listing": check_failed_listing_clears_the_file,
    "atomic": check_write_is_atomic_and_clean,
    "write_failure": check_write_failure_removes_the_old_series,
    "no_mkdir": check_missing_directory_is_not_created,
    "env": check_children_get_a_clean_environment,
}


class RealProgram(unittest.TestCase):
    mod: types.ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = load(PROGRAM)

    def test_checks(self) -> None:
        for name, check in CHECKS.items():
            with self.subTest(check=name):
                check(self.mod)

    def test_takes_no_argument(self) -> None:
        for argv in (["x"], ["--output", "/tmp/x"], ["status"]):
            with self.subTest(argv=argv):
                self.assertEqual(self.mod.main(argv), 2)

    def test_the_constants_the_units_rely_on(self) -> None:
        mod = self.mod
        self.assertEqual(mod.WRAPPER, "/usr/local/sbin/branchleft-break-glass")
        self.assertEqual(mod.OUTPUT_NAME, "support_access.prom")
        self.assertTrue(mod.OUTPUT_NAME.endswith(".prom"))
        self.assertEqual(mod.GHOST_SERVICES, ("ghost-a", "ghost-b"))

    def test_the_program_calls_nothing_it_may_not(self) -> None:
        source = PROGRAM.read_text()
        for verb in ("grant", "revoke", "expire", "status", "mint"):
            self.assertNotRegex(source, rf"""["']{verb}["']""", f"the program names {verb!r}")
        self.assertTrue(source.startswith("#!/usr/bin/python3 -I\n"))
        self.assertNotIn("shell=True", source)


class Units(unittest.TestCase):
    def test_service(self) -> None:
        text = SERVICE.read_text()
        self.assertIn("Type=oneshot", text)
        self.assertIn("ExecStart=/usr/local/sbin/branchleft-break-glass-textfile\n", text)
        self.assertIn("After=docker.service", text)
        self.assertIn("NoNewPrivileges=yes", text)
        self.assertNotRegex(text, r"(?m)^(User|Restart|Environment|EnvironmentFile)=")
        self.assertRegex(text, r"(?m)^TimeoutStartSec=\S+")

    def test_timer_fires_every_sixty_seconds(self) -> None:
        text = TIMER.read_text()
        self.assertRegex(text, r"(?m)^OnUnitActiveSec=60s$")
        self.assertRegex(text, r"(?m)^OnBootSec=\S+$")
        self.assertIn("WantedBy=timers.target", text)
        self.assertNotRegex(text, r"(?m)^Persistent=")

    def test_the_unit_runs_the_installed_name_of_the_program(self) -> None:
        self.assertEqual(PROGRAM.name, "branchleft-break-glass-textfile.py")


class Sabotage(unittest.TestCase):
    """Break the real source in one place; the named check must go red."""

    def broken(self, old: str, new: str) -> types.ModuleType:
        source = PROGRAM.read_text()
        self.assertEqual(source.count(old), 1, f"the sabotage target must be unique: {old!r}")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = pathlib.Path(tmp.name) / "broken.py"
        path.write_text(source.replace(old, new))
        return load(path, "bg_textfile_broken")

    def assert_red(self, module: types.ModuleType, check: str) -> None:
        with self.assertRaises(AssertionError):
            CHECKS[check](module)

    def test_a_program_that_writes_closed_on_failure_is_red(self) -> None:
        module = self.broken(
            "continue  # no series: how the collector learns unknown",
            'reading = Reading(slug, "closed", None, None, None, 0)',
        )
        self.assert_red(module, "failure_no_series")

    def test_a_program_that_lets_extra_fields_through_is_red(self) -> None:
        module = self.broken("if set(obj) != REPORT_KEYS:", "if False:")
        self.assert_red(module, "forbidden")

    def test_a_program_that_trusts_the_tenant_a_report_names_is_red(self) -> None:
        module = self.broken("if obj['tenant'] != slug:", "if False:")
        self.assert_red(module, "failure_no_series")

    def test_a_program_that_leaves_old_series_when_it_cannot_list_is_red(self) -> None:
        module = self.broken("publish(cfg, render([]))  # nothing is known, so nothing is claimed", "pass")
        self.assert_red(module, "listing")

    def test_a_program_that_leaves_a_stale_file_when_it_cannot_write_is_red(self) -> None:
        module = self.broken("discard(final)  # stale series must not outlive a failed refresh", "pass")
        self.assert_red(module, "write_failure")

    def test_a_program_that_passes_its_environment_on_is_red(self) -> None:
        module = self.broken("env=CHILD_ENV", "env=None")
        self.assert_red(module, "env")

    def test_a_program_that_reads_a_container_that_is_not_ghost_is_red(self) -> None:
        module = self.broken("if service in GHOST_SERVICES and", "if True and")
        self.assert_red(module, "ghost_only")

    def test_a_program_that_runs_the_wrapper_with_a_different_verb_is_red(self) -> None:
        for verb in ("grant", "revoke", "expire", "status"):
            with self.subTest(verb=verb):
                module = self.broken("'report', '--tenant'", f"'{verb}', '--tenant'")
                self.assert_red(module, "only_report")


if __name__ == "__main__":
    unittest.main()
