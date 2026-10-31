"""Parity between public and private tenants, after the plan gate.

Once the gate has passed, a private tenant takes exactly the public path through
the production environment and the default-branch ruleset. These tests show it
two ways:

(a) statically, TENANT_VISIBILITY is read only where a choice is made: the job
    environment binding, the Validate step, the repository creation step and the
    Summary. No credential or protection step branches on it.
(b) dynamically, the extracted environment block and the real ruleset step run
    against a stub gh, once for public and once for private. Both issue the same
    gh calls in the same order, with the same read-backs. Equivalence is in calls
    and read-backs, not in bytes of output. A private read-back with no required
    reviewer, or a short ruleset read-back, fails closed with ::error::.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import test_provision_tenant_default_branch_ruleset as rs  # noqa: E402
import test_provision_tenant_visibility_refusal as vis  # noqa: E402

ENVIRONMENT_STEP = "Mint, escrow and publish this tenant's secrets passphrase"
SUMMARY_STEP = "Summary"
REVIEWERS = '[{"type":"User","id":1234567}]'
TENANT_REPO = "branchLeft/ghost-tenant-probe"
WITH_REVIEWER = json.dumps({"protection_rules": [{"type": "required_reviewers"}]})
WITHOUT_REVIEWER = json.dumps({"protection_rules": [{"type": "wait_timer"}]})

ENV_BLOCK_START = 'if [ -z "$TENANT_ENVIRONMENT_REVIEWERS" ]; then'
ENV_BLOCK_END = "printf '%s' \"$PASSPHRASE\" \\"


def _environment_block():
    """The environment reviewer and read-back lines of the Mint step, from the
    reviewers check up to the passphrase write, run under the step's own
    `set -euo pipefail`."""
    body = vis._run_body(vis._step_lines(vis._read_workflow(), ENVIRONMENT_STEP))
    start = body.index(ENV_BLOCK_START)
    end = body.index(ENV_BLOCK_END, start)
    return ["set -euo pipefail"] + body[start:end]


class _StubRun:
    """Runs one shell script with a stub gh on PATH, and returns its result and
    the stub's log of every gh call."""

    def __init__(self, test):
        self.tmp = tempfile.mkdtemp(prefix="parity-")
        test.addCleanup(shutil.rmtree, self.tmp, True)
        stub = pathlib.Path(self.tmp) / "gh"
        stub.write_text(rs.STUB_GH, encoding="utf-8")
        stub.chmod(0o755)
        self.log = pathlib.Path(self.tmp) / "gh.log"
        self.script = pathlib.Path(self.tmp) / "step.sh"

    def run(self, lines, cwd, extra_env):
        self.script.write_text("\n".join(lines) + "\n", encoding="utf-8")
        env = {
            "PATH": self.tmp + os.pathsep + os.environ.get("PATH", ""),
            "TENANT_REPO": TENANT_REPO,
            "GH_TOKEN": "stub",
            "STUB_LOG": str(self.log),
            "STUB_RULESETS": "[]",
            "STUB_RULES": "[]",
            "STUB_ENVIRONMENT": WITH_REVIEWER,
            "HOME": self.tmp,
        }
        env.update(extra_env)
        result = subprocess.run(
            ["bash", str(self.script)],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
        )
        calls = self.log.read_text(encoding="utf-8") if self.log.exists() else ""
        return result, calls


class TheVisibilityChoiceIsReadOnlyWhereItIsMade(unittest.TestCase):
    def setUp(self):
        self.lines = vis._read_workflow()

    def test_tenant_visibility_is_read_only_in_the_four_expected_places(self):
        steps_reading = set()
        job_level = 0
        current = None
        for line in self.lines:
            if vis.STEP_LINE.match(line):
                current = vis.STEP_LINE.match(line).group(1)
            elif vis.JOB_KEY_LINE.match(line):
                current = None
            if "TENANT_VISIBILITY" in line:
                if current is None:
                    job_level += 1
                else:
                    steps_reading.add(current)
        self.assertEqual(job_level, 1)
        self.assertEqual(
            steps_reading,
            {vis.VALIDATE_STEP, vis.CREATE_STEP, SUMMARY_STEP},
        )

    def test_the_environment_and_ruleset_steps_do_not_branch_on_it(self):
        self.assertNotIn(
            "TENANT_VISIBILITY", "\n".join(_environment_block()),
        )
        ruleset = rs.gate._step_body(rs._steps(), rs.STEP_NAME)
        self.assertNotIn("TENANT_VISIBILITY", ruleset)


class TheEnvironmentStepIsParityForPublicAndPrivate(unittest.TestCase):
    def _run_both(self, extra):
        block = _environment_block()
        results = {}
        for visibility in ("public", "private"):
            runner = _StubRun(self)
            env = {"TENANT_VISIBILITY": visibility,
                   "TENANT_ENVIRONMENT_REVIEWERS": REVIEWERS}
            env.update(extra)
            results[visibility] = runner.run(block, runner.tmp, env)
        return results

    def test_a_read_back_with_a_reviewer_passes_identically(self):
        results = self._run_both({"STUB_ENVIRONMENT": WITH_REVIEWER})
        for visibility, (result, calls) in results.items():
            with self.subTest(visibility=visibility):
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("--method PUT", calls)
                self.assertIn("environments/production", calls)
        self.assertEqual(results["public"][1], results["private"][1])
        self.assertEqual(results["public"][0].returncode, results["private"][0].returncode)

    def test_a_private_read_back_without_a_reviewer_fails_closed(self):
        results = self._run_both({"STUB_ENVIRONMENT": WITHOUT_REVIEWER})
        for visibility, (result, calls) in results.items():
            with self.subTest(visibility=visibility):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stdout)
        self.assertEqual(results["public"][1], results["private"][1])

    def test_an_unset_reviewers_variable_refuses_for_both(self):
        block = _environment_block()
        for visibility in ("public", "private"):
            with self.subTest(visibility=visibility):
                runner = _StubRun(self)
                result, calls = runner.run(
                    block,
                    runner.tmp,
                    {"TENANT_VISIBILITY": visibility, "TENANT_ENVIRONMENT_REVIEWERS": ""},
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stdout)
                self.assertEqual(calls, "")


class TheRulesetStepIsParityForPublicAndPrivate(unittest.TestCase):
    def setUp(self):
        self.shell = rs._run_body(rs.gate._step_body(rs._steps(), rs.STEP_NAME))

    def _run_both(self, rules):
        results = {}
        for visibility in ("public", "private"):
            runner = _StubRun(self)
            results[visibility] = runner.run(
                self.shell.split("\n"),
                str(rs.gate._REPO_ROOT),
                {
                    "TENANT_VISIBILITY": visibility,
                    "STUB_RULES": json.dumps([{"type": t} for t in rules]),
                },
            )
        return results

    def test_a_full_read_back_posts_identically(self):
        results = self._run_both(rs.EXPECTED_RULE_TYPES)
        for visibility, (result, calls) in results.items():
            with self.subTest(visibility=visibility):
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("--method POST", calls)
                self.assertIn("rules/branches/main", calls)
        self.assertEqual(results["public"][1], results["private"][1])

    def test_a_short_read_back_fails_closed_for_both(self):
        results = self._run_both(["non_fast_forward", "pull_request"])
        for visibility, (result, calls) in results.items():
            with self.subTest(visibility=visibility):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stdout)
        self.assertEqual(results["public"][1], results["private"][1])


if __name__ == "__main__":
    unittest.main()
