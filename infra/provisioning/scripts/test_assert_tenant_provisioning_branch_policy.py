#!/usr/bin/env python3
"""Unit tests for assert-tenant-provisioning-branch-policy.py.

The check reads the environment's deployment branch policy as two JSON
documents. These tests cover the passing policy, each way it can be changed
(no restriction, protected-branches allowed, extra or missing rule, a tag
rule), and the CLI exit codes, without any network access.
"""

from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from contextlib import redirect_stderr

_PATH = pathlib.Path(__file__).resolve().parent / "assert-tenant-provisioning-branch-policy.py"
_SPEC = importlib.util.spec_from_file_location("assert_tenant_provisioning_branch_policy", _PATH)
policy_check = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(policy_check)

MAIN_ONLY_ENV = {
    "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}
}
MAIN_ONLY_RULES = {"branch_policies": [{"name": "main", "type": "branch"}]}


class BranchPolicyCheckTests(unittest.TestCase):
    def test_main_only_passes(self):
        self.assertEqual(policy_check.check(MAIN_ONLY_ENV, MAIN_ONLY_RULES), [])

    def test_no_restriction_fails(self):
        env = {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": False}}
        problems = policy_check.check(env, {"branch_policies": []})
        self.assertTrue(any("no selected-branches restriction" in p for p in problems))

    def test_missing_policy_fails(self):
        problems = policy_check.check({}, {})
        self.assertTrue(any("no deployment branch policy" in p for p in problems))

    def test_protected_branches_allowed_fails(self):
        env = {"deployment_branch_policy": {"protected_branches": True, "custom_branch_policies": True}}
        problems = policy_check.check(env, MAIN_ONLY_RULES)
        self.assertTrue(any("protected branches" in p for p in problems))

    def test_extra_branch_rule_fails(self):
        rules = {"branch_policies": [{"name": "main", "type": "branch"}, {"name": "feature/x", "type": "branch"}]}
        problems = policy_check.check(MAIN_ONLY_ENV, rules)
        self.assertTrue(any("exactly ['main']" in p for p in problems))

    def test_wrong_branch_fails(self):
        rules = {"branch_policies": [{"name": "release", "type": "branch"}]}
        problems = policy_check.check(MAIN_ONLY_ENV, rules)
        self.assertTrue(any("exactly ['main']" in p for p in problems))

    def test_empty_rules_fails(self):
        problems = policy_check.check(MAIN_ONLY_ENV, {"branch_policies": []})
        self.assertTrue(any("empty" in p for p in problems))

    def test_tag_rule_fails(self):
        rules = {"branch_policies": [{"name": "main", "type": "tag"}]}
        problems = policy_check.check(MAIN_ONLY_ENV, rules)
        self.assertTrue(any("non-branch rule" in p for p in problems))

    def _run(self, env, rules):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = pathlib.Path(tmp) / "env.json"
            rules_path = pathlib.Path(tmp) / "rules.json"
            env_path.write_text(json.dumps(env), encoding="utf-8")
            rules_path.write_text(json.dumps(rules), encoding="utf-8")
            err = io.StringIO()
            with redirect_stderr(err):
                code = policy_check.main(
                    ["--environment-json", str(env_path), "--policies-json", str(rules_path)]
                )
            return code, err.getvalue()

    def test_cli_exit_zero_on_pass(self):
        code, err = self._run(MAIN_ONLY_ENV, MAIN_ONLY_RULES)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")

    def test_cli_exit_one_and_error_line_on_change(self):
        rules = {"branch_policies": [{"name": "main", "type": "branch"}, {"name": "x", "type": "branch"}]}
        code, err = self._run(MAIN_ONLY_ENV, rules)
        self.assertEqual(code, 1)
        self.assertIn("::error::", err)


if __name__ == "__main__":
    unittest.main()
