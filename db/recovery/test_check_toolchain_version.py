#!/usr/bin/env python3
"""Unit tests for check_toolchain_version.py.

Every `docker run` is faked -- no real daemon, no real image -- so these
assert the parsing and comparison logic on its own: the runbook-pin regex,
major.minor extraction, and the match/mismatch decision. The live control
case (the built recovery image actually checked against a genuinely
different server line) is exercised separately, outside `unittest`, in CI
and recorded in the PR body -- see db/recovery/README.md.
"""

from __future__ import annotations

import subprocess
import unittest

import check_toolchain_version as ctv

RUNBOOK_TEXT = """\
```bash
branchleft-deploy db mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
```

some prose in between

```bash
branchleft-deploy db mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
```
"""


class FakeRun:
    """Records every `docker run` invoked and returns canned `--version`
    output keyed by (image, binary) -- no real docker call is ever exec'd."""

    def __init__(self, version_output: dict[tuple[str, str], str] | None = None, fail_on: set[tuple[str, str]] | None = None):
        self.version_output = version_output or {}
        self.fail_on = fail_on or set()
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        # argv shape: ["docker", "run", "--rm", "--entrypoint", binary, image, "--version"]
        binary = argv[4]
        image = argv[5]
        key = (image, binary)
        if key in self.fail_on:
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr=f"{binary}: not found")
        output = self.version_output.get(key, f"{binary}  Ver 8.0.46 for Linux on x86_64 (MySQL Community Server - GPL)")
        return subprocess.CompletedProcess(argv, 0, stdout=output, stderr="")


class ServerImageFromRunbookTests(unittest.TestCase):
    def test_extracts_the_pinned_image(self):
        self.assertEqual(
            ctv.server_image_from_runbook(RUNBOOK_TEXT),
            "mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b",
        )

    def test_raises_when_no_pin_is_present(self):
        with self.assertRaises(ctv.ToolchainCheckError):
            ctv.server_image_from_runbook("no pin command in here at all")

    def test_reads_the_real_committed_runbook(self):
        """The regex has to match the actual file, not just a fixture shaped
        like it -- this is the control for that regex going stale."""
        image = ctv.server_image_from_runbook()
        self.assertRegex(image, r"^mysql:\S+@sha256:[0-9a-f]{64}$")


class MajorMinorTests(unittest.TestCase):
    def test_parses_major_minor_from_version_output(self):
        self.assertEqual(
            ctv.major_minor("mysqldump  Ver 8.0.46 for Linux on x86_64 (MySQL Community Server - GPL)", label="x"),
            "8.0",
        )

    def test_raises_on_unparseable_output(self):
        with self.assertRaises(ctv.ToolchainCheckError):
            ctv.major_minor("not a version string", label="x")


class CheckTests(unittest.TestCase):
    def test_no_problems_when_every_binary_matches_the_server_line(self):
        run = FakeRun()  # every binary defaults to 8.0.46
        problems = ctv.check(recovery_image="recovery:ci", server_image="mysql:8.0@sha256:aaa", run=run)
        self.assertEqual(problems, [])
        # Server is read once, then each of the three client binaries.
        self.assertEqual(len(run.calls), 4)

    def test_reports_a_mismatched_binary_by_name(self):
        run = FakeRun(
            version_output={
                ("recovery:ci", "mysqldump"): "mysqldump  Ver 8.4.2 for Linux on x86_64 (MySQL Community Server - GPL)",
            }
        )
        problems = ctv.check(recovery_image="recovery:ci", server_image="mysql:8.0@sha256:aaa", run=run)
        self.assertEqual(len(problems), 1)
        self.assertIn("mysqldump", problems[0])
        self.assertIn("8.4.x", problems[0])
        self.assertIn("8.0.x", problems[0])

    def test_reports_every_mismatched_binary_not_just_the_first(self):
        run = FakeRun(
            version_output={
                ("recovery:ci", "mysqldump"): "mysqldump  Ver 8.4.2 ...",
                ("recovery:ci", "mysqlbinlog"): "mysqlbinlog  Ver 8.4.2 ...",
            }
        )
        problems = ctv.check(recovery_image="recovery:ci", server_image="mysql:8.0@sha256:aaa", run=run)
        self.assertEqual(len(problems), 2)

    def test_raises_when_the_server_image_cannot_be_read_at_all(self):
        run = FakeRun(fail_on={("mysql:8.0@sha256:aaa", "mysqld")})
        with self.assertRaises(ctv.ToolchainCheckError):
            ctv.check(recovery_image="recovery:ci", server_image="mysql:8.0@sha256:aaa", run=run)


class MainTests(unittest.TestCase):
    def test_exit_zero_on_a_full_match(self, run=None):
        run = run or FakeRun()
        original_check = ctv.check
        ctv.check = lambda **kwargs: original_check(**kwargs, run=run)
        try:
            code = ctv.main(["--recovery-image", "recovery:ci", "--server-image", "mysql:8.0@sha256:aaa"])
        finally:
            ctv.check = original_check
        self.assertEqual(code, 0)

    def test_exit_one_on_a_mismatch(self):
        run = FakeRun(version_output={("recovery:ci", "mysql"): "mysql  Ver 8.4.2 ..."})
        original_check = ctv.check
        ctv.check = lambda **kwargs: original_check(**kwargs, run=run)
        try:
            code = ctv.main(["--recovery-image", "recovery:ci", "--server-image", "mysql:8.0@sha256:aaa"])
        finally:
            ctv.check = original_check
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
