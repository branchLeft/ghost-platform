"""Unit tests for branchleft_demo_egress.sh, against fakes for netfilter and
the hostname. scripts/test-demo-container-egress.sh proves the same script
against a real dockerd."""

import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "branchleft_demo_egress.sh")
UNIT = os.path.join(HERE, "branchleft-demo-egress.service")

FAKE_HOSTNAME = """#!/bin/sh
echo "$FAKE_HOSTNAME"
"""

# One fake serves iptables and ip6tables; it logs under the name it was run as.
FAKE_TABLES = """#!/bin/sh
tool="$(basename "$0")"
echo "$tool $*" >> "$FAKE_LOG"
case "$*" in
    *"-S DOCKER-USER"*)
        [ "$tool" = iptables ] && exit "$FAKE_V4_DOCKER_USER_EXIT"
        exit "$FAKE_V6_DOCKER_USER_EXIT" ;;
    *" -C "*) exit "$FAKE_CHECK_EXIT" ;;
esac
exit 0
"""

FAKE_RESTORE = """#!/bin/sh
tool="$(basename "$0")"
echo "$tool $*" >> "$FAKE_LOG"
cat > "$FAKE_DIR/$tool.stdin"
exit "$FAKE_RESTORE_EXIT"
"""

EXPECTED_RULESET = """*filter
:BRANCHLEFT-DEMO-EGRESS - [0:0]
:BRANCHLEFT-DEMO-INPUT - [0:0]
-A BRANCHLEFT-DEMO-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A BRANCHLEFT-DEMO-EGRESS -i docker0 ! -o docker0 -j DROP
-A BRANCHLEFT-DEMO-EGRESS -i br-+ ! -o br-+ -j DROP
-A BRANCHLEFT-DEMO-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A BRANCHLEFT-DEMO-INPUT -j DROP
COMMIT
"""

JUMP_INSERTS = [
    "-t filter -I DOCKER-USER 1 -j BRANCHLEFT-DEMO-EGRESS",
    "-t filter -I INPUT 1 -i docker0 -j BRANCHLEFT-DEMO-INPUT",
    "-t filter -I INPUT 1 -i br-+ -j BRANCHLEFT-DEMO-INPUT",
]


class DemoEgressTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.bin = os.path.join(self.dir, "bin")
        os.makedirs(self.bin)
        self.log = os.path.join(self.dir, "calls.log")
        self._fake("hostname", FAKE_HOSTNAME)
        for tool in ("iptables", "ip6tables"):
            self._fake(tool, FAKE_TABLES)
            self._fake(f"{tool}-restore", FAKE_RESTORE)

    def _fake(self, name, content):
        path = os.path.join(self.bin, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)

    def run_script(self, hostname="demo1", v4_chain=0, v6_chain=0, jumps_present=False,
                   restore_exit=0, expected_host=None):
        # A constructed environment, never os.environ: this shell may carry
        # live credentials, and nothing here needs any of them.
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_LOG": self.log,
            "FAKE_DIR": self.dir,
            "FAKE_HOSTNAME": hostname,
            "FAKE_V4_DOCKER_USER_EXIT": str(v4_chain),
            "FAKE_V6_DOCKER_USER_EXIT": str(v6_chain),
            "FAKE_CHECK_EXIT": "0" if jumps_present else "1",
            "FAKE_RESTORE_EXIT": str(restore_exit),
        }
        if expected_host is not None:
            env["BRANCHLEFT_DEMO_EGRESS_HOST"] = expected_host
        return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True,
                              check=False)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return handle.read().splitlines()

    def restored(self, tool):
        with open(os.path.join(self.dir, f"{tool}-restore.stdin"), encoding="utf-8") as handle:
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
        result = self.run_script(hostname="app1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not 'demo1'", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_the_expected_host_can_be_named(self):
        self.assertEqual(self.run_script(hostname="scratch", expected_host="scratch").returncode, 0)
        self.assertNotEqual(self.run_script(hostname="demo1", expected_host="scratch").returncode, 0)

    def test_refuses_without_docker_user_and_writes_nothing(self):
        result = self.run_script(v4_chain=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no DOCKER-USER chain in iptables", result.stderr)
        self.assertEqual([c for c in self.calls() if "-restore" in c or " -I " in c], [])

    def test_refuses_when_ipv6_has_no_docker_user(self):
        result = self.run_script(v6_chain=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no DOCKER-USER chain in ip6tables", result.stderr)
        self.assertNotIn("ip6tables-restore --noflush", self.calls())

    def test_refuses_when_ip6tables_is_missing(self):
        os.remove(os.path.join(self.bin, "ip6tables"))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ip6tables is not installed", result.stderr)

    def test_a_failed_restore_stops_before_any_jump(self):
        result = self.run_script(restore_exit=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([c for c in self.calls() if " -I " in c], [])


class UnitFileTests(unittest.TestCase):
    def setUp(self):
        with open(UNIT, encoding="utf-8") as handle:
            self.unit = handle.read().splitlines()

    def test_runs_the_installed_script_once_per_start(self):
        self.assertIn("ExecStart=/usr/local/sbin/branchleft-demo-egress", self.unit)
        self.assertIn("Type=oneshot", self.unit)

    def test_follows_docker_restarts_without_starting_docker(self):
        self.assertIn("PartOf=docker.service", self.unit)
        self.assertIn("After=network-online.target docker.service", self.unit)
        self.assertFalse(any(line.startswith(("Requires=", "BindsTo=")) for line in self.unit))
        self.assertIn("WantedBy=multi-user.target docker.service", self.unit)


if __name__ == "__main__":
    unittest.main()
