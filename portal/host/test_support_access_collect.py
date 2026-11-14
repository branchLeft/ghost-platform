"""Tests for branchleft-support-access-collect.py. See test_support_access_collect.md.

The program under test fetches each host's exporter text over HTTP and runs two
things through `docker`: `docker ps` to find the console container, and
`docker exec -i` to hand the text to the collector in it. Here the exporters are
real local servers and `docker` is a stand-in executable that logs every call, its
environment and its standard input, so the tests see exactly what was run and what
was piped. No Docker, no root and no estate network.

Each property is a `check_*` function over a module. The real program must pass all
of them. The sabotage tests then break the real source in one named place, require
that the break was applied exactly once, and require the matching check to go red:
a check that cannot fail proves nothing.
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
PROGRAM = HERE / "branchleft-support-access-collect.py"
SERVICE = HERE / "branchleft-support-access-collect.service"
TIMER = HERE / "branchleft-support-access-collect.timer"

CONTAINER = "0123456789ab"
TEXT_ONE = 'branchleft_support_access_state{state="closed",tenant="alpha"} 1\n'
TEXT_TWO = 'branchleft_support_access_state{state="open",tenant="bravo"} 1\n'


def ensure(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: pathlib.Path, name: str = "support_access_collect") -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Exporter:
    """A local HTTP server standing in for one host's node_exporter."""

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

    def __enter__(self) -> Exporter:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/metrics"


def closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


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
            json.dumps({"ps": ps or {"stdout": CONTAINER + "\n"}, "exec": run or {"stderr": "support-access: alpha: recorded state=closed\n"}})
        )
        self.cfg = mod.Config(docker=str(stand_in), fetch_timeout_s=1.0, list_timeout_s=10.0, exec_timeout_s=10.0)

    def calls(self) -> list[dict[str, Any]]:
        log = self.base / "calls.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def execs(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][:1] == ["exec"]]

    def main(self, urls: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code: int = self.mod.main(urls, self.cfg)
        return code, err.getvalue()


@contextlib.contextmanager
def rig(mod: types.ModuleType, ps: dict[str, Any] | None = None, run: dict[str, Any] | None = None) -> Iterator[Rig]:
    with tempfile.TemporaryDirectory() as root:
        yield Rig(mod, pathlib.Path(root), ps, run)


# ---- the properties -------------------------------------------------------------------


def check_hands_each_host_text_to_the_collector(mod: types.ModuleType) -> None:
    with Exporter(body=TEXT_ONE.encode()) as one, Exporter(body=TEXT_TWO.encode()) as two, rig(mod) as r:
        code, err = r.main([one.url, two.url])
        ensure(code == 0, f"a clean run exits 0, got {code}: {err}")
        execs = r.execs()
        ensure(
            [e["argv"] for e in execs] == [["exec", "-i", CONTAINER, "node", "dist/collector/main.js"]] * 2,
            f"one docker exec -i per host, nothing else on the command line: {[e['argv'] for e in execs]}",
        )
        ensure([e["stdin"] for e in execs] == [TEXT_ONE, TEXT_TWO], "each host's text is piped to the collector as it came")
        ensure("recorded state=closed" in err, "the collector's own run line reaches the journal")
        ps = [c for c in r.calls() if c["argv"][:1] == ["ps"]]
        ensure(len(ps) == 1, "the console container is looked up once per run")
        ensure(
            "label=com.docker.compose.project=control-plane" in ps[0]["argv"]
            and "label=com.docker.compose.service=console" in ps[0]["argv"]
            and "status=running" in ps[0]["argv"],
            f"the lookup names the project, the service and running: {ps[0]['argv']}",
        )


def check_a_host_that_cannot_be_read_hands_nothing_over(mod: types.ModuleType) -> None:
    cases: dict[str, Callable[[], Exporter | int]] = {
        "answers 500": lambda: Exporter(status=500, body=TEXT_ONE.encode()),
        "answers 404": lambda: Exporter(status=404, body=TEXT_ONE.encode()),
        "is not a path of metrics": lambda: Exporter(body=TEXT_ONE.encode(), path="/other"),
        "sends more than a megabyte": lambda: Exporter(body=b"a" * (mod.MAX_BODY_BYTES + 1)),
        "is silent for longer than the limit": lambda: Exporter(body=TEXT_ONE.encode(), delay_s=2.0),
        "drips its answer past the limit": lambda: Exporter(body=b"abcdefgh", drip_s=0.4),
        "is not listening": closed_port,
    }
    for name, make in cases.items():
        made = make()
        with contextlib.ExitStack() as stack:
            if isinstance(made, Exporter):
                stack.enter_context(made)
                url = made.url
            else:
                url = f"http://127.0.0.1:{made}/metrics"
            r = stack.enter_context(rig(mod))
            with Exporter(body=TEXT_TWO.encode()) as good:
                code, err = r.main([url, good.url])
                ensure(code == 1, f"a host that {name} makes the run fail, got {code}")
                ensure(
                    [e["stdin"] for e in r.execs()] == [TEXT_TWO],
                    f"a host that {name} hands nothing over, not even empty text, and the next host still runs: {[e['stdin'] for e in r.execs()]}",
                )
                ensure("nothing written" in err, f"the journal says nothing was written for a host that {name}")


def check_an_empty_answer_is_handed_over_as_it_is(mod: types.ModuleType) -> None:
    # A host that answers 200 with no series is a host with no tenant to report; the
    # collector writes nothing for it. It is not a failed fetch, and not closed either.
    with Exporter(body=b"") as host, rig(mod) as r:
        code, _ = r.main([host.url])
        ensure(code == 0, "an empty exporter answer is a normal run")
        ensure([e["stdin"] for e in r.execs()] == [""], "the empty text is handed over unchanged")


def check_no_console_container_hands_nothing_over(mod: types.ModuleType) -> None:
    for ps in ({"stdout": ""}, {"stdout": CONTAINER + "\nfedcba987654\n"}, {"stdout": "not-an-id\n"}, {"exit": 1}):
        with Exporter(body=TEXT_ONE.encode()) as host, rig(mod, ps=ps) as r:
            code, _ = r.main([host.url])
            ensure(code == 1, f"{ps}: no single console container makes the run fail")
            ensure(r.execs() == [], f"{ps}: nothing is run in a container that was not found")


def check_a_collector_that_fails_fails_the_run(mod: types.ModuleType) -> None:
    with Exporter(body=TEXT_ONE.encode()) as one, Exporter(body=TEXT_TWO.encode()) as two, rig(mod, run={"exit": 1}) as r:
        code, err = r.main([one.url, two.url])
        ensure(code == 1, "a collector that exits non-zero fails the run")
        ensure(len(r.execs()) == 2, "and the next host is still handed over")
        ensure("the collector exited 1" in err, "the journal names the exit")


def check_the_children_get_no_environment(mod: types.ModuleType) -> None:
    with Exporter(body=TEXT_ONE.encode()) as host, rig(mod) as r:
        r.main([host.url])
        for call in r.calls():
            extra = [name for name in call["env"] if name not in ("PATH", "LC_CTYPE", "__CF_USER_TEXT_ENCODING")]
            ensure(extra == [], f"the children get PATH alone, got {extra}")


def check_only_a_private_ipv4_exporter_address_is_taken(mod: types.ModuleType) -> None:
    bad = [
        "http://8.8.8.8:9100/metrics",
        "http://example.com:9100/metrics",
        "https://10.20.1.30:9100/metrics",
        "http://10.20.1.30/metrics",
        "http://10.20.1.30:9100/other",
        "http://10.20.1.30:9100/metrics?x=1",
        "http://10.20.1.30:9100/metrics#x",
        "http://user:pass@10.20.1.30:9100/metrics",
        "http://10.20.1.30:0/metrics",
        "http://[::1]:9100/metrics",
        "http://10.20.1.30:99999/metrics",
        "10.20.1.30:9100/metrics",
        "",
    ]
    for url in bad:
        with rig(mod) as r:
            code, _ = r.main([url])
            ensure(code == 2, f"{url!r} is a usage error, got {code}")
            ensure(r.calls() == [], f"{url!r} runs nothing")
    with rig(mod) as r:
        code, _ = r.main([])
        ensure(code == 2 and r.calls() == [], "no address is a usage error and runs nothing")
        code, _ = r.main(["http://10.20.1.30:9100/metrics", "http://8.8.8.8:9100/metrics"])
        ensure(code == 2 and r.calls() == [], "one bad address among good ones stops the run before any fetch")
    ensure(mod.parse_target("http://10.20.1.30:9100/metrics") == mod.Target("10.20.1.30", 9100), "a private address parses")


def check_the_units(_mod: types.ModuleType) -> None:
    service = SERVICE.read_text()
    ensure("Type=oneshot" in service, "the service is a oneshot")
    ensure(
        "ExecStart=/usr/local/sbin/branchleft-support-access-collect $SUPPORT_ACCESS_EXPORTERS" in service,
        "the service runs the installed program with the addresses from the host file, split by systemd",
    )
    ensure("EnvironmentFile=/etc/branchleft/support-access-collect.env" in service, "the addresses come from the host file")
    ensure("User=" not in service, "it runs as root, as the Docker socket needs")
    timer = TIMER.read_text()
    ensure("OnUnitActiveSec=60s" in timer, "the timer fires 60 seconds after the last run finished")
    ensure("Persistent=" not in timer, "a missed minute is not replayed")
    ensure("WantedBy=timers.target" in timer, "the timer is enabled on the timers target")


CHECKS: dict[str, Callable[[types.ModuleType], None]] = {
    "hands_over": check_hands_each_host_text_to_the_collector,
    "unreadable_host": check_a_host_that_cannot_be_read_hands_nothing_over,
    "empty_answer": check_an_empty_answer_is_handed_over_as_it_is,
    "no_container": check_no_console_container_hands_nothing_over,
    "collector_fails": check_a_collector_that_fails_fails_the_run,
    "env": check_the_children_get_no_environment,
    "addresses": check_only_a_private_ipv4_exporter_address_is_taken,
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
        for word in ("grant", "revoke", "expire", "report", "status", "mint", "recordSupportAccess"):
            self.assertNotIn(f"'{word}'", source)
        self.assertEqual(source.count("subprocess.run("), 1)
        self.assertNotIn("shell=True", source)


class Sabotage(unittest.TestCase):
    """The real source, broken in one named place, must turn the matching check red."""

    source: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PROGRAM.read_text()

    def broken(self, target: str, replacement: str) -> types.ModuleType:
        found = self.source.count(target)
        self.assertEqual(found, 1, f"the sabotage target must occur exactly once, found {found}: {target!r}")
        module = types.ModuleType("sabotaged_collect")
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

    def test_a_program_that_hands_over_nothing_is_red(self) -> None:
        self.assert_red(self.broken("if not hand_over(cfg, container, text):", "if False:"), "hands_over")

    def test_a_program_that_hands_over_empty_text_for_an_unreadable_host_is_red(self) -> None:
        module = self.broken(
            "            log(f'{label}: nothing written: {exc}')\n            ok = False\n            continue\n        try:\n            container",
            "            log(f'{label}: nothing written: {exc}')\n            ok = False\n            text = b''\n        try:\n            container",
        )
        self.assert_red(module, "unreadable_host")

    def test_a_program_that_takes_any_status_is_red(self) -> None:
        self.assert_red(self.broken("if response.status != 200:", "if False:"), "unreadable_host")

    def test_a_program_with_no_size_cap_is_red(self) -> None:
        self.assert_red(self.broken("if len(body) > MAX_BODY_BYTES:", "if False:"), "unreadable_host")

    def test_a_program_with_no_deadline_is_red(self) -> None:
        self.assert_red(self.broken("if time.monotonic() > deadline:", "if False:"), "unreadable_host")

    def test_a_program_that_runs_in_any_container_is_red(self) -> None:
        self.assert_red(self.broken("if len(ids) != 1 or", "if len(ids) < 1 or"), "no_container")

    def test_a_program_that_forgets_a_failed_collector_is_red(self) -> None:
        self.assert_red(self.broken("    if done.returncode != 0:\n        log(f'the collector exited", "    if False:\n        log(f'the collector exited"), "collector_fails")

    def test_a_program_that_passes_its_environment_on_is_red(self) -> None:
        self.assert_red(self.broken("env=CHILD_ENV", "env=None"), "env")

    def test_a_program_that_takes_a_public_address_is_red(self) -> None:
        self.assert_red(self.broken("if not address.is_private:", "if False:"), "addresses")

    def test_a_program_that_takes_a_name_is_red(self) -> None:
        module = self.broken(
            "    try:\n        address = ipaddress.IPv4Address(host)\n    except ValueError:\n        raise UsageError('an exporter address must be an IPv4 address, not a name') from None\n",
            "    address = ipaddress.IPv4Address('10.0.0.1')\n",
        )
        self.assert_red(module, "addresses")


if __name__ == "__main__":
    unittest.main()
