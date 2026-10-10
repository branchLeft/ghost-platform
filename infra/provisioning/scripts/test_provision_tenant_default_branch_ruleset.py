#!/usr/bin/env python3
"""Tests for the step in provision-tenant.yml that puts a default-branch
ruleset on each newly generated tenant repository.

Three things are proven:

(a) the step exists, runs after the repository is created and before any
    push, and carries no key that lets it be skipped or survived;
(b) the committed payload it posts has exactly the three rule types and
    code-owner review off;
(c) the step's own shell refuses when the read-back lacks any one rule,
    run against a stub `gh` that serves canned answers and nothing else.

Structure is read with the helpers in test_provision_tenant_flow_gate.py,
the same way test_provision_tenant_app_token_wiring.py reads it.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import test_provision_tenant_flow_gate as gate  # noqa: E402

STEP_NAME = "Protect the generated repository's default branch"
CREATE_STEP_NAME = gate.FIRST_MUTATING_STEP_NAME
TOKEN_EXPRESSION = "${{ steps.app-token.outputs.token }}"

PAYLOAD_RELPATH = "infra/provisioning/scripts/tenant-default-branch-ruleset.json"
PAYLOAD_PATH = pathlib.Path(gate._REPO_ROOT) / PAYLOAD_RELPATH

EXPECTED_RULE_TYPES = ["deletion", "non_fast_forward", "pull_request"]
EXPECTED_RULESET_NAME = "Protect default branch"

HANDOVER_REF = "provisioning/handover"


def _steps():
    return gate._steps_block(gate._read_workflow())


def _run_body(step_body):
    """The shell lines of a step's `run: |` block, dedented by its ten-space
    indent, stopping at the first line back at a shallower indent."""
    lines = step_body.split("\n")
    start = lines.index("        run: |") + 1
    out = []
    for line in lines[start:]:
        if line.strip() == "":
            out.append("")
            continue
        if not line.startswith(" " * 10):
            break
        out.append(line[10:])
    return "\n".join(out) + "\n"


class StepPresenceAndOrderingTests(unittest.TestCase):
    def setUp(self):
        self.steps = _steps()
        self.names = gate._step_names(self.steps)
        self.body = gate._step_body(self.steps, STEP_NAME)

    def test_the_step_exists(self):
        self.assertIn(STEP_NAME, self.names)

    def test_it_runs_after_the_repository_is_created(self):
        self.assertIn(CREATE_STEP_NAME, self.names)
        self.assertGreater(self.names.index(STEP_NAME),
                           self.names.index(CREATE_STEP_NAME))

    def test_it_runs_before_every_step_that_pushes(self):
        mine = self.names.index(STEP_NAME)
        pushers = [name for name in self.names
                   if "git push" in gate._step_body(self.steps, name)]
        self.assertTrue(pushers, "no pushing step found; the test is blind")
        for name in pushers:
            self.assertLess(mine, self.names.index(name),
                            "%s pushes before the default branch is protected"
                            % name)

    def test_every_push_in_the_workflow_targets_the_handover_branch(self):
        pushes = re.findall(r"git push[^\n]*", gate._read_workflow())
        self.assertTrue(pushes)
        for line in pushes:
            self.assertIn(HANDOVER_REF, line,
                          "a push that is not to the handover branch: %r" % line)

    def test_it_cannot_be_skipped_or_survived(self):
        keys = gate._step_keys(self.body)
        self.assertEqual(keys - {"env", "run"}, set())

    def test_it_binds_the_token_to_the_mint_output(self):
        self.assertIn("GH_TOKEN: " + TOKEN_EXPRESSION, self.body)

    def test_it_reads_the_committed_payload_and_posts_it(self):
        self.assertTrue(PAYLOAD_PATH.is_file(), PAYLOAD_RELPATH)
        run = _run_body(self.body)
        self.assertIn(PAYLOAD_RELPATH, run)
        self.assertIn('repos/${TENANT_REPO}/rulesets" \\', run)
        self.assertIn("--method POST", run)

    def test_it_is_idempotent_by_name_and_puts_an_existing_ruleset(self):
        run = _run_body(self.body)
        self.assertIn("select(.name == $name)", run)
        self.assertIn("--method PUT", run)
        self.assertIn("rulesets/${existing_id}", run)

    def test_it_reads_the_branch_rules_back_and_compares_them_exactly(self):
        run = _run_body(self.body)
        self.assertIn("rules/branches/main", run)
        self.assertIn(
            'expected="%s"' % ",".join(EXPECTED_RULE_TYPES), run)

    def test_a_private_tenant_is_skipped_with_a_visible_line_and_no_failure(self):
        run = _run_body(self.body)
        self.assertIn('"$TENANT_VISIBILITY" = "private"', run)
        self.assertIn("::warning::", run)
        self.assertIn("exit 0", run)


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.loads(PAYLOAD_PATH.read_text(encoding="utf-8"))

    def test_it_has_exactly_the_three_rule_types(self):
        types = sorted(rule["type"] for rule in self.payload["rules"])
        self.assertEqual(types, EXPECTED_RULE_TYPES)

    def test_code_owner_review_is_off(self):
        pull_request = [r for r in self.payload["rules"]
                        if r["type"] == "pull_request"]
        self.assertEqual(len(pull_request), 1)
        self.assertIs(
            pull_request[0]["parameters"]["require_code_owner_review"], False)

    def test_it_is_active_on_the_default_branch_of_a_branch_target(self):
        self.assertEqual(self.payload["target"], "branch")
        self.assertEqual(self.payload["enforcement"], "active")
        self.assertEqual(self.payload["conditions"]["ref_name"]["include"],
                         ["~DEFAULT_BRANCH"])

    def test_it_has_the_name_the_step_looks_for(self):
        self.assertEqual(self.payload["name"], EXPECTED_RULESET_NAME)


STUB_GH = textwrap.dedent('''\
    #!/usr/bin/env python3
    import os
    import subprocess
    import sys

    args = sys.argv[1:]
    with open(os.environ["STUB_LOG"], "a", encoding="utf-8") as log:
        log.write(" ".join(args) + "\\n")
    method, jq, path, i = "GET", None, None, 0
    while i < len(args):
        a = args[i]
        if a == "api":
            i += 1
        elif a == "--method":
            method = args[i + 1]
            i += 2
        elif a == "--jq":
            jq = args[i + 1]
            i += 2
        elif a == "--input":
            i += 2
        elif a == "--silent":
            i += 1
        elif path is None:
            path = a
            i += 1
        else:
            i += 1
    if method != "GET":
        sys.exit(0)
    if path.endswith("/rulesets"):
        body = os.environ["STUB_RULESETS"]
    elif "/rules/branches/main" in path:
        body = os.environ["STUB_RULES"]
    else:
        sys.exit(1)
    if jq is not None:
        body = subprocess.run(["jq", "-r", jq], input=body, capture_output=True,
                              text=True, check=True).stdout
    sys.stdout.write(body + "\\n")
''')


class ReadBackRefusalTests(unittest.TestCase):
    """Runs the step's real shell against a stub gh. The stub is the only
    thing that answers; nothing reaches GitHub."""

    @classmethod
    def setUpClass(cls):
        if shutil.which("jq") is None:
            raise AssertionError(
                "jq is not on PATH. The step uses jq and so does this test; "
                "a missing jq must fail, not skip")
        cls.body = gate._step_body(_steps(), STEP_NAME)
        cls.shell = _run_body(cls.body)

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        stub = pathlib.Path(self.tmp) / "gh"
        stub.write_text(STUB_GH, encoding="utf-8")
        stub.chmod(0o755)
        self.log = pathlib.Path(self.tmp) / "gh.log"
        self.script = pathlib.Path(self.tmp) / "step.sh"
        self.script.write_text(self.shell, encoding="utf-8")

    def _run(self, rules, rulesets="[]", visibility="public"):
        env = {
            "PATH": self.tmp + os.pathsep + os.environ.get("PATH", ""),
            "TENANT_REPO": "branchLeft/ghost-tenant-probe",
            "TENANT_VISIBILITY": visibility,
            "GH_TOKEN": "stub",
            "STUB_LOG": str(self.log),
            "STUB_RULES": json.dumps([{"type": t} for t in rules]),
            "STUB_RULESETS": rulesets,
            "HOME": self.tmp,
        }
        # The step's ruleset path is relative to the repository root.
        result = subprocess.run(
            ["bash", str(self.script)], cwd=gate._REPO_ROOT, env=env,
            capture_output=True, text=True)
        calls = self.log.read_text(encoding="utf-8") if self.log.exists() else ""
        return result, calls

    def test_all_three_rules_read_back_passes_and_posts(self):
        result, calls = self._run(EXPECTED_RULE_TYPES)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--method POST", calls)

    def test_a_read_back_missing_deletion_is_refused(self):
        self._assert_refused(["non_fast_forward", "pull_request"])

    def test_a_read_back_missing_non_fast_forward_is_refused(self):
        self._assert_refused(["deletion", "pull_request"])

    def test_a_read_back_missing_pull_request_is_refused(self):
        self._assert_refused(["deletion", "non_fast_forward"])

    def test_an_empty_read_back_is_refused(self):
        self._assert_refused([])

    def test_an_existing_ruleset_with_the_name_is_put_not_posted(self):
        rulesets = json.dumps([{"id": 4242, "name": EXPECTED_RULESET_NAME}])
        result, calls = self._run(EXPECTED_RULE_TYPES, rulesets=rulesets)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--method PUT", calls)
        self.assertIn("rulesets/4242", calls)
        self.assertNotIn("--method POST", calls)

    def test_a_private_tenant_skips_with_a_warning_and_no_gh_call(self):
        result, calls = self._run([], visibility="private")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stdout)
        self.assertEqual(calls, "")

    def _assert_refused(self, rules):
        result, calls = self._run(rules)
        self.assertNotEqual(result.returncode, 0,
                            "a read-back of %r was accepted" % rules)
        self.assertIn("::error::", result.stdout)


if __name__ == "__main__":
    unittest.main()
