#!/usr/bin/env python3
"""Tests for install_state_copy.py; every systemctl call is faked."""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest

import install_state_copy as isc

ROOT = pathlib.Path(__file__).resolve().parents[2]


class Run:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, b"", b"")


class InstallStateCopyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.paths = isc.Paths(env_file=self.dir / "state-copy.env")

    def tearDown(self):
        self.tmp.cleanup()

    def write_env(self, names, mode=0o600):
        self.paths.env_file.write_text("".join(f"{n}=x\n" for n in names))
        os.chmod(self.paths.env_file, mode)

    def test_required_names_match_what_state_copy_reads(self):
        source = (ROOT / "infra/provisioning/scripts/state_copy.py").read_text()
        for name in isc.REQUIRED_ENV_NAMES:
            if name == "STATE_COPY_RECIPIENT":
                self.assertIn(name, source)
        self.assertIn('f"{prefix}_{n}"', source)
        for suffix in ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"):
            self.assertIn(f'"{suffix}"', source)
        self.assertEqual(len(isc.REQUIRED_ENV_NAMES), 16)

    def test_missing_name_or_loose_mode_keeps_the_timer_off(self):
        self.write_env(isc.REQUIRED_ENV_NAMES[:-1])
        problems = isc.readiness_problems(self.paths, owner_uid=os.getuid(), which=lambda t: "/bin/age")
        self.assertEqual(len(problems), 1)
        self.assertIn(isc.REQUIRED_ENV_NAMES[-1], problems[0])
        self.write_env(isc.REQUIRED_ENV_NAMES, mode=0o644)
        self.assertTrue(any("0600" in p for p in isc.readiness_problems(self.paths, owner_uid=os.getuid(), which=lambda t: "x")))

    def test_ready_when_complete_and_values_are_never_printed(self):
        self.write_env(isc.REQUIRED_ENV_NAMES)
        self.assertEqual(isc.readiness_problems(self.paths, owner_uid=os.getuid(), which=lambda t: "/bin/age"), [])

    def test_age_missing_is_a_problem(self):
        self.write_env(isc.REQUIRED_ENV_NAMES)
        self.assertEqual(isc.readiness_problems(self.paths, owner_uid=os.getuid(), which=lambda t: None), ["age is not installed"])

    def test_unit_pins_credential_hardening_and_no_environment_secrets(self):
        unit = (ROOT / "control/provision" / isc.SERVICE_UNIT).read_text()
        for needle in ("LoadCredential=state-copy.env:/etc/branchleft/state-copy.env", "ProtectSystem=strict",
                       "CapabilityBoundingSet=\n", "NoNewPrivileges=yes", "MemoryMax="):
            self.assertIn(needle, unit)
        self.assertNotIn("EnvironmentFile=", unit)
        self.assertIn("state_copy.py copy", unit)

    def test_timer_is_persistent_and_after_the_dump_worker(self):
        timer = (ROOT / "control/provision" / isc.TIMER_UNIT).read_text()
        self.assertIn("Persistent=true", timer)
        self.assertIn("03:40:00", timer)

    def test_check_flag_changes_nothing(self):
        run = Run()
        self.assertEqual(isc.main(["--check"], run=run, paths=self.paths), 2)
        self.assertEqual(run.calls, [])


if __name__ == "__main__":
    unittest.main()
