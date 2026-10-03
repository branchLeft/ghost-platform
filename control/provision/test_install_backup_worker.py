#!/usr/bin/env python3
"""Unit tests for install_backup_worker.py.

See test_install_backup_worker.md#module-overview.
"""

from __future__ import annotations

import configparser
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import install_backup_worker as ibw

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
SCRIPTS = REPO_ROOT / "infra" / "provisioning" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import backup_worker as bw  # noqa: E402

SECRET_VALUE = "s3cr3t-value-that-must-never-be-printed"


def _unit(name: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str
    parser.read_string((HERE / name).read_text())
    return parser


def _complete_env(ca_path: str) -> str:
    lines = [f"{name}={SECRET_VALUE}" for name in ibw.REQUIRED_ENV_NAMES if name != "BACKUP_WORKER_MYSQL_SSL_CA"]
    lines.append(f"BACKUP_WORKER_MYSQL_SSL_CA={ca_path}")
    return "# comment\n\n" + "\n".join(lines) + "\n"


class FakeRun:
    def __init__(self, *, mysqldump_version: str = "mysqldump  Ver 8.0.43 for Linux on x86_64", user_exists: bool = True):
        self.calls: list[list[str]] = []
        self.mysqldump_version = mysqldump_version
        self.user_exists = user_exists

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        if argv[:2] == ["id", "-u"]:
            return subprocess.CompletedProcess(argv, 0 if self.user_exists else 1, "", "")
        if argv[:2] == ["mysqldump", "--version"]:
            return subprocess.CompletedProcess(argv, 0, self.mysqldump_version, "")
        return subprocess.CompletedProcess(argv, 0, "", "")


def _which_all(tool: str) -> str | None:
    return f"/usr/bin/{tool}"


class Sandbox:
    """A temporary root holding a releases dir, a unit dir and /etc files."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name).resolve()
        self.root = root
        self.paths = ibw.Paths(
            releases_dir=root / "releases",
            current_link=root / "current",
            unit_dir=root / "units",
            env_file=root / "etc" / "backup-worker.env",
            tenants_file=root / "etc" / "backup-worker-tenants",
        )
        for directory in (self.paths.releases_dir, self.paths.unit_dir, root / "etc"):
            directory.mkdir(parents=True)
        self.ca = root / "etc" / "ca.pem"
        self.ca.write_text("CERT\n")
        os.chmod(self.ca, 0o644)

    def release(self, name: str = "r1") -> pathlib.Path:
        release = self.paths.releases_dir / name
        for rel in ibw.REQUIRED_RELEASE_FILES:
            target = release / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            source = REPO_ROOT / rel
            target.write_bytes(source.read_bytes())
            os.chmod(target, 0o644)
        for directory, subdirs, _ in os.walk(release):
            for sub in subdirs:
                os.chmod(pathlib.Path(directory) / sub, 0o755)
        os.chmod(release, 0o755)
        return release

    def write_config(self, *, env: str | None = None, env_mode: int = 0o600, tenants: str = "blog\n", tenants_mode: int = 0o644) -> None:
        self.paths.env_file.write_text(env if env is not None else _complete_env(str(self.ca)))
        os.chmod(self.paths.env_file, env_mode)
        self.paths.tenants_file.write_text(tenants)
        os.chmod(self.paths.tenants_file, tenants_mode)

    def close(self) -> None:
        self._tmp.cleanup()


class SandboxCase(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.uid = os.getuid()


class EnvNamesMatchTheCodeThatReadsThem(unittest.TestCase):
    def test_required_names_are_exactly_what_the_loop_and_its_required_copy_read(self) -> None:
        loop_source = (SCRIPTS / "nightly_dump_loop.py").read_text()
        from_loop = set(re.findall(r'_require_env\("([A-Z0-9_]+)"\)', loop_source))
        from_copies = {
            f"BACKUP_WORKER_COPY_{copy.upper()}_{suffix}"
            for copy in bw.REQUIRED_COPY_NAMES
            for suffix in bw._COPY_CREDENTIAL_VAR_SUFFIXES
        }
        self.assertTrue(from_loop, "found no _require_env call in nightly_dump_loop.py")
        self.assertEqual(set(ibw.REQUIRED_ENV_NAMES), from_loop | from_copies)

    def test_the_example_env_file_names_every_required_name_and_nothing_else(self) -> None:
        names = {
            line.split("=", 1)[0]
            for line in (HERE / "backup-worker.env.example").read_text().splitlines()
            if line and not line.startswith("#")
        }
        self.assertEqual(names, set(ibw.REQUIRED_ENV_NAMES))


class UnitsMatchTheInstallLayout(unittest.TestCase):
    def setUp(self) -> None:
        self.service = _unit(ibw.SERVICE_UNIT)["Service"]
        self.paths = ibw.Paths()

    def _environment(self) -> dict[str, str]:
        raw = (HERE / ibw.SERVICE_UNIT).read_text()
        return dict(re.findall(r"^Environment=([A-Z_]+)=(\S+)$", raw, re.M))

    def test_execstart_runs_the_loop_from_the_current_release_with_the_tenants_file(self) -> None:
        argv = self.service["ExecStart"].split()
        self.assertEqual(argv[0], "/usr/bin/python3")
        self.assertEqual(
            argv[1], str(self.paths.current_link / "infra/provisioning/scripts/nightly_dump_loop.py")
        )
        self.assertEqual(argv[2:], ["--tenants-file", str(self.paths.tenants_file)])

    def test_environment_file_and_service_user_match_the_installer(self) -> None:
        self.assertEqual(self.service["EnvironmentFile"], str(self.paths.env_file))
        self.assertEqual(self.service["User"], ibw.SERVICE_USER)
        self.assertEqual(self.service["Group"], ibw.SERVICE_USER)

    def test_metrics_dir_is_the_state_directory_and_the_workers_own_default(self) -> None:
        metrics_dir = self._environment()["BACKUP_WORKER_METRICS_DIR"]
        self.assertEqual(metrics_dir, bw.DEFAULT_BACKUP_AGE_METRICS_DIR)
        self.assertEqual(metrics_dir, "/var/lib/" + self.service["StateDirectory"])
        self.assertEqual(self.service["StateDirectoryMode"], "0755")

    def test_run_lock_lives_in_the_runtime_directory(self) -> None:
        lock = pathlib.PurePosixPath(self._environment()["NIGHTLY_DUMP_LOOP_RUN_LOCK_PATH"])
        self.assertEqual(str(lock.parent), "/run/" + self.service["RuntimeDirectory"])

    def test_every_required_release_file_exists_in_this_repository(self) -> None:
        for rel in ibw.REQUIRED_RELEASE_FILES:
            self.assertTrue((REPO_ROOT / rel).is_file(), rel)

    def test_every_run_is_preceded_by_the_tenants_preflight(self) -> None:
        self.assertEqual(
            self.service["ExecStartPre"].split(),
            ["/usr/bin/python3", str(self.paths.current_link / "control/provision/install_backup_worker.py"), "--preflight"],
        )

    def test_hardening_is_pinned(self) -> None:
        self.assertEqual(self.service["ProtectSystem"], "strict")
        self.assertEqual(self.service["CapabilityBoundingSet"], "")
        self.assertEqual(self.service["NoNewPrivileges"], "yes")
        self.assertEqual(self.service["PrivateTmp"], "yes")
        self.assertEqual(self.service["MemoryMax"], "1G")
        raw = (HERE / ibw.SERVICE_UNIT).read_text()
        self.assertEqual(len(re.findall(r"^CapabilityBoundingSet=", raw, re.M)), 1)
        self.assertEqual(len(re.findall(r"^ProtectSystem=", raw, re.M)), 1)

    def test_timer_is_nightly_persistent_and_installable(self) -> None:
        timer = _unit(ibw.TIMER_UNIT)
        self.assertRegex(timer["Timer"]["OnCalendar"], r"^\*-\*-\* \d\d:\d\d:\d\d$")
        self.assertEqual(timer["Timer"]["Persistent"], "true")
        self.assertEqual(timer["Install"]["WantedBy"], "timers.target")


class CheckRelease(SandboxCase):
    def test_accepts_a_complete_release_owned_by_the_owner(self) -> None:
        ibw.check_release(self.box.release(), self.box.paths, owner_uid=self.uid)

    def test_refuses_a_directory_outside_the_releases_dir(self) -> None:
        with self.assertRaisesRegex(ibw.InstallError, "is not a release under"):
            ibw.check_release(REPO_ROOT, self.box.paths, owner_uid=self.uid)

    def test_refuses_a_release_missing_a_file_the_loop_loads(self) -> None:
        release = self.box.release()
        (release / "db/provision/objectstorage.py").unlink()
        with self.assertRaisesRegex(ibw.InstallError, "missing db/provision/objectstorage.py"):
            ibw.check_release(release, self.box.paths, owner_uid=self.uid)

    def test_refuses_a_group_writable_file(self) -> None:
        release = self.box.release()
        os.chmod(release / "infra/provisioning/scripts/backup_worker.py", 0o664)
        with self.assertRaisesRegex(ibw.InstallError, "backup_worker.py is writable"):
            ibw.check_release(release, self.box.paths, owner_uid=self.uid)

    def test_refuses_a_file_owned_by_anyone_else(self) -> None:
        with self.assertRaisesRegex(ibw.InstallError, "is writable by someone other than uid"):
            ibw.check_release(self.box.release(), self.box.paths, owner_uid=self.uid + 1)


class InstallUnitsAndCurrent(SandboxCase):
    def test_installs_both_units_then_is_a_no_op(self) -> None:
        release = self.box.release()
        self.assertTrue(ibw.install_units(release, self.box.paths.unit_dir))
        for name in ibw.UNIT_FILES:
            installed = self.box.paths.unit_dir / name
            self.assertEqual(installed.read_bytes(), (HERE / name).read_bytes())
            self.assertEqual(installed.stat().st_mode & 0o777, 0o644)
        self.assertFalse(ibw.install_units(release, self.box.paths.unit_dir))

    def test_replaces_a_unit_whose_bytes_drifted(self) -> None:
        release = self.box.release()
        ibw.install_units(release, self.box.paths.unit_dir)
        (self.box.paths.unit_dir / ibw.TIMER_UNIT).write_text("drifted\n")
        self.assertTrue(ibw.install_units(release, self.box.paths.unit_dir))
        self.assertEqual((self.box.paths.unit_dir / ibw.TIMER_UNIT).read_bytes(), (HERE / ibw.TIMER_UNIT).read_bytes())

    def test_current_is_created_then_left_then_repointed(self) -> None:
        first, second = self.box.release("r1"), self.box.release("r2")
        link = self.box.paths.current_link
        self.assertTrue(ibw.point_current_at(first, link))
        self.assertFalse(ibw.point_current_at(first, link))
        self.assertTrue(ibw.point_current_at(second, link))
        self.assertEqual(pathlib.Path(os.readlink(link)), second)

    def test_current_refuses_to_replace_a_real_directory(self) -> None:
        self.box.paths.current_link.mkdir()
        with self.assertRaisesRegex(ibw.InstallError, "is not a symlink"):
            ibw.point_current_at(self.box.release(), self.box.paths.current_link)


class ServiceUser(unittest.TestCase):
    def test_creates_the_account_only_when_absent(self) -> None:
        run = FakeRun(user_exists=False)
        self.assertTrue(ibw.ensure_service_user(run))
        self.assertIn("useradd", run.calls[-1])
        self.assertEqual(run.calls[-1][-1], ibw.SERVICE_USER)
        run = FakeRun(user_exists=True)
        self.assertFalse(ibw.ensure_service_user(run))
        self.assertFalse(any("useradd" in call for call in run.calls))


class EnvFile(SandboxCase):
    def test_a_complete_0600_file_has_no_problem(self) -> None:
        self.box.write_config()
        problems, extra = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
        self.assertEqual(problems, [])
        self.assertEqual(extra, {"ca": str(self.box.ca)})

    def test_missing_file(self) -> None:
        problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
        self.assertEqual(problems, [f"{self.box.paths.env_file} does not exist"])

    def test_names_each_missing_or_empty_key_and_never_prints_a_value(self) -> None:
        env = _complete_env(str(self.box.ca))
        env = env.replace(f"DB_DUMP_MYSQL_PWD={SECRET_VALUE}\n", "DB_DUMP_MYSQL_PWD=\n")
        env = env.replace(f"AGE_RECIPIENT_PUBLIC_KEY={SECRET_VALUE}\n", "")
        self.box.write_config(env=env)
        problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
        self.assertEqual(
            sorted(problems),
            sorted(
                f"{self.box.paths.env_file} does not set {name}"
                for name in ("DB_DUMP_MYSQL_PWD", "AGE_RECIPIENT_PUBLIC_KEY")
            ),
        )
        self.assertNotIn(SECRET_VALUE, "\n".join(problems))

    def test_group_or_world_readable_credentials_are_refused(self) -> None:
        for mode in (0o640, 0o604):
            self.box.write_config(env_mode=mode)
            problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
            self.assertIn(f"{self.box.paths.env_file} must be mode 0600 -- it holds credentials", problems)

    def test_wrong_owner_is_refused(self) -> None:
        self.box.write_config()
        problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid + 1)
        self.assertIn(f"{self.box.paths.env_file} must be owned by uid {self.uid + 1}", problems)

    def test_a_symlinked_env_file_is_refused(self) -> None:
        real = self.box.root / "elsewhere.env"
        real.write_text(_complete_env(str(self.box.ca)))
        os.chmod(real, 0o600)
        self.box.paths.env_file.symlink_to(real)
        problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
        self.assertEqual(len(problems), 1)
        self.assertIn("cannot be read safely", problems[0])


class CaFile(SandboxCase):
    def test_world_readable_regular_file_is_accepted(self) -> None:
        self.assertEqual(ibw.ca_problems(str(self.box.ca)), [])

    def test_unreadable_missing_or_relative_ca_is_refused(self) -> None:
        os.chmod(self.box.ca, 0o600)
        self.assertEqual(len(ibw.ca_problems(str(self.box.ca))), 1)
        self.assertEqual(len(ibw.ca_problems(str(self.box.root / "nope.pem"))), 1)
        self.assertIn("absolute path", ibw.ca_problems("ca.pem")[0])


class TenantsFile(SandboxCase):
    def _problems(self, **kwargs) -> list[str]:
        self.box.write_config(**kwargs)
        return ibw.tenants_file_problems(self.box.paths.tenants_file, owner_uid=self.uid, group_gid=None)

    def test_a_root_owned_readable_file_naming_a_tenant_is_accepted(self) -> None:
        self.assertEqual(self._problems(tenants="# tenants\nblog\n"), [])

    def test_group_readable_via_the_service_group_is_accepted(self) -> None:
        self.box.write_config(tenants_mode=0o640)
        gid = self.box.paths.tenants_file.stat().st_gid
        self.assertEqual(
            ibw.tenants_file_problems(self.box.paths.tenants_file, owner_uid=self.uid, group_gid=gid), []
        )

    def test_writable_by_group_or_others_is_refused(self) -> None:
        for mode in (0o664, 0o646):
            self.assertIn(
                f"{self.box.paths.tenants_file} must not be writable by group or others",
                self._problems(tenants_mode=mode),
            )

    def test_unreadable_by_the_service_account_is_refused(self) -> None:
        problems = self._problems(tenants_mode=0o600)
        self.assertTrue(any("must be readable by the backup-worker group" in p for p in problems), problems)

    def test_more_than_one_tenant_is_refused_while_one_recipient_covers_them_all(self) -> None:
        problems = self._problems(tenants="blog\nshop\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("names 2 tenants", problems[0])
        self.assertEqual(self._problems(tenants="blog\nblog\n"), [])

    def test_naming_no_tenant_is_refused(self) -> None:
        self.assertIn(f"{self.box.paths.tenants_file} names no tenant", self._problems(tenants="# none\n\n"))


class Tools(unittest.TestCase):
    def test_both_tools_present_with_the_80_client_is_accepted(self) -> None:
        self.assertEqual(ibw.tool_problems(FakeRun(), _which_all), [])

    def test_a_missing_tool_is_named(self) -> None:
        problems = ibw.tool_problems(FakeRun(), lambda tool: None if tool == "age" else f"/usr/bin/{tool}")
        self.assertEqual(problems, ["age is not installed"])

    def test_a_newer_client_line_is_refused(self) -> None:
        for version in ("mysqldump  Ver 8.4.6 for Linux", "mysqldump from 11.8.3-MariaDB", ""):
            problems = ibw.tool_problems(FakeRun(mysqldump_version=version), _which_all)
            self.assertEqual(len(problems), 1, version)
            self.assertIn("not the 8.0 client line", problems[0])


class Install(SandboxCase):
    def _install(self, run: FakeRun, which=_which_all) -> list[str]:
        return ibw.install(
            self.box.release(), self.box.paths, run, owner_uid=self.uid, group_gid=lambda: None, which=which
        )

    def test_enables_the_timer_when_everything_is_in_place(self) -> None:
        self.box.write_config()
        run = FakeRun()
        self.assertEqual(self._install(run), [])
        self.assertIn(["systemctl", "daemon-reload"], run.calls)
        self.assertEqual(run.calls[-1], ["systemctl", "enable", "--now", ibw.TIMER_UNIT])
        self.assertTrue(self.box.paths.current_link.is_symlink())

    def test_installs_everything_but_leaves_the_timer_off_while_anything_is_missing(self) -> None:
        run = FakeRun()
        problems = self._install(run)
        self.assertTrue(problems)
        self.assertFalse(any(call[:2] == ["systemctl", "enable"] for call in run.calls))
        self.assertEqual(run.calls[-1], ["systemctl", "disable", "--now", ibw.TIMER_UNIT])

    def test_a_second_tenant_added_after_enable_turns_the_timer_off_on_reinstall(self) -> None:
        self.box.write_config()
        self.assertEqual(self._install(FakeRun()), [])
        self.box.write_config(tenants="blog\nshop\n")
        run = FakeRun()
        problems = self._install(run)
        self.assertEqual(len(problems), 1)
        self.assertIn("names 2 tenants", problems[0])
        self.assertIn(["systemctl", "disable", "--now", ibw.TIMER_UNIT], run.calls)
        self.assertFalse(any(call[:2] == ["systemctl", "enable"] for call in run.calls))
        self.assertTrue((self.box.paths.unit_dir / ibw.SERVICE_UNIT).is_file())
        self.assertTrue(self.box.paths.current_link.is_symlink())

    def test_a_missing_tool_alone_keeps_the_timer_off(self) -> None:
        self.box.write_config()
        run = FakeRun()
        problems = self._install(run, which=lambda tool: None if tool == "mysqldump" else f"/usr/bin/{tool}")
        self.assertEqual(problems, ["mysqldump is not installed"])
        self.assertFalse(any(call[:2] == ["systemctl", "enable"] for call in run.calls))

    def test_a_bad_release_changes_nothing(self) -> None:
        release = self.box.release()
        os.chmod(release / "db/provision/naming.py", 0o666)
        run = FakeRun()
        with self.assertRaises(ibw.InstallError):
            ibw.install(release, self.box.paths, run, owner_uid=self.uid, group_gid=lambda: None, which=_which_all)
        self.assertEqual(run.calls, [])
        self.assertFalse(self.box.paths.current_link.exists())
        self.assertEqual(list(self.box.paths.unit_dir.iterdir()), [])


class Main(unittest.TestCase):
    def test_refuses_to_install_unless_root(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("running as root")
        run = FakeRun()
        self.assertEqual(ibw.main([], run=run), 1)
        self.assertEqual(run.calls, [])

    def test_release_root_is_two_levels_above_this_directory(self) -> None:
        self.assertEqual(ibw.release_root_of(HERE / "install_backup_worker.py"), REPO_ROOT)


class MainModes(SandboxCase):
    def test_check_reports_what_is_missing_changes_nothing_and_exits_2(self) -> None:
        run = FakeRun()
        self.assertEqual(ibw.main(["--check"], run=run, paths=self.box.paths), 2)
        self.assertFalse(any(call[0] in ("systemctl", "useradd") for call in run.calls))
        self.assertFalse(self.box.paths.current_link.exists())

    def test_install_path_reports_an_install_error_as_exit_1(self) -> None:
        run = FakeRun()
        with mock.patch.object(ibw.os, "geteuid", return_value=0):
            # This checkout is not under the sandbox's releases dir.
            self.assertEqual(ibw.main([], run=run, paths=self.box.paths), 1)
        self.assertEqual(run.calls, [])

    def test_install_path_exits_2_while_inputs_are_missing_and_0_once_ready(self) -> None:
        for problems, expected in ((["x is missing"], 2), ([], 0)):
            with mock.patch.object(ibw.os, "geteuid", return_value=0), mock.patch.object(
                ibw, "install", return_value=problems
            ):
                self.assertEqual(ibw.main([], run=FakeRun(), paths=self.box.paths), expected)


class Preflight(SandboxCase):
    def _preflight(self, tenants: str) -> list[str]:
        self.box.write_config(tenants=tenants)
        return ibw.preflight_problems(self.box.paths, owner_uid=self.uid)

    def test_one_tenant_runs(self) -> None:
        self.assertEqual(self._preflight("blog\n"), [])

    def test_a_second_tenant_refuses_the_run(self) -> None:
        problems = self._preflight("blog\nshop\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("names 2 tenants", problems[0])

    def test_a_missing_or_empty_tenants_file_refuses_the_run(self) -> None:
        self.assertIn("names no tenant", self._preflight("# none\n")[0])
        self.box.paths.tenants_file.unlink()
        self.assertIn("does not exist", ibw.preflight_problems(self.box.paths, owner_uid=self.uid)[0])

    def test_main_preflight_exits_1_on_any_problem_and_0_otherwise(self) -> None:
        for problems, expected in ((["x"], 1), ([], 0)):
            with mock.patch.object(ibw, "preflight_problems", return_value=problems):
                run = FakeRun()
                self.assertEqual(ibw.main(["--preflight"], run=run, paths=self.box.paths), expected)
                self.assertEqual(run.calls, [])


class ServiceGroupLookup(unittest.TestCase):
    def test_prefers_the_group_then_the_users_primary_group_then_none(self) -> None:
        with mock.patch.object(ibw.grp, "getgrnam", return_value=mock.Mock(gr_gid=901)):
            self.assertEqual(ibw._service_gid(), 901)
        with mock.patch.object(ibw.grp, "getgrnam", side_effect=KeyError), mock.patch.object(
            ibw.pwd, "getpwnam", return_value=mock.Mock(pw_gid=902)
        ):
            self.assertEqual(ibw._service_gid(), 902)
        with mock.patch.object(ibw.grp, "getgrnam", side_effect=KeyError), mock.patch.object(
            ibw.pwd, "getpwnam", side_effect=KeyError
        ):
            self.assertIsNone(ibw._service_gid())


class NonRegularConfig(SandboxCase):
    def test_a_directory_in_place_of_either_config_file_is_refused(self) -> None:
        self.box.paths.env_file.mkdir()
        self.box.paths.tenants_file.mkdir()
        problems, _ = ibw.env_file_problems(self.box.paths.env_file, owner_uid=self.uid)
        self.assertIn("cannot be read safely", problems[0])
        problems = ibw.tenants_file_problems(self.box.paths.tenants_file, owner_uid=self.uid, group_gid=None)
        self.assertIn("cannot be read safely", problems[0])

    def test_tenants_file_missing_or_wrongly_owned(self) -> None:
        self.assertEqual(
            ibw.tenants_file_problems(self.box.paths.tenants_file, owner_uid=self.uid, group_gid=None),
            [f"{self.box.paths.tenants_file} does not exist"],
        )
        self.box.write_config()
        problems = ibw.tenants_file_problems(self.box.paths.tenants_file, owner_uid=self.uid + 1, group_gid=None)
        self.assertIn(f"{self.box.paths.tenants_file} must be owned by uid {self.uid + 1}", problems)

    def test_readiness_combines_the_ca_check(self) -> None:
        self.box.write_config()
        os.chmod(self.box.ca, 0o600)
        problems = ibw.readiness_problems(
            self.box.paths, FakeRun(), group_gid=None, owner_uid=self.uid, which=_which_all
        )
        self.assertEqual(problems, [f"the database CA {self.box.ca} must be a world-readable regular file"])


if __name__ == "__main__":
    unittest.main()
