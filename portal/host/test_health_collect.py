"""Tests for branchleft-health-collect.py. See test_health_collect.md.

The program under test fetches each tenant colour's sidecar text over HTTP and
runs two things through `docker`: `docker ps` to find the console container, and
`docker exec -i` to hand the report to the collector in it. Here the sidecars are
real local servers and `docker` is a stand-in executable that logs every call, its
environment and its standard input. No Docker, no root and no estate network.

Each property is a `check_*` function over a module. The real program must pass all
of them. The sabotage tests then break the real source in one named place, require
that the break was applied exactly once, and require the matching check to go red.
"""

from __future__ import annotations

import contextlib
import http.server
import importlib.util
import io
import json
import pathlib
import socket
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from collections.abc import Callable, Iterator
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
PROGRAM = HERE / "branchleft-health-collect.py"
SERVICE = HERE / "branchleft-health-collect.service"
TIMER = HERE / "branchleft-health-collect.timer"

CONTAINER = "0123456789ab"
HEALTHY = 'drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="6.55.0"} 1\ndrain_sidecar_version_match 1\n'
DRAINED = "drain_sidecar_drained 1\n"


def ensure(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: pathlib.Path, name: str = "health_collect") -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Sidecar:
    """A local HTTP server standing in for one colour's drain sidecar."""

    def __init__(self, status: int = 200, body: bytes = b"", delay_s: float = 0.0, path: str = "/metrics", drip_s: float = 0.0) -> None:
        outer = self
        self.requests: list[str] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 -- the name http.server calls
                outer.requests.append(self.path)
                if self.path != path:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                time.sleep(delay_s)
                with contextlib.suppress(OSError):
                    if drip_s:
                        for index in range(len(body)):
                            self.wfile.write(body[index : index + 1])
                            self.wfile.flush()
                            time.sleep(drip_s)
                    else:
                        self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port: int = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> Sidecar:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/metrics"


def closed_url() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}/metrics"


STAND_IN = """\
#!{python}
import json, os, sys
base = {base!r}
args = sys.argv[1:]
stdin = b"" if args[:1] == ["ps"] else sys.stdin.buffer.read()
with open(os.path.join(base, "calls.log"), "a") as log:
    log.write(json.dumps({{"argv": args, "env": sorted(os.environ), "stdin": stdin.decode()}}) + "\\n")
spec = json.load(open(os.path.join(base, "docker.json")))
which = "ps" if args[:1] == ["ps"] else "exec"
sys.stderr.write(spec[which].get("stderr", ""))
sys.stdout.write(spec[which].get("stdout", ""))
sys.exit(spec[which].get("exit", 0))
"""


class Rig:
    """A stand-in `docker` and a config over it."""

    def __init__(self, mod: types.ModuleType, root: pathlib.Path, ps: dict[str, Any] | None = None, run: dict[str, Any] | None = None) -> None:
        self.mod = mod
        self.base = root
        stand_in = root / "docker"
        stand_in.write_text(STAND_IN.format(python=sys.executable, base=str(root)))
        stand_in.chmod(stand_in.stat().st_mode | stat.S_IXUSR)
        (root / "docker.json").write_text(
            json.dumps({"ps": ps or {"stdout": CONTAINER + "\n"}, "exec": run or {"stderr": "health: alpha-site: recorded read\n"}})
        )
        self.cfg = mod.Config(docker=str(stand_in), fetch_timeout_s=1.0, list_timeout_s=10.0, exec_timeout_s=10.0)

    def calls(self) -> list[dict[str, Any]]:
        log = self.base / "calls.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def execs(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][:1] == ["exec"]]

    def reports(self) -> list[Any]:
        return [json.loads(call["stdin"]) for call in self.execs()]

    def main(self, args: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code: int = self.mod.main(args, self.cfg)
        return code, err.getvalue()


@contextlib.contextmanager
def rig(mod: types.ModuleType, ps: dict[str, Any] | None = None, run: dict[str, Any] | None = None) -> Iterator[Rig]:
    with tempfile.TemporaryDirectory() as root:
        yield Rig(mod, pathlib.Path(root), ps, run)


# ---- the properties -------------------------------------------------------------------


def check_hands_one_report_of_every_colour_to_the_collector(mod: types.ModuleType) -> None:
    with Sidecar(body=DRAINED.encode()) as a, Sidecar(body=HEALTHY.encode()) as b, Sidecar(body=HEALTHY.encode()) as c, rig(mod) as r:
        code, err = r.main([f"alpha-site={a.url},{b.url}", f"bravo-site={c.url}"])
        ensure(code == 0, f"a clean run exits 0, got {code}: {err}")
        execs = r.execs()
        ensure(
            [e["argv"] for e in execs] == [["exec", "-i", CONTAINER, "node", "dist/collector/healthMain.js"]],
            f"one docker exec -i for the whole run, nothing else on the command line: {[e['argv'] for e in execs]}",
        )
        ensure(
            r.reports() == [{"tenants": [{"tenant": "alpha-site", "scrapes": [DRAINED, HEALTHY]}, {"tenant": "bravo-site", "scrapes": [HEALTHY]}]}],
            f"each colour's text goes in as it came, colour a first: {r.reports()}",
        )
        ensure("recorded read" in err, "the collector's own run line reaches the journal")
        ps = [c for c in r.calls() if c["argv"][:1] == ["ps"]]
        ensure(len(ps) == 1, "the console container is looked up once per run")
        ensure(
            "label=com.docker.compose.project=control-plane" in ps[0]["argv"]
            and "label=com.docker.compose.service=console" in ps[0]["argv"]
            and "status=running" in ps[0]["argv"],
            f"the lookup names the project, the service and running: {ps[0]['argv']}",
        )


def check_a_colour_that_cannot_be_read_is_reported_as_null(mod: types.ModuleType) -> None:
    with contextlib.ExitStack() as stack:
        good = stack.enter_context(Sidecar(body=HEALTHY.encode()))
        cases: dict[str, str] = {
            "answers 500": stack.enter_context(Sidecar(status=500, body=HEALTHY.encode())).url,
            "answers 404": stack.enter_context(Sidecar(status=404, body=HEALTHY.encode())).url,
            "is not at the metrics path": stack.enter_context(Sidecar(body=HEALTHY.encode(), path="/other")).url,
            "sends more than the limit": stack.enter_context(Sidecar(body=b"a" * (mod.MAX_BODY_BYTES + 1))).url,
            "is silent for longer than the limit": stack.enter_context(Sidecar(body=HEALTHY.encode(), delay_s=2.0)).url,
            "drips its answer past the limit": stack.enter_context(Sidecar(body=b"abcdefgh", drip_s=0.4)).url,
            "sends text that is not UTF-8": stack.enter_context(Sidecar(body=b"\xff\xfe")).url,
            "is not listening": closed_url(),
        }
        for name, url in cases.items():
            with rig(mod) as r:
                code, err = r.main([f"alpha-site={good.url},{url}"])
                ensure(code == 1, f"a colour that {name} makes the run fail, got {code}")
                ensure(
                    r.reports() == [{"tenants": [{"tenant": "alpha-site", "scrapes": [HEALTHY, None]}]}],
                    f"a colour that {name} is reported as null and the tenant is still handed over: {r.reports()}",
                )
                ensure("colour b not read" in err, f"the journal names the colour that {name}")


def check_a_host_that_is_down_still_hands_over_so_the_old_reading_is_replaced(mod: types.ModuleType) -> None:
    with rig(mod) as r:
        code, _ = r.main([f"alpha-site={closed_url()}", f"bravo-site={closed_url()},{closed_url()}"])
        ensure(code == 1, "an unreadable estate fails the run")
        ensure(
            r.reports() == [{"tenants": [{"tenant": "alpha-site", "scrapes": [None]}, {"tenant": "bravo-site", "scrapes": [None, None]}]}],
            f"every colour of every tenant is reported as null, not left out: {r.reports()}",
        )


def check_no_console_container_hands_nothing_over(mod: types.ModuleType) -> None:
    for ps in ({"stdout": ""}, {"stdout": CONTAINER + "\nfedcba987654\n"}, {"stdout": "not-an-id\n"}, {"exit": 1}):
        with Sidecar(body=HEALTHY.encode()) as host, rig(mod, ps=ps) as r:
            code, _ = r.main([f"alpha-site={host.url}"])
            ensure(code == 1, f"{ps}: no single console container makes the run fail")
            ensure(r.execs() == [], f"{ps}: nothing is run in a container that was not found")


def check_a_collector_that_fails_fails_the_run(mod: types.ModuleType) -> None:
    with Sidecar(body=HEALTHY.encode()) as host, rig(mod, run={"exit": 1}) as r:
        code, err = r.main([f"alpha-site={host.url}"])
        ensure(code == 1, "a collector that exits non-zero fails the run")
        ensure("the collector exited 1" in err, "the journal names the exit")


def check_the_children_get_no_environment(mod: types.ModuleType) -> None:
    with Sidecar(body=HEALTHY.encode()) as host, rig(mod) as r:
        r.main([f"alpha-site={host.url}"])
        for call in r.calls():
            extra = [name for name in call["env"] if name not in ("PATH", "LC_CTYPE", "__CF_USER_TEXT_ENCODING")]
            ensure(extra == [], f"the children get PATH alone, got {extra}")


def check_only_a_slug_and_private_ipv4_sidecar_addresses_are_taken(mod: types.ModuleType) -> None:
    good = "http://10.20.1.30:9300/metrics"
    bad = [
        f"alpha-site=http://8.8.8.8:9300/metrics",
        "alpha-site=http://example.com:9300/metrics",
        "alpha-site=https://10.20.1.30:9300/metrics",
        "alpha-site=http://10.20.1.30/metrics",
        "alpha-site=http://10.20.1.30:9300/other",
        "alpha-site=http://10.20.1.30:9300/metrics?x=1",
        "alpha-site=http://user:pass@10.20.1.30:9300/metrics",
        "alpha-site=http://[::1]:9300/metrics",
        f"alpha-site={good},{good},{good}",
        f"alpha-site={good},",
        f"{good}",
        f"Alpha Site={good}",
        f"../x={good}",
        f"a={good}",
        "alpha-site=",
        "",
    ]
    for argument in bad:
        with rig(mod) as r:
            code, _ = r.main([argument])
            ensure(code == 2, f"{argument!r} is a usage error, got {code}")
            ensure(r.calls() == [], f"{argument!r} runs nothing")
    with rig(mod) as r:
        code, _ = r.main([])
        ensure(code == 2 and r.calls() == [], "no argument is a usage error and runs nothing")
        code, _ = r.main([f"alpha-site={good}", f"bravo-site=http://8.8.8.8:9300/metrics"])
        ensure(code == 2 and r.calls() == [], "one bad argument among good ones stops the run before any fetch")
        code, _ = r.main([f"alpha-site={good}", f"alpha-site={good}"])
        ensure(code == 2 and r.calls() == [], "a slug named twice stops the run before any fetch")
    tenant = mod.parse_tenant(f"alpha-site={good},{good}")
    ensure(tenant.slug == "alpha-site" and len(tenant.colours) == 2, "a slug with two private addresses parses")


def check_the_units(_mod: types.ModuleType) -> None:
    service = SERVICE.read_text()
    ensure("Type=oneshot" in service, "the service is a oneshot")
    ensure(
        "ExecStart=/usr/local/sbin/branchleft-health-collect $HEALTH_TENANTS" in service,
        "the service runs the installed program with the tenants from the host file, split by systemd",
    )
    ensure("EnvironmentFile=/etc/branchleft/health-collect.env" in service, "the tenants come from the host file")
    ensure("User=" not in service, "it runs as root, as the Docker socket needs")
    timer = TIMER.read_text()
    ensure("OnUnitActiveSec=60s" in timer, "the timer fires 60 seconds after the last run finished")
    ensure("Persistent=" not in timer.replace("Not Persistent", ""), "a missed minute is not replayed")
    ensure("WantedBy=timers.target" in timer, "the timer is enabled on the timers target")


CHECKS: dict[str, Callable[[types.ModuleType], None]] = {
    "hands_over": check_hands_one_report_of_every_colour_to_the_collector,
    "unread_colour": check_a_colour_that_cannot_be_read_is_reported_as_null,
    "host_down": check_a_host_that_is_down_still_hands_over_so_the_old_reading_is_replaced,
    "no_container": check_no_console_container_hands_nothing_over,
    "collector_fails": check_a_collector_that_fails_fails_the_run,
    "env": check_the_children_get_no_environment,
    "arguments": check_only_a_slug_and_private_ipv4_sidecar_addresses_are_taken,
    "units": check_the_units,
}


class RealProgram(unittest.TestCase):
    module: types.ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load(PROGRAM)

    def test_the_program_passes_every_check(self) -> None:
        for name, check in CHECKS.items():
            with self.subTest(check=name):
                check(self.module)

    def test_the_program_is_installed_to_run_isolated(self) -> None:
        self.assertEqual(PROGRAM.read_text().splitlines()[0], "#!/usr/bin/python3 -I")

    def test_the_program_runs_only_docker_ps_and_docker_exec(self) -> None:
        source = PROGRAM.read_text()
        self.assertEqual(source.count("subprocess.run("), 1)
        self.assertNotIn("shell=True", source)
        self.assertNotIn("open(", source)


class Sabotage(unittest.TestCase):
    """The real source, broken in one named place, must turn the matching check red."""

    source: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PROGRAM.read_text()

    def broken(self, target: str, replacement: str) -> types.ModuleType:
        found = self.source.count(target)
        self.assertEqual(found, 1, f"the sabotage target must occur exactly once, found {found}: {target!r}")
        module = types.ModuleType("sabotaged_health_collect")
        module.__file__ = str(PROGRAM)
        sys.modules[module.__name__] = module
        exec(compile(self.source.replace(target, replacement), str(PROGRAM), "exec"), module.__dict__)  # noqa: S102
        return module

    def assert_red(self, module: types.ModuleType, check: str) -> None:
        with self.assertRaises(AssertionError):
            CHECKS[check](module)

    def test_the_helper_refuses_a_target_that_is_not_there(self) -> None:
        with self.assertRaises(AssertionError):
            self.broken("text that is not in the program", "x")

    def test_a_program_that_leaves_an_unread_colour_out_is_red(self) -> None:
        # The colour that did answer would then be read alone, and a stopped colour would look healthy.
        module = self.broken("            scrapes.append(None)\n", "            pass\n")
        self.assert_red(module, "unread_colour")
        self.assert_red(module, "host_down")

    def test_a_program_that_skips_a_tenant_it_could_not_read_is_red(self) -> None:
        module = self.broken(
            "        entries.append({'tenant': tenant.slug, 'scrapes': scrapes})",
            "        if complete:\n            entries.append({'tenant': tenant.slug, 'scrapes': scrapes})",
        )
        self.assert_red(module, "unread_colour")
        self.assert_red(module, "host_down")

    def test_a_program_that_hands_nothing_over_is_red(self) -> None:
        self.assert_red(self.broken("return 0 if hand_over(cfg, container, report) and ok else 1", "return 0"), "hands_over")

    def test_a_program_that_reports_success_with_an_unread_colour_is_red(self) -> None:
        self.assert_red(self.broken("and ok else 1", "else 1"), "unread_colour")

    def test_a_program_that_takes_any_status_is_red(self) -> None:
        self.assert_red(self.broken("if response.status != 200:", "if False:"), "unread_colour")

    def test_a_program_with_no_size_cap_is_red(self) -> None:
        self.assert_red(self.broken("if len(body) > MAX_BODY_BYTES:", "if False:"), "unread_colour")

    def test_a_program_with_no_deadline_is_red(self) -> None:
        self.assert_red(self.broken("if time.monotonic() > deadline:", "if False:"), "unread_colour")

    def test_a_program_that_runs_in_any_container_is_red(self) -> None:
        self.assert_red(self.broken("if len(ids) != 1 or", "if len(ids) < 1 or"), "no_container")

    def test_a_program_that_forgets_a_failed_collector_is_red(self) -> None:
        self.assert_red(self.broken("    if done.returncode != 0:\n        log(f'the collector exited", "    if False:\n        log(f'the collector exited"), "collector_fails")

    def test_a_program_that_passes_its_environment_on_is_red(self) -> None:
        self.assert_red(self.broken("env=CHILD_ENV", "env=None"), "env")

    def test_a_program_that_takes_a_public_address_is_red(self) -> None:
        self.assert_red(self.broken("if not ip.is_private:", "if False:"), "arguments")

    def test_a_program_that_takes_a_repeated_slug_is_red(self) -> None:
        self.assert_red(self.broken("if len({tenant.slug for tenant in tenants}) != len(tenants):", "if False:"), "arguments")

    def test_a_program_that_takes_any_slug_is_red(self) -> None:
        self.assert_red(self.broken("or SLUG.fullmatch(slug) is None", ""), "arguments")


if __name__ == "__main__":
    unittest.main()
