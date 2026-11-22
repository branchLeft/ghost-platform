"""Unit tests for branchleft_demo_egress.py against fakes; see branchleft_demo_egress.md, "Proof"."""

import importlib.util
import io
import os
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "branchleft_demo_egress.py")
UNIT = os.path.join(HERE, "branchleft-demo-egress.service")
GOLDEN = os.path.join(HERE, "demo-egress-ruleset.golden")
# The short name of the machine running the tests. The program refuses any
# host but the one it expects, so the positive cases name this machine.
THIS_HOST = socket.gethostname().split(".", 1)[0]


def lines(*parts):
    return "\n".join(parts) + "\n"


def fake(body):
    # Each fake is a Python script run by this interpreter, so the tests need
    # no shell. It logs under the name it was run as.
    return "#!" + sys.executable + "\n" + body


# One fake serves iptables and ip6tables.
FAKE_TABLES = fake(lines(
    "import os",
    "import sys",
    "import time",
    "tool = os.path.basename(sys.argv[0])",
    "args = ' '.join(sys.argv[1:])",
    "with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as log:",
    "    log.write(tool + ' ' + args + '\\n')",
    "if '-S DOCKER-USER' in args and os.environ.get('FAKE_HANG'):",
    "    time.sleep(5)",
    "if '--version' in args:",
    "    print(os.environ.get('FAKE_VERSION', 'iptables v1.8.11 (nf_tables)'))",
    "    sys.exit(0)",
    "if '-S DOCKER-USER' in args:",
    "    sys.exit(int(os.environ['FAKE_V4_DOCKER_USER_EXIT' if tool == 'iptables' else 'FAKE_V6_DOCKER_USER_EXIT']))",
    "if ' -C ' in args:",
    "    sys.exit(int(os.environ['FAKE_CHECK_EXIT']))",
    "sys.exit(0)",
))

FAKE_RESTORE = fake(lines(
    "import os",
    "import sys",
    "tool = os.path.basename(sys.argv[0])",
    "with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as log:",
    "    log.write(tool + ' ' + ' '.join(sys.argv[1:]) + '\\n')",
    "with open(os.path.join(os.environ['FAKE_DIR'], tool + '.stdin'), 'wb') as saved:",
    "    saved.write(sys.stdin.buffer.read())",
    "sys.exit(int(os.environ['FAKE_RESTORE_EXIT']))",
))

with open(GOLDEN, "rb") as _golden:
    EXPECTED_RULESET = _golden.read()

JUMP_INSERTS = [
    "-t filter -I DOCKER-USER 1 -j BRANCHLEFT-DEMO-EGRESS",
    "-t filter -I INPUT 1 -i docker0 -j BRANCHLEFT-DEMO-INPUT",
    "-t filter -I INPUT 1 -i br-+ -j BRANCHLEFT-DEMO-INPUT",
]


def install_fakes(bin_dir):
    for name, content in (("iptables", FAKE_TABLES), ("ip6tables", FAKE_TABLES),
                          ("iptables-restore", FAKE_RESTORE), ("ip6tables-restore", FAKE_RESTORE)):
        path = os.path.join(bin_dir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


def load_program():
    spec = importlib.util.spec_from_file_location("branchleft_demo_egress", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DemoEgressTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.bin = os.path.join(self.dir, "bin")
        os.makedirs(self.bin)
        self.log = os.path.join(self.dir, "calls.log")
        install_fakes(self.bin)

    def write_daemon_json(self, text):
        path = os.path.join(self.dir, "daemon.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def run_script(self, v4_chain=0, v6_chain=0, jumps_present=False, restore_exit=0,
                   expected_host=THIS_HOST, version="iptables v1.8.11 (nf_tables)",
                   daemon_json=None, extra_env=None):
        # A constructed environment, never os.environ: this shell may carry
        # live credentials, and nothing here needs any of them.
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_LOG": self.log,
            "FAKE_DIR": self.dir,
            "FAKE_V4_DOCKER_USER_EXIT": str(v4_chain),
            "FAKE_V6_DOCKER_USER_EXIT": str(v6_chain),
            "FAKE_CHECK_EXIT": "0" if jumps_present else "1",
            "FAKE_RESTORE_EXIT": str(restore_exit),
            "FAKE_VERSION": version,
            # Never the real /etc/docker/daemon.json: absent unless a test writes one.
            "BRANCHLEFT_DEMO_EGRESS_DAEMON_JSON": daemon_json or os.path.join(self.dir, "absent.json"),
        }
        # None leaves the variable unset, so the program's own default applies.
        if expected_host is not None:
            env["BRANCHLEFT_DEMO_EGRESS_HOST"] = expected_host
        if extra_env:
            env.update(extra_env)
        return subprocess.run([sys.executable, SCRIPT], env=env, capture_output=True,
                              text=True, check=False)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return handle.read().splitlines()

    def restored(self, tool):
        with open(os.path.join(self.dir, f"{tool}-restore.stdin"), "rb") as handle:
            return handle.read()

    def test_writes_the_exact_ruleset_to_both_families(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.restored("iptables"), EXPECTED_RULESET)
        self.assertEqual(self.restored("ip6tables"), EXPECTED_RULESET)

    def test_restores_without_flushing_anything_else(self):
        self.run_script()
        self.assertIn("iptables-restore --noflush", self.calls())
        self.assertIn("ip6tables-restore --noflush", self.calls())

    def test_inserts_every_jump_first_when_absent(self):
        self.run_script()
        for tool in ("iptables", "ip6tables"):
            inserts = [c.split(" ", 1)[1] for c in self.calls()
                       if c.startswith(f"{tool} ") and " -I " in c]
            self.assertEqual(inserts, JUMP_INSERTS)

    def test_rewrites_the_chains_before_it_jumps_to_them(self):
        self.run_script()
        calls = self.calls()
        self.assertLess(calls.index("iptables-restore --noflush"),
                        calls.index("iptables " + JUMP_INSERTS[0]))

    def test_a_rerun_adds_no_jump(self):
        result = self.run_script(jumps_present=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c for c in self.calls() if " -I " in c], [])
        self.assertEqual(self.restored("iptables"), EXPECTED_RULESET)

    def test_refuses_any_host_but_the_demo_host(self):
        if THIS_HOST == "demo1":
            self.skipTest("this machine is the demo host itself")
        result = self.run_script(expected_host=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not 'demo1'", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_the_expected_host_can_be_named(self):
        self.assertEqual(self.run_script(expected_host=THIS_HOST).returncode, 0)
        self.assertNotEqual(self.run_script(expected_host=THIS_HOST + "-other").returncode, 0)

    def test_makes_docker_user_before_the_ruleset_when_docker_has_not_started(self):
        result = self.run_script(v4_chain=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn("iptables -t filter -N DOCKER-USER", calls)
        self.assertLess(calls.index("iptables -t filter -N DOCKER-USER"),
                        calls.index("iptables-restore --noflush"))
        self.assertLess(calls.index("iptables-restore --noflush"),
                        calls.index("iptables " + JUMP_INSERTS[0]))

    def test_makes_docker_user_in_ipv6_too(self):
        result = self.run_script(v6_chain=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ip6tables -t filter -N DOCKER-USER", self.calls())

    def test_debian13_iptables_on_the_nf_tables_variant_still_applies_when_docker_is_legacy(self):
        # Debian 13 ships iptables 1.8.11, which prints (nf_tables) while Docker keeps
        # its rules in iptables. The variant alone must not refuse.
        # v4_chain=1: Docker has not started, so the chain is missing and the check runs.
        result = self.run_script(v4_chain=1, version="iptables v1.8.11 (nf_tables)")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.restored("iptables"), EXPECTED_RULESET)

    def test_applies_when_daemon_json_names_the_iptables_backend(self):
        path = self.write_daemon_json('{"firewall-backend": "iptables"}')
        result = self.run_script(v4_chain=1, version="iptables v1.8.11 (nf_tables)", daemon_json=path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_refuses_when_daemon_json_sets_docker_to_nftables_and_writes_nothing(self):
        path = self.write_daemon_json('{"firewall-backend": "nftables"}')
        result = self.run_script(v4_chain=1, daemon_json=path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("firewall-backend", result.stderr)
        self.assertEqual([c for c in self.calls() if "-N " in c or "-restore" in c or " -I " in c], [])

    def test_refuses_when_the_docker_environment_sets_nftables(self):
        result = self.run_script(v4_chain=1, extra_env={"DOCKER_FIREWALL_BACKEND": "nftables"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("firewall-backend", result.stderr)
        self.assertEqual([c for c in self.calls() if "-N " in c or "-restore" in c or " -I " in c], [])

    def test_refuses_an_unreadable_daemon_json_rather_than_guessing(self):
        path = self.write_daemon_json("{not json")
        result = self.run_script(daemon_json=path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot read", result.stderr)
        self.assertEqual(self.restored_calls(), [])

    def restored_calls(self):
        return [c for c in self.calls() if "-restore" in c or " -I " in c]

    def test_refuses_when_ip6tables_is_missing(self):
        os.remove(os.path.join(self.bin, "ip6tables"))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ip6tables is not installed", result.stderr)

    def test_a_failed_restore_stops_before_any_jump_with_its_status(self):
        result = self.run_script(restore_exit=3)
        self.assertEqual(result.returncode, 3)
        self.assertEqual([c for c in self.calls() if " -I " in c], [])

    def test_the_program_runs_no_shell(self):
        with open(SCRIPT, encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)


class ProgramFileTests(unittest.TestCase):
    def test_the_shebang_is_the_host_interpreter_in_isolated_mode(self):
        with open(SCRIPT, encoding="utf-8") as handle:
            first_line = handle.readline()
        # One argument only: Linux passes everything after the path as one.
        self.assertEqual(first_line, "#!/usr/bin/python3 -I\n")

    def test_the_program_is_executable_by_mode_0755(self):
        self.assertEqual(stat.S_IMODE(os.stat(SCRIPT).st_mode), 0o755)


class HungToolTests(unittest.TestCase):
    def test_a_hung_tool_stops_the_program_before_any_jump(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bin_dir = os.path.join(tmp.name, "bin")
        os.makedirs(bin_dir)
        install_fakes(bin_dir)
        log = os.path.join(tmp.name, "calls.log")
        program = load_program()
        program.TIMEOUT = 0.5
        env = {
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "FAKE_LOG": log,
            "FAKE_DIR": tmp.name,
            "FAKE_HANG": "1",
            "FAKE_V4_DOCKER_USER_EXIT": "0",
            "FAKE_V6_DOCKER_USER_EXIT": "0",
            "FAKE_CHECK_EXIT": "1",
            "FAKE_RESTORE_EXIT": "0",
            "BRANCHLEFT_DEMO_EGRESS_HOST": THIS_HOST,
            "BRANCHLEFT_DEMO_EGRESS_DAEMON_JSON": os.path.join(tmp.name, "absent.json"),
        }
        err = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), redirect_stderr(err):
            with self.assertRaises(SystemExit) as stopped:
                program.run()
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn("did not finish within 0.5s", err.getvalue())
        with open(log, encoding="utf-8") as handle:
            calls = handle.read().splitlines()
        self.assertEqual([c for c in calls if "-restore" in c or " -I " in c], [])


class UnitFileTests(unittest.TestCase):
    def setUp(self):
        with open(UNIT, encoding="utf-8") as handle:
            self.unit = handle.read().splitlines()

    def test_runs_the_installed_program_once_per_start(self):
        self.assertIn("ExecStart=/usr/local/sbin/branchleft-demo-egress", self.unit)
        self.assertIn("Type=oneshot", self.unit)

    def test_runs_before_docker_so_no_container_starts_unprotected(self):
        self.assertIn("Before=docker.service", self.unit)
        # After and Before on the same unit would be an ordering cycle with docker.
        self.assertNotIn("After=network-online.target docker.service", self.unit)
        self.assertFalse(any(line.startswith("After=") and "docker.service" in line
                             for line in self.unit))

    def test_follows_docker_restarts_without_starting_docker(self):
        self.assertIn("PartOf=docker.service", self.unit)
        self.assertFalse(any(line.startswith(("Requires=", "BindsTo=")) for line in self.unit))
        self.assertIn("WantedBy=multi-user.target docker.service", self.unit)


if __name__ == "__main__":
    unittest.main()
