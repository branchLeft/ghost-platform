"""Tests for check_provisioning_gate_left_open.py and the workflow that runs it.

The script is run as a subprocess, the way the workflow runs it, and its pure
decision is also called directly. A separate class reads the workflow for what
the script cannot see: that the variable is bound to the real repository
variable, that the job runs on a schedule, and that no key lets the check pass
without running. Rebinding the variable to a literal would leave every
behavioural test green and the watch permanently blind.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))
_SCRIPT = os.path.join(_HERE, "check_provisioning_gate_left_open.py")
_WORKFLOW = os.path.join(
    _REPO_ROOT, ".github", "workflows", "provisioning-gate-watch.yml")

sys.path.insert(0, _HERE)
import check_provisioning_gate_left_open as watch  # noqa: E402

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
GRACE = timedelta(minutes=watch.DEFAULT_GRACE_MINUTES)


def _run(status: str, minutes_ago: int) -> dict[str, Any]:
    when = NOW - timedelta(minutes=minutes_ago)
    return {"status": status, "updated_at": when.strftime("%Y-%m-%dT%H:%M:%SZ")}


class EvaluateTests(unittest.TestCase):
    def test_open_with_no_runs_is_left_open(self) -> None:
        code, _ = watch.evaluate("true", [], NOW, GRACE)
        self.assertEqual(code, watch.EXIT_LEFT_OPEN)

    def test_open_after_the_last_run_past_grace_is_left_open(self) -> None:
        code, _ = watch.evaluate(
            "true", [_run("completed", 121)], NOW, GRACE)
        self.assertEqual(code, watch.EXIT_LEFT_OPEN)

    def test_open_within_grace_of_the_last_run_passes(self) -> None:
        code, _ = watch.evaluate("true", [_run("completed", 119)], NOW, GRACE)
        self.assertEqual(code, watch.EXIT_OK)

    def test_open_while_a_run_is_active_passes(self) -> None:
        for status in sorted(watch.ACTIVE_STATUSES):
            old = [_run("completed", 5000), _run(status, 5000)]
            code, _ = watch.evaluate("true", old, NOW, GRACE)
            self.assertEqual(code, watch.EXIT_OK, status)

    def test_latest_run_decides_not_the_first_listed(self) -> None:
        runs = [_run("completed", 5000), _run("completed", 10)]
        code, _ = watch.evaluate("true", runs, NOW, GRACE)
        self.assertEqual(code, watch.EXIT_OK)

    def test_closed_passes_whatever_the_runs_say(self) -> None:
        for value in (None, "", "false", "TRUE", "True", "1", " true", "yes"):
            code, _ = watch.evaluate(value, [], NOW, GRACE)
            self.assertEqual(code, watch.EXIT_OK, repr(value))

    def test_a_run_without_a_time_is_unusable(self) -> None:
        with self.assertRaises(watch.Unusable):
            watch.evaluate("true", [{"status": "completed"}], NOW, GRACE)


class CommandLineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)

    def _runs_file(self, runs: list[dict[str, Any]]) -> str:
        path = os.path.join(self._dir.name, "runs.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"workflow_runs": runs}, fh)
        return path

    def _check(
        self, flow_ready: Optional[str], runs_file: Optional[str]
    ) -> "subprocess.CompletedProcess[str]":
        env = {k: v for k, v in os.environ.items() if k != "FLOW_READY"}
        if flow_ready is not None:
            env["FLOW_READY"] = flow_ready
        cmd = [sys.executable, _SCRIPT, "--now", NOW.isoformat()]
        if runs_file is not None:
            cmd += ["--runs-file", runs_file]
        return subprocess.run(
            cmd, env=env, capture_output=True, text=True, check=False)

    def test_open_gate_with_no_recent_run_is_red(self) -> None:
        done = self._check("true", self._runs_file([_run("completed", 9999)]))
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("::error::", done.stdout)
        self.assertIn("gh variable delete", done.stdout)

    def test_closed_gate_is_green(self) -> None:
        done = self._check("false", self._runs_file([_run("completed", 9999)]))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_unset_variable_is_green_and_needs_no_runs_file(self) -> None:
        done = self._check(None, None)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_empty_variable_is_green(self) -> None:
        done = self._check("", None)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_open_gate_with_a_missing_runs_file_fails_closed(self) -> None:
        missing = os.path.join(self._dir.name, "absent.json")
        done = self._check("true", missing)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)

    def test_open_gate_with_no_runs_file_argument_fails_closed(self) -> None:
        done = self._check("true", None)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)

    def test_open_gate_with_a_malformed_runs_file_fails_closed(self) -> None:
        path = os.path.join(self._dir.name, "bad.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write('{"message": "Not Found"}')
        done = self._check("true", path)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)

    def test_open_gate_during_an_active_run_is_green(self) -> None:
        runs = [_run("in_progress", 300), _run("completed", 9999)]
        done = self._check("true", self._runs_file(runs))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)


class WorkflowWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        with open(_WORKFLOW, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_it_runs_on_a_schedule(self) -> None:
        self.assertRegex(self.text, r"(?m)^on:\n  schedule:\n    - cron: '")

    def test_the_variable_is_bound_to_the_real_repository_variable(self) -> None:
        self.assertIn(
            "FLOW_READY: ${{ vars.TENANT_PROVISIONING_FLOW_HETZNERISED }}",
            self.text)

    def test_the_gate_variable_name_matches_the_provisioning_workflow(self) -> None:
        with open(os.path.join(
                _REPO_ROOT, ".github", "workflows", "provision-tenant.yml"),
                encoding="utf-8") as fh:
            gate = fh.read()
        self.assertIn(
            "FLOW_READY: ${{ vars.TENANT_PROVISIONING_FLOW_HETZNERISED }}",
            gate)

    def test_nothing_lets_the_check_pass_without_running(self) -> None:
        self.assertIsNone(re.search(r"(?m)^\s*continue-on-error:", self.text))
        self.assertIsNone(re.search(r"(?m)^\s*if:", self.text))
        self.assertIsNone(re.search(r"\|\|\s*(true|echo|:)", self.text))

    def test_it_runs_the_script_with_the_runs_file(self) -> None:
        self.assertIn("check_provisioning_gate_left_open.py", self.text)
        self.assertIn("--runs-file", self.text)

    def test_the_token_can_only_read(self) -> None:
        self.assertIn("permissions:\n  contents: read\n  actions: read\n",
                      self.text)


if __name__ == "__main__":
    unittest.main()
