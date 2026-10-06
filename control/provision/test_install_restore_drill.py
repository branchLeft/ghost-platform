#!/usr/bin/env python3
"""Unit tests for install_restore_drill.py and the drill's two unit files.
Reuses test_install_backup_worker's sandbox: a temporary root with a
releases dir, a unit dir and /etc files, owned by the test's own uid."""

from __future__ import annotations

import io
import contextlib
import os
import pathlib
import subprocess
import unittest
from unittest import mock

import install_backup_worker as ibw
import install_restore_drill as ird
from test_install_backup_worker import REPO_ROOT, FakeRun, Sandbox, _unit

DIGEST = "@sha256:" + "b" * 64
SECRET = "drill-secret-never-printed"
GOOD_ENV = "\n".join([
    "# comment",
    "BACKUP_DRILL_COPY_PRIMARY_BUCKET=bucket",
    "BACKUP_DRILL_COPY_PRIMARY_ENDPOINT=fsn1.example",
    "BACKUP_DRILL_COPY_PRIMARY_REGION=fsn1",
    "BACKUP_DRILL_COPY_PRIMARY_ACCESS_KEY_ID=keyid1234",
    f"BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY={SECRET}",
    f"BACKUP_DRILL_RECOVERY_IMAGE=ghcr.io/branchleft/db-recovery{DIGEST}",
    f"BACKUP_DRILL_MYSQL_IMAGE=mysql:8.0{DIGEST}",
    f"BACKUP_DRILL_GHOST_IMAGE=ghcr.io/branchleft/ghost-tenant{DIGEST}",
    f"BACKUP_DRILL_SIDECAR_IMAGE=ghcr.io/branchleft/drain-sidecar{DIGEST}",
]) + "\n"
AGE_KEY = "# public key: age1xyz\nAGE-SECRET-KEY-1ABCDEF\n"


def _which(tool):
    return f"/usr/bin/{tool}"


class DrillSandbox(Sandbox):
    def __init__(self) -> None:
        super().__init__()
        self.env_file = self.root / "etc" / "restore-drill.env"
        self.ids = self.root / "etc" / "identities"

    def release(self, name: str = "r1") -> pathlib.Path:
        release = super().release(name)
        for rel in ird.REQUIRED_RELEASE_FILES:
            target = release / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(target.parent, 0o755)
            target.write_bytes((REPO_ROOT / rel).read_bytes())
            os.chmod(target, 0o644)
        return release

    def write_drill(self, *, env: str = GOOD_ENV, env_mode: int = 0o600, key: str | None = AGE_KEY,
                    key_mode: int = 0o600, ids_mode: int = 0o700) -> None:
        self.write_config()
        self.env_file.write_text(env)
        os.chmod(self.env_file, env_mode)
        self.ids.mkdir(exist_ok=True)
        os.chmod(self.ids, ids_mode)
        if key is not None:
            (self.ids / "blog.key").write_text(key)
            os.chmod(self.ids / "blog.key", key_mode)


class Case(unittest.TestCase):
    def setUp(self) -> None:
        self.box = DrillSandbox()
        self.addCleanup(self.box.close)
        self.uid = os.getuid()

    def problems(self, run=None, which=_which):
        return ird.readiness_problems(self.box.paths, run or FakeRun(), env_file=self.box.env_file,
                                      identity_dir=self.box.ids, owner_uid=self.uid, which=which)


class ReadinessTests(Case):
    def test_everything_in_place(self):
        self.box.write_drill()
        self.assertEqual(self.problems(), [])

    def test_missing_env_and_identity_dir(self):
        self.box.write_config()
        problems = self.problems()
        self.assertTrue(any("restore-drill.env does not exist" in p for p in problems))
        self.assertTrue(any("identities does not exist" in p for p in problems))

    def test_env_must_be_root_only(self):
        self.box.write_drill(env_mode=0o640)
        self.assertTrue(any("mode 0600" in p for p in self.problems()))

    def test_env_wrong_owner(self):
        self.box.write_drill()
        problems = ird.env_problems(self.box.env_file, owner_uid=self.uid + 1)
        self.assertTrue(any("must be owned" in p for p in problems))

    def test_env_symlink_refused(self):
        self.box.write_drill()
        link = self.box.root / "etc" / "link.env"
        link.symlink_to(self.box.env_file)
        self.assertTrue(any("cannot be read safely" in p for p in ird.env_problems(link, owner_uid=self.uid)))

    def test_tagged_image_refused_without_printing_secrets(self):
        env = GOOD_ENV.replace(f"ghost-tenant{DIGEST}", "ghost-tenant:latest")
        self.box.write_drill(env=env)
        problems = self.problems()
        self.assertTrue(any("BACKUP_DRILL_GHOST_IMAGE" in p for p in problems))
        self.assertNotIn(SECRET, "\n".join(problems))

    def test_missing_copy_credential_named_not_valued(self):
        env = GOOD_ENV.replace(f"BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY={SECRET}\n", "")
        self.box.write_drill(env=env)
        problems = self.problems()
        self.assertTrue(any("PRIMARY_SECRET_ACCESS_KEY" in p for p in problems))
        self.assertNotIn(SECRET, "\n".join(problems))

    def test_secret_quoted_back_is_redacted(self):
        message = ird._without_secrets(f"bad {SECRET}", {"BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY": SECRET})
        self.assertEqual(message, "bad <value>")

    def test_identity_dir_and_key_permissions(self):
        self.box.write_drill(ids_mode=0o755, key_mode=0o644)
        problems = self.problems()
        self.assertTrue(any("mode 0700" in p for p in problems))
        self.assertTrue(any("mode 0600" in p for p in problems))

    def test_missing_and_malformed_identities(self):
        self.box.write_drill(key=None)
        self.assertTrue(any("no identity for blog" in p for p in self.problems()))
        (self.box.ids / "blog.key").write_text("not a key\n")
        os.chmod(self.box.ids / "blog.key", 0o600)
        self.assertTrue(any("holds no age identity" in p for p in self.problems()))

    def test_identity_path_not_a_directory_or_key_unreadable(self):
        self.box.write_config()
        self.box.ids.write_text("file")
        self.assertIn(f"{self.box.ids} must be a directory", self.problems())
        self.box.ids.unlink()
        self.box.write_drill(key=None)
        (self.box.ids / "blog.key").symlink_to(self.box.env_file)
        self.assertTrue(any("cannot be read safely" in p for p in self.problems()))

    def test_no_tenants(self):
        self.box.write_drill()
        self.box.paths.tenants_file.write_text("# none\n")
        self.assertTrue(any("names no tenant" in p for p in self.problems()))
        self.box.paths.tenants_file.unlink()
        self.assertTrue(any("cannot be read" in p for p in self.problems()))

    def test_docker_missing_or_down(self):
        self.box.write_drill()
        self.assertIn("docker is not installed", self.problems(which=lambda tool: None))

        class DaemonDown(FakeRun):
            def __call__(self, argv, **kwargs):
                if argv[:2] == ["docker", "version"]:
                    return subprocess.CompletedProcess(argv, 1, "", "")
                return super().__call__(argv, **kwargs)

        self.assertIn("the docker daemon does not answer", self.problems(run=DaemonDown()))


class InstallTests(Case):
    def _install(self, release, run):
        return ird.install(release, self.box.paths, run, env_file=self.box.env_file, identity_dir=self.box.ids,
                           owner_uid=self.uid, which=_which)

    def test_enables_the_timer_when_ready(self):
        release = self.box.release()
        ibw.point_current_at(release, self.box.paths.current_link)
        self.box.write_drill()
        run = FakeRun()
        self.assertEqual(self._install(release, run), [])
        self.assertIn(["systemctl", "daemon-reload"], run.calls)
        self.assertIn(["systemctl", "enable", "--now", ird.TIMER_UNIT], run.calls)
        for name in ird.UNIT_FILES:
            self.assertEqual((self.box.paths.unit_dir / name).read_bytes(), (REPO_ROOT / "control/provision" / name).read_bytes())

    def test_disables_the_timer_while_anything_is_missing(self):
        release = self.box.release()
        ibw.point_current_at(release, self.box.paths.current_link)
        self.box.write_config()
        run = FakeRun()
        self.assertNotEqual(self._install(release, run), [])
        self.assertIn(["systemctl", "disable", "--now", ird.TIMER_UNIT], run.calls)
        self.assertNotIn(["systemctl", "enable", "--now", ird.TIMER_UNIT], run.calls)

    def test_refuses_a_release_the_worker_is_not_running(self):
        release = self.box.release()
        other = self.box.release("r2")
        ibw.point_current_at(other, self.box.paths.current_link)
        with self.assertRaisesRegex(ibw.InstallError, "does not point at"):
            self._install(release, FakeRun())

    def test_refuses_a_release_without_the_drill(self):
        release = self.box.release()
        (release / "db/recovery/restore_drained.py").unlink()
        with self.assertRaisesRegex(ibw.InstallError, "restore_drained.py"):
            self._install(release, FakeRun())


class MainTests(Case):
    def _main(self, argv, euid=0):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(ird.os, "geteuid", return_value=euid), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ird.main(argv, run=FakeRun(), paths=self.box.paths)
        return code, out.getvalue(), err.getvalue()

    def test_check_reports_missing_and_exits_two(self):
        code, _, err = self._main(["--check"])
        self.assertEqual(code, 2)
        self.assertIn("NOT enabled", err)

    def test_check_ready_exits_zero(self):
        with mock.patch.object(ird, "readiness_problems", return_value=[]):
            code, out, _ = self._main(["--check"])
        self.assertEqual((code, out.strip()), (0, "install_restore_drill: ready"))

    def test_non_root_refused(self):
        code, _, err = self._main([], euid=1000)
        self.assertEqual(code, 1)
        self.assertIn("must run as root", err)

    def test_install_error_exits_one(self):
        with mock.patch.object(ird, "install", side_effect=ibw.InstallError("nope")):
            code, _, err = self._main([])
        self.assertEqual((code, "nope" in err), (1, True))

    def test_install_ready_enables(self):
        with mock.patch.object(ird, "install", return_value=[]):
            code, out, _ = self._main([])
        self.assertEqual(code, 0)
        self.assertIn("enabled", out)


class UnitFileTests(unittest.TestCase):
    def test_service_runs_the_drill_from_the_current_release(self):
        service = _unit(ird.SERVICE_UNIT)["Service"]
        self.assertIn("/opt/branchleft/backup-worker/current/infra/provisioning/scripts/restore_drill.py",
                      service["ExecStart"])
        self.assertEqual(service["EnvironmentFile"], str(ird.ENV_FILE))
        self.assertEqual(service["Type"], "oneshot")
        self.assertEqual(service["NoNewPrivileges"], "yes")

    def test_timer_is_weekly_at_night_and_catches_up(self):
        timer = _unit(ird.TIMER_UNIT)["Timer"]
        self.assertTrue(timer["OnCalendar"].startswith("Sun "))
        self.assertEqual(timer["Persistent"], "true")

    def test_metrics_dir_matches_the_worker_exporter(self):
        text = (REPO_ROOT / "control/provision" / ird.SERVICE_UNIT).read_text()
        self.assertIn("Environment=BACKUP_DRILL_METRICS_DIR=/var/lib/branchleft/backup-worker-exporter", text)
        self.assertIn("/var/lib/branchleft/backup-worker-exporter",
                      (REPO_ROOT / "control/provision/branchleft-backup-worker.service").read_text())


if __name__ == "__main__":
    unittest.main()
