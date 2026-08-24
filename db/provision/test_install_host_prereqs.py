#!/usr/bin/env python3
"""Unit tests for install_host_prereqs.py.

Every external command and network fetch is faked -- no real apt, dpkg, gpg
or HTTP call -- so these assert the constraints found live during the first
db1 bootstrap (2026-08-23), plus three properties added after a follow-up
review of this exact script: `libaio1` is only ever `dpkg -i`'d when its
fetched bytes match a hash pinned in the module, the GPG keyring write is
atomic and self-healing from a corrupt or truncated file rather than merely
gated on existence, and the mysql-community apt pin is written even for an
already-converged host. Also still covered: bookworm (never trixie) is the
pinned release, both signing keys go into one keyring, mysqldump/mysqlbinlog
must report exactly 8.0.x, and a fully-satisfied host makes no apt-get,
dpkg, gpg or network call at all.
"""

import contextlib
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

import install_host_prereqs as ihp


@contextlib.contextmanager
def _patched_libaio1_sha256(deb_bytes: bytes):
    """Points the module's pinned hash at whatever fake bytes a test's
    FakeFetch will return, so the hash-verification path can be exercised
    without depending on the real pinned artifact's real content."""
    original = ihp.LIBAIO1_DEB_SHA256
    ihp.LIBAIO1_DEB_SHA256 = hashlib.sha256(deb_bytes).hexdigest()
    try:
        yield
    finally:
        ihp.LIBAIO1_DEB_SHA256 = original


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


MYSQL_GPG_PAGES = {
    "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"A",
    "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"B",
}


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
        self.keyring_path = os.path.join(self.dir, "mysql.gpg")

    def test_fetches_both_the_2025_and_2023_keys(self):
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
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

        fetch = FakeFetch({
            "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025": b"KEY-2025-",
            "https://repo.mysql.com/RPM-GPG-KEY-mysql-2023": b"KEY-2023-",
        })
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertEqual(len(calls), 1)
        argv, piped_input = calls[0]
        self.assertEqual(argv, ["gpg", "--dearmor"])
        self.assertEqual(piped_input, b"KEY-2025-KEY-2023-")

    def test_writes_the_dearmored_output_to_the_keyring_path(self):
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        run = FakeRun()
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        with open(self.keyring_path, "rb") as handle:
            self.assertEqual(handle.read(), b"KEYRING-BYTES")

    def test_first_write_reports_changed(self):
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        run = FakeRun()
        changed = ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertTrue(changed)

    def test_returns_false_and_does_not_rewrite_when_existing_content_already_matches(self):
        with open(self.keyring_path, "wb") as handle:
            handle.write(b"KEYRING-BYTES")  # matches FakeRun's default dearmor output
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        run = FakeRun()
        changed = ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertFalse(changed)
        with open(self.keyring_path, "rb") as handle:
            self.assertEqual(handle.read(), b"KEYRING-BYTES")

    def test_self_heals_a_corrupt_or_truncated_keyring(self):
        # The property existence-gating did not have: a run killed
        # mid-write previously left a file every later run treated as
        # already done. Re-deriving and comparing content on every call
        # means a mismatch -- corrupt or otherwise -- is repaired, not
        # permanent.
        with open(self.keyring_path, "wb") as handle:
            handle.write(b"TRUNCATED-GARBAGE")
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        run = FakeRun()
        changed = ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        self.assertTrue(changed)
        with open(self.keyring_path, "rb") as handle:
            self.assertEqual(handle.read(), b"KEYRING-BYTES")

    def test_write_is_atomic_no_temp_file_left_behind(self):
        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        run = FakeRun()
        ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)
        leftovers = [f for f in os.listdir(self.dir) if f.startswith(".install-host-prereqs-")]
        self.assertEqual(leftovers, [])

    def test_raises_when_dearmor_fails(self):
        def run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 2, stdout=b"", stderr=b"gpg: no valid data found")

        fetch = FakeFetch(dict(MYSQL_GPG_PAGES))
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_mysql_gpg_keyring(keyring_path=self.keyring_path, run=run, fetch=fetch)


class EnsureLibaio1Tests(unittest.TestCase):
    def test_no_op_when_already_installed(self):
        run = FakeRun(installed={ihp.LIBAIO1_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_libaio1(run=run, fetch=fetch)
        self.assertEqual(fetch.urls, [])
        # Only the presence check runs; no download, no dpkg -i.
        self.assertEqual(run.calls, [["dpkg-query", "-W", "-f=${Status}", ihp.LIBAIO1_PACKAGE]])

    def test_fetches_exactly_the_pinned_url(self):
        deb_bytes = b"PINNED-DEB-CONTENT"
        fetch = FakeFetch({ihp.LIBAIO1_DEB_URL: deb_bytes})
        run = FakeRun()
        with _patched_libaio1_sha256(deb_bytes):
            ihp.ensure_libaio1(run=run, fetch=fetch)
        self.assertEqual(fetch.urls, [ihp.LIBAIO1_DEB_URL])

    def test_installs_when_the_fetched_bytes_match_the_pinned_hash(self):
        deb_bytes = b"PINNED-DEB-CONTENT"
        fetch = FakeFetch({ihp.LIBAIO1_DEB_URL: deb_bytes})
        run = FakeRun()
        with _patched_libaio1_sha256(deb_bytes):
            ihp.ensure_libaio1(run=run, fetch=fetch)
        dpkg_i_calls = [c for c in run.calls if c[0] == "dpkg" and c[1] == "-i"]
        self.assertEqual(len(dpkg_i_calls), 1)
        self.assertTrue(dpkg_i_calls[0][2].endswith(".deb"))

    def test_raises_and_never_calls_dpkg_when_the_hash_does_not_match(self):
        # The exact supply-chain gap the pin closes: content that does not
        # match the pinned hash -- tampered, truncated, or simply the wrong
        # version -- must never reach `dpkg -i` as root.
        fetch = FakeFetch({ihp.LIBAIO1_DEB_URL: b"SOMETHING-THAT-IS-NOT-THE-PINNED-DEB"})
        run = FakeRun()
        with self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_libaio1(run=run, fetch=fetch)
        dpkg_i_calls = [c for c in run.calls if c[0] == "dpkg" and c[1] == "-i"]
        self.assertEqual(dpkg_i_calls, [])

    def test_raises_when_dpkg_install_fails_even_with_a_matching_hash(self):
        deb_bytes = b"PINNED-DEB-CONTENT"
        fetch = FakeFetch({ihp.LIBAIO1_DEB_URL: deb_bytes})
        run = FakeRun(dpkg_i_fail=True)
        with _patched_libaio1_sha256(deb_bytes), self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_libaio1(run=run, fetch=fetch)

    def test_no_temp_deb_file_left_behind_after_a_successful_install(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        previous_tempdir = tempfile.tempdir
        tempfile.tempdir = directory
        self.addCleanup(setattr, tempfile, "tempdir", previous_tempdir)

        deb_bytes = b"PINNED-DEB-CONTENT"
        fetch = FakeFetch({ihp.LIBAIO1_DEB_URL: deb_bytes})
        run = FakeRun()
        with _patched_libaio1_sha256(deb_bytes):
            ihp.ensure_libaio1(run=run, fetch=fetch)
        self.assertEqual(os.listdir(directory), [])


class MysqlAptPinTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.pin_path = os.path.join(self.dir, "mysql-community-8.0")

    def test_names_all_five_mysql_community_packages(self):
        ihp.ensure_mysql_apt_pin(pin_path=self.pin_path)
        with open(self.pin_path, encoding="utf-8") as handle:
            content = handle.read()
        self.assertEqual(len(ihp.MYSQL_PIN_PACKAGES), 5)
        for package in ihp.MYSQL_PIN_PACKAGES:
            self.assertIn(package, content)

    def test_pins_to_the_8_0_line_with_a_forcing_priority(self):
        ihp.ensure_mysql_apt_pin(pin_path=self.pin_path)
        with open(self.pin_path, encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("Pin: version 8.0.*", content)
        self.assertIn("Pin-Priority: 1001", content)

    def test_first_write_reports_changed(self):
        self.assertTrue(ihp.ensure_mysql_apt_pin(pin_path=self.pin_path))

    def test_a_second_call_with_identical_content_reports_unchanged(self):
        ihp.ensure_mysql_apt_pin(pin_path=self.pin_path)
        self.assertFalse(ihp.ensure_mysql_apt_pin(pin_path=self.pin_path))

    def test_write_is_atomic_no_temp_file_left_behind(self):
        ihp.ensure_mysql_apt_pin(pin_path=self.pin_path)
        leftovers = [f for f in os.listdir(self.dir) if f.startswith(".install-host-prereqs-")]
        self.assertEqual(leftovers, [])


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
        self.assertTrue(any("mysqldump" in p and "8.4.3" in p and "8.0.x" in p for p in problems))

    def test_mysqlbinlog_from_a_newer_client_is_still_flagged_even_though_it_would_work(self):
        # Proven live that 8.4's mysqlbinlog reads an 8.0 server's binlogs
        # fine -- but this script promises an exact-matched toolchain, and a
        # silently-drifted mysqlbinlog is still worth surfacing. Also
        # confirms the message names the binary, its reported version and
        # the expected one, so the failure is actionable without reading
        # this script's source.
        run = FakeRun(
            installed={"age"},
            version_output={
                "mysqlbinlog": "mysqlbinlog  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)",
            },
        )
        problems = ihp.verify(run=run)
        self.assertTrue(any("mysqlbinlog" in p and "8.4.3" in p and "8.0.x" in p for p in problems))

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
        self.keyring_path = os.path.join(self.dir, "mysql.gpg")
        self.pin_path = os.path.join(self.dir, "mysql-community-8.0")

    def test_a_fully_provisioned_host_makes_no_apt_dpkg_gpg_or_network_call(self):
        run = FakeRun(installed={"age", ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_all(
            run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path, pin_path=self.pin_path
        )
        # Only the three dpkg-query probes are allowed on an already-satisfied host.
        self.assertEqual({c[0] for c in run.calls}, {"dpkg-query"})
        self.assertEqual(fetch.urls, [])
        self.assertFalse(os.path.exists(self.list_path))

    def test_the_apt_pin_is_still_written_on_an_already_converged_host(self):
        # The host most exposed to unattended-upgrades drift is exactly the
        # one that already has every package -- the pin must not be gated
        # behind "something needs installing".
        run = FakeRun(installed={"age", ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_all(
            run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path, pin_path=self.pin_path
        )
        self.assertTrue(os.path.exists(self.pin_path))

    def test_a_bare_host_installs_age_and_both_mysql_packages(self):
        run = FakeRun(installed=set())
        deb_bytes = b"DEB"
        fetch = FakeFetch({**MYSQL_GPG_PAGES, ihp.LIBAIO1_DEB_URL: deb_bytes})
        with _patched_libaio1_sha256(deb_bytes):
            ihp.ensure_all(
                run=run,
                fetch=fetch,
                list_path=self.list_path,
                keyring_path=self.keyring_path,
                pin_path=self.pin_path,
            )
        installed_via_apt = {c[-1] for c in run.calls if c[0] == "apt-get" and c[1] == "install"}
        self.assertEqual(installed_via_apt, {"age", ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        self.assertTrue(os.path.exists(self.list_path))
        self.assertTrue(os.path.exists(self.pin_path))

    def test_needing_only_age_never_touches_the_mysql_apt_source_or_libaio1(self):
        run = FakeRun(installed={ihp.MYSQL_CLIENT_PACKAGE, ihp.MYSQL_SERVER_CORE_PACKAGE})
        fetch = FakeFetch()
        ihp.ensure_all(
            run=run, fetch=fetch, list_path=self.list_path, keyring_path=self.keyring_path, pin_path=self.pin_path
        )
        self.assertFalse(os.path.exists(self.list_path))
        self.assertEqual(fetch.urls, [])
        installed_via_apt = {c[-1] for c in run.calls if c[0] == "apt-get" and c[1] == "install"}
        self.assertEqual(installed_via_apt, {"age"})

    def test_apt_get_update_runs_before_any_install_when_something_is_missing(self):
        run = FakeRun(installed=set())
        deb_bytes = b"DEB"
        fetch = FakeFetch({**MYSQL_GPG_PAGES, ihp.LIBAIO1_DEB_URL: deb_bytes})
        with _patched_libaio1_sha256(deb_bytes):
            ihp.ensure_all(
                run=run,
                fetch=fetch,
                list_path=self.list_path,
                keyring_path=self.keyring_path,
                pin_path=self.pin_path,
            )
        apt_calls = [c for c in run.calls if c[0] == "apt-get"]
        self.assertEqual(apt_calls[0][1], "update")

    def test_an_apt_install_failure_raises_and_stops(self):
        run = FakeRun(installed=set(), apt_install_fail="age")
        deb_bytes = b"DEB"
        fetch = FakeFetch({**MYSQL_GPG_PAGES, ihp.LIBAIO1_DEB_URL: deb_bytes})
        with _patched_libaio1_sha256(deb_bytes), self.assertRaises(ihp.HostPrereqError):
            ihp.ensure_all(
                run=run,
                fetch=fetch,
                list_path=self.list_path,
                keyring_path=self.keyring_path,
                pin_path=self.pin_path,
            )


if __name__ == "__main__":
    unittest.main()
