#!/usr/bin/env python3
"""Behavioural proof of the tenant GRANT target, against the pinned MySQL 8.0.

Two valid tenant names, `a-b` and `a1b`, map to databases `ghost_a_b` and
`ghost_a1b`. The statements provision_tenant_database generates are applied
to a real server, then tenant `a-b`'s account is used from a client on the
tenant host subnet. It must reach its own database and must be refused on
the other tenant's database.

Skips, never fails, when Docker does not answer within 20s. All containers
and the network carry a label and are removed afterwards.
"""

import shutil
import subprocess
import time
import unittest

import provision_tenant_db as ptd

MYSQL_IMAGE = "mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b"
LABEL = "branchleft.agent=tenant-grant-escape"
NETWORK = "tenant-grant-escape-net"
SERVER = "tenant-grant-escape-mysql"
# The account host pattern in naming.py is 10.20.1.%, so the subnet and the
# client address below must sit inside it for the account to match at all.
SUBNET = "10.20.1.0/24"
SERVER_IP = "10.20.1.2"
CLIENT_IP = "10.20.1.10"
ROOT_PWD = "throwaway-root-pwd"
TENANT_A_B_PWD = "throwaway-tenant-ab-pwd"


def _docker(*args, timeout=180):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def _docker_answers_within(seconds: float) -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        subprocess.run(["docker", "info"], capture_output=True, timeout=seconds, check=True)
        return True
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        return False


def _provisioning_sql(tenant: str, password: str) -> str:
    """The exact batch provision_tenant_database would send, captured rather
    than run against the fake socket."""
    sent = []

    def run(argv, env=None, capture_output=None, text=None, check=None):
        sent.append(argv[argv.index("-e") + 1])
        return subprocess.CompletedProcess(argv, 0, stdout="0\n", stderr="")

    ptd.provision_tenant_database(
        tenant,
        socket_path="/unused.sock",
        admin_user="root",
        admin_password=ROOT_PWD,
        password_factory=lambda: password,
        run=run,
    )
    return sent[-1]


class TenantGrantAgainstRealMysqlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not _docker_answers_within(20):
            raise unittest.SkipTest("docker did not answer within 20s")
        _docker("rm", "-f", "-v", SERVER)
        net = _docker("network", "create", "--subnet", SUBNET, "--label", LABEL, NETWORK)
        if net.returncode != 0:
            raise unittest.SkipTest(f"docker network create failed: {net.stderr.strip()}")
        cls.addClassCleanup(cls._cleanup)
        run = _docker(
            "run", "-d", "--rm", "--name", SERVER, "--label", LABEL,
            "--network", NETWORK, "--ip", SERVER_IP,
            "-e", f"MYSQL_ROOT_PASSWORD={ROOT_PWD}",
            MYSQL_IMAGE,
        )
        if run.returncode != 0:
            raise unittest.SkipTest(f"docker run failed: {run.stderr.strip()}")
        cls._wait_for_server()
        cls._root_sql(
            "CREATE DATABASE ghost_a1b; CREATE TABLE ghost_a1b.secret (v INT); "
            "INSERT INTO ghost_a1b.secret VALUES (42);"
        )
        cls._root_sql(_provisioning_sql("a-b", TENANT_A_B_PWD))
        cls._root_sql(_provisioning_sql("a1b", "throwaway-tenant-a1b-pwd"))
        cls._root_sql(
            "CREATE TABLE ghost_a_b.own (v INT); INSERT INTO ghost_a_b.own VALUES (7);"
        )

    @classmethod
    def _cleanup(cls) -> None:
        _docker("rm", "-f", "-v", SERVER)
        _docker("network", "rm", NETWORK)

    @classmethod
    def _wait_for_server(cls, deadline_s: float = 150.0) -> None:
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            probe = _docker(
                "exec", "-e", f"MYSQL_PWD={ROOT_PWD}", SERVER,
                "mysql", "--protocol=TCP", "-h127.0.0.1", "-uroot", "-e", "SELECT 1",
            )
            if probe.returncode == 0:
                return
            time.sleep(2)
        raise AssertionError(f"mysqld in {SERVER} never answered within {deadline_s}s")

    @classmethod
    def _root_sql(cls, sql: str) -> None:
        out = _docker("exec", "-e", f"MYSQL_PWD={ROOT_PWD}", SERVER, "mysql", "-uroot", "-e", sql)
        if out.returncode != 0:
            raise AssertionError(f"root SQL failed: {out.stderr.strip()}")

    def _as_tenant_ab(self, sql: str) -> subprocess.CompletedProcess:
        return _docker(
            "run", "--rm", "--label", LABEL, "--network", NETWORK, "--ip", CLIENT_IP,
            "-e", f"MYSQL_PWD={TENANT_A_B_PWD}",
            MYSQL_IMAGE,
            "mysql", "--ssl-mode=REQUIRED", "-h", SERVER_IP, "-u", "ghost_a_b", "-e", sql,
        )

    def test_control_tenant_ab_reads_its_own_database(self):
        out = self._as_tenant_ab("SELECT v FROM ghost_a_b.own")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("7", out.stdout)

    def test_tenant_ab_is_refused_on_tenant_a1b_database(self):
        out = self._as_tenant_ab("SELECT v FROM ghost_a1b.secret")
        self.assertNotEqual(out.returncode, 0, f"read another tenant's table: {out.stdout}")
        self.assertIn("denied", out.stderr.lower())


if __name__ == "__main__":
    unittest.main()
