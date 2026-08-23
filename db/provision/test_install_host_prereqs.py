#!/usr/bin/env python3
"""Unit tests for install_host_prereqs.py.

Every external command and network fetch is faked -- no real apt, dpkg, gpg
or HTTP call -- so these assert the constraints found live during the first
db1 bootstrap (2026-08-23) rather than re-testing apt or dpkg themselves:
bookworm (never trixie) is the pinned release, both signing keys go into one
keyring, mysqldump/mysqlbinlog must report exactly 8.0.x, and -- the
property that matters most for a script meant to run again on an
already-provisioned host -- a fully-satisfied host makes no apt-get, dpkg,
gpg or network call at all.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

import install_host_prereqs as ihp


def _cmp_versions(a: str, b: str) -> int:
    """Minimal Debian-version-ish comparator for FakeRun's
    `dpkg --compare-versions`: splits on non-alphanumeric runs and compares
    piece by piece as integers where possible. Good enough for the
    well-formed numeric-with-hyphen versions these tests use."""

    def parts(v: str) -> list:
        out = []
        for piece in v.replace("-", ".").split("."):
            out.append(int(piece) if piece.isdigit() else piece)
        return out

    pa, pb = parts(a), parts(b)
    for x, y in zip(pa, pb):
        if x == y:
            continue
        try:
            return -1 if x < y else 1
        except TypeError:
            return -1 if str(x) < str(y) else 1
    return (len(pa) > len(pb)) - (len(pa) < len(pb))


class FakeRun:
    """Records every command invoked and returns canned, plausible output --
    no real apt/dpkg/gpg binary is ever exec'd."""

    def __init__(
        self,
        installed=None,
        apt_install_fail=None,
        dpkg_i_fail=False,
        version_output=None,
        dearmor_output=b"KEYRING-BYTES",
    ):
        self.installed = set(installed or [])
        self.calls = []
        self.apt_install_fail = apt_install_fail
        self.dpkg_i_fail = dpkg_i_fail
        self.version_output = version_output or {}
        self.dearmor_output = dearmor_output

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        cmd = argv[0]

        if cmd == "dpkg-query":
            package = argv[-1]
            if package in self.installed:
                return subprocess.CompletedProcess(argv, 0, stdout="install ok installed", stderr="")
            return subprocess.CompletedProcess(argv, 1, stdout="unknown ok not-installed", stderr="")

        if cmd == "apt-get":
            if argv[1] == "update":
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
            if argv[1] == "install":
                package = argv[-1]
                if package == self.apt_install_fail:
                    return subprocess.CompletedProcess(argv, 100, stdout="", stderr="boom")
                self.installed.add(package)
                return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        if cmd == "gpg" and argv[1] == "--dearmor":
            return subprocess.CompletedProcess(argv, 0, stdout=self.dearmor_output, stderr=b"")

        if cmd == "dpkg" and argv[1] == "--compare-versions":
            candidate, op, newest = argv[2], argv[3], argv[4]
            assert op == "gt"
            result = _cmp_versions(candidate, newest) > 0
            return subprocess.CompletedProcess(argv, 0 if result else 1, stdout="", stderr="")

        if cmd == "dpkg" and argv[1] == "-i":
            if self.dpkg_i_fail:
                return subprocess.CompletedProcess(argv, 1, stdout="", stderr="dpkg: dependency problems")
            self.installed.add(ihp.LIBAIO1_PACKAGE)
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        if cmd in ("mysqldump", "mysqlbinlog"):
            default = f"{cmd}  Ver 8.0.39 for Linux on x86_64 (MySQL Community Server - GPL)"
            return subprocess.CompletedProcess(argv, 0, stdout=self.version_output.get(cmd, default), stderr="")

        raise AssertionError(f"unexpected command: {argv}")


class FakeFetch:
    def __init__(self, pages=None):
        self.pages = pages or {}
        self.urls = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        if url in self.pages:
            return self.pages[url]
        raise AssertionError(f"unexpected fetch: {url}")


class IsInstalledTests(unittest.TestCase):
    def test_true_when_dpkg_reports_installed(self):
        run = FakeRun(installed={"age"})
        self.assertTrue(ihp.is_installed("age", run=run))

    def test_false_when_absent(self):
        run = FakeRun(installed=set())
        self.assertFalse(ihp.is_installed("age", run=run))

    def test_false_for_a_removed_but_not_purged_package(self):
        # dpkg-query still exits 0 for a package in "deinstall ok
        # config-files" state; only the exact "install ok installed" status
        # counts as present.
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, stdout="deinstall ok config-files", stderr="")

        self.assertFalse(ihp.is_installed("age", run=fake_run))


class MysqlAptSourceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.list_path = os.path.join(self.dir, "mysql-community.list")

    def test_pins_bookworm_and_mysql_8_0_never_trixie(self):
        ihp.ensure_mysql_apt_source(list_path=self.list_path, keyring_path="/keyring.gpg")
        with open(self.list_path, encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("bookworm", content)
        self.assertIn("mysql-8.0", content)
        self.assertNotIn("trixie", content)

    def test_references_the_given_keyring_via_signed_by(self):
        ihp.ensure_mysql_apt_source(list_path=self.list_path, keyring_path="/keyring.gpg")
        with open(self.list_path, encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("signed-by=/keyring.gpg", content)

    def test_first_write_reports_changed(self):
        changed = ihp.ensure_mysql_apt_source(list_path=self.list_path, keyring_path="/keyring.gpg")
        self.assertTrue(changed)

    def test_a_second_call_with_identical_content_reports_unchanged(self):
        ihp.ensure_mysql_apt_source(list_path=self.list_path, keyring_path="/keyring.gpg")
        changed = ihp.ensure_mysql_apt_source(list_path=self.list_path, keyring_path="/keyring.gpg")
        self.assertFalse(changed)


class MysqlGpgKeyringTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.keyring_path = os.path.join(self.dir, "mysql-community.gpg")

    def test_fetches_both_the_2025_and_2023_keys(self):
        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"KEY-2025",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"KEY-2023",
            }
        )
        run = FakeRun()
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertEqual(
            fetch.urls,
            [
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023",
            ],
        )

    def test_dearmors_both_keys_concatenated_into_one_call(self):
        calls = []

        def run(argv, input=None, **kwargs):
            calls.append((list(argv), input))
            return subprocess.CompletedProcess(argv, 0, stdout=b"KEYRING", stderr=b"")

        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"KEY-2025-",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"KEY-2023-",
            }
        )
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertEqual(len(calls), 1)
        argv, piped_input = calls[0]
        self.assertEqual(argv, ["gpg", "--dearmor"])
        self.assertEqual(piped_input, b"KEY-2025-KEY-2023-")

    def test_writes_the_dearmored_output_to_the_keyring_path(self):
        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
            }
        )
        run = FakeRun()
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        with open(self.keyring_path, "rb") as handle:
            self.assertEqual(handle.read(), b"KEYRING-BYTES")

    def test_no_op_and_no_network_when_the_keyring_already_exists(self):
        with open(self.keyring_path, "wb") as handle:
            handle.write(b"already-here")
        fetch = FakeFetch()
        run = FakeRun()
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertEqual(fetch.urls, [])
        self.assertEqual(run.calls, [])

    def test_raises_when_dearmor_fails(self):
        def run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 2, stdout=b"", stderr=b"gpg: no valid data found")

        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
            }
        )
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)


class PickNewestDebTests(unittest.TestCase):
    def test_picks_the_higher_version_regardless_of_list_order(self):
        run = FakeRun()
        chosen = ihp.pick_newest_deb(
            ["libaio1_0.3.113-4_amd64.deb", "libaio1_0.3.113-13_amd64.deb"], run=run
        )
        # Lexical/text sort would wrongly prefer "-4" over "-13" as if they
        # were single-digit strings ("4" > "1"); the dpkg comparator must not
        # make that mistake.
        self.assertEqual(chosen, "libaio1_0.3.113-13_amd64.deb")

    def test_single_candidate_is_returned_unconditionally(self):
        run = FakeRun()
        chosen = ihp.pick_newest_deb(["libaio1_0.3.113-4_amd64.deb"], run=run)
        self.assertEqual(chosen, "libaio1_0.3.113-4_amd64.deb")

    def test_raises_on_an_empty_candidate_list(self):
        with self.assertRaises(ihp.HostPrereqError):
            ihp.pick_newest_deb([], run=FakeRun())


class EnsureLibaio1Tests(unittest.TestCase):
    LISTING_HTML = (
        '<a href="libaio1_0.3.113-4_amd64.deb">libaio1_0.3.113-4_amd64.deb</a>\n'
        '<a href="libaio1_0.3.113-13_amd64.deb">libaio1_0.3.113-13_amd64.deb</a>\n'
        '<a href="libaio1_0.3.113-4_arm64.deb">libaio1_0.3.113-4_arm64.deb</a>\n'
    )

    def test_no_op_when_already_installed(self):
        run = FakeRun(installed={ihp.LIBAIO1_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_libaio1(run=run, fetch=fetch)
        self.assertEqual(fetch.urls, [])
        # Only the presence check runs; no download, no dpkg -i.
        self.assertEqual(run.calls, [["dpkg-query", "-W", "-f=${Status}", ihp.LIBAIO1_PACKAGE]])

    def test_fetches_the_pool_listing_and_installs_the_newest_amd64_deb(self):
        run = FakeRun()
        fetch = FakeFetch(
            {
                ihp.LIBAIO1_POOL_URL: self.LISTING_HTML.encode(),
                ihp.LIBAIO1_POOL_URL + "libaio1_0.3.113-13_amd64.deb": b"DEB-BYTES",
            }
        )
        ihp.ensure_libaio1(run=run, fetch=fetch)
        dpkg_i_calls = [c for c in run.calls if c[0] == "dpkg" and c[1] == "-i"]
        self.assertEqual(len(dpkg_i_calls), 1)
        self.assertTrue(dpkg_i_calls[0][2].endswith(".deb"))

    def test_never_considers_a_non_amd64_deb(self):
        run = FakeRun()
        fetch = FakeFetch(
            {
                ihp.LIBAIO1_POOL_URL: '<a href="libaio1_9.9.9_arm64.deb">x</a>'.encode(),
            }
        )
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_libaio1(run=run, fetch=fetch)

    def test_raises_when_dpkg_install_fails(self):
        run = FakeRun(dpkg_i_fail=True)
        fetch = FakeFetch(
            {
                ihp.LIBAIO1_POOL_URL: self.LISTING_HTML.encode(),
                ihp.LIBAIO1_POOL_URL + "libaio1_0.3.113-13_amd64.deb": b"DEB-BYTES",
            }
        )
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_libaio1(run=run, fetch=fetch)

    def test_raises_when_the_pool_listing_has_no_candidate(self):
        run = FakeRun()
        fetch = FakeFetch({ihp.LIBAIO1_POOL_URL: b"<html></html>"})
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_libaio1(run=run, fetch=fetch)


class VerifyTests(unittest.TestCase):
    def test_passes_when_age_present_and_both_tools_report_8_0_x(self):
        run = FakeRun(installed={"age"})
        self.assertEqual(ihp.verify(run=run), [])

    def test_flags_age_missing(self):
        run = FakeRun(installed=set())
        problems = ihp.verify(run=run)
        self.assertTrue(any("age" in p for p in problems))

    def test_flags_a_mysqldump_84_client_against_the_8_0_server(self):
        # The exact failure mode from the live bootstrap: an 8.4 client
        # exists, runs, and even prints a version -- it is simply the wrong
        # one for the mysqldump --source-data path.
        run = FakeRun(
            installed={"age"},
            version_output={
                "mysqldump": "mysqldump  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)",
            },
        )
        problems = ihp.verify(run=run)
        self.assertTrue(any("mysqldump" in p and "8.4.3" in p for p in problems))

    def test_mysqlbinlog_from_a_newer_client_is_still_flagged_even_though_it_would_work(self):
        # Proven live that 8.4's mysqlbinlog reads an 8.0 server's binlogs
        # fine -- but this script promises an exact-matched toolchain, and a
        # silently-drifted mysqlbinlog is still worth surfacing.
        run = FakeRun(
            installed={"age"},
            version_output={
                "mysqlbinlog": "mysqlbinlog  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)",
            },
        )
        problems = ihp.verify(run=run)
        self.assertTrue(any("mysqlbinlog" in p for p in problems))

    def test_flags_a_binary_that_fails_to_run(self):
        def run_with_failure(argv, **kwargs):
            if argv[0] == "dpkg-query":
                return subprocess.CompletedProcess(argv, 0, stdout="install ok installed", stderr="")
            if argv[0] == "mysqldump":
                return subprocess.CompletedProcess(argv, 127, stdout="", stderr="not found")
            return subprocess.CompletedProcess(argv, 0, stdout="mysqlbinlog  Ver 8.0.39", stderr="")

        problems = ihp.verify(run=run_with_failure)
        self.assertTrue(any("mysqldump" in p and "127" in p for p in problems))


class EnsureAllTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.list_path = os.path.join(self.dir, "mysql-community.list")
        self.keyring_path = os.path.join(self.dir, "mysql-community.gpg")

    def test_a_fully_provisioned_host_makes_no_apt_dpkg_gpg_or_network_call(self):
        run = FakeRun(installed={"age", ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_all(run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path)
        # Only the three dpkg-query probes are allowed on an already-satisfied host.
        self.assertEqual({c[0] for c in run.calls}, {"dpkg-query"})
        self.assertEqual(fetch.urls, [])
        self.assertFalse(os.path.exists(self.list_path))

    def test_a_bare_host_installs_age_and_both_mysql_packages(self):
        run = FakeRun(installed=set())
        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
                ihp.LIBAIO1_POOL_URL: '<a href="libaio1_1.0-1_amd64.deb">x</a>'.encode(),
                ihp.LIBAIO1_POOL_URL + "libaio1_1.0-1_amd64.deb": b"DEB",
            }
        )
        ihp.ensure_all(run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path)
        installed_via_apt = {c[-1] for c in run.calls if c[0] == "apt-get" and c[1] == "install"}
        self.assertEqual(installed_via_apt, {"age", ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        self.assertTrue(os.path.exists(self.list_path))

    def test_needing_only_age_never_touches_the_mysql_apt_source_or_libaio1(self):
        run = FakeRun(installed={ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_all(run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path)
        self.assertFalse(os.path.exists(self.list_path))
        self.assertEqual(fetch.urls, [])
        installed_via_apt = {c[-1] for c in run.calls if c[0] == "apt-get" and c[1] == "install"}
        self.assertEqual(installed_via_apt, {"age"})

    def test_apt_get_update_runs_before_any_install_when_something_is_missing(self):
        run = FakeRun(installed=set())
        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
                ihp.LIBAIO1_POOL_URL: '<a href="libaio1_1.0-1_amd64.deb">x</a>'.encode(),
                ihp.LIBAIO1_POOL_URL + "libaio1_1.0-1_amd64.deb": b"DEB",
            }
        )
        ihp.ensure_all(run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path)
        apt_calls = [c for c in run.calls if c[0] == "apt-get"]
        self.assertEqual(apt_calls[0][1], "update")

    def test_an_apt_install_failure_raises_and_stops(self):
        run = FakeRun(installed=set(), apt_install_fail="age")
        fetch = FakeFetch(
            {
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
                "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
                ihp.LIBAIO1_POOL_URL: '<a href="libaio1_1.0-1_amd64.deb">x</a>'.encode(),
                ihp.LIBAIO1_POOL_URL + "libaio1_1.0-1_amd64.deb": b"DEB",
            }
        )
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_all(run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path)


if __name__ == "__main__":
    unittest.main()
