#!/usr/bin/env python3
"""Unit tests for assert-tenant-provisioning-branch-policy.py.

The script must exit 0 only for exactly: selected branches, exactly one rule,
that rule a branch rule named main. Every other shape, including unreadable
input and error bodies, must exit 1 with one line and no traceback.
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


def _rules(*rules):
    return {"branch_policies": list(rules)}


class CheckTests(unittest.TestCase):
    def assertProblemContains(self, env, rules, text):
        problems = policy_check.check(env, rules)
        self.assertTrue(problems, "expected a problem, got none")
        self.assertTrue(any(text in p for p in problems), problems)

    # Pass: the one shape that may exit 0.
    def test_main_only_passes(self):
        self.assertEqual(policy_check.check(MAIN_ONLY_ENV, MAIN_ONLY_RULES), [])

    # The live shape read on 2026-10-12: no policy at all.
    def test_null_policy_fails_as_no_restriction(self):
        self.assertProblemContains({"deployment_branch_policy": None}, MAIN_ONLY_RULES, "no deployment branch policy")

    def test_missing_policy_field_fails(self):
        self.assertProblemContains({}, MAIN_ONLY_RULES, "no deployment_branch_policy field")

    def test_no_restriction_fails(self):
        env = {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": False}}
        self.assertProblemContains(env, _rules(), "no selected-branches restriction")

    def test_protected_branches_allowed_fails(self):
        env = {"deployment_branch_policy": {"protected_branches": True, "custom_branch_policies": True}}
        self.assertProblemContains(env, MAIN_ONLY_RULES, "protected branches")

    def test_protected_branches_missing_fails(self):
        env = {"deployment_branch_policy": {"custom_branch_policies": True}}
        self.assertProblemContains(env, MAIN_ONLY_RULES, "protected branches")

    def test_custom_flag_string_true_fails(self):
        env = {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": "true"}}
        self.assertProblemContains(env, MAIN_ONLY_RULES, "no selected-branches restriction")

    def test_string_policy_fails(self):
        self.assertProblemContains({"deployment_branch_policy": "main"}, MAIN_ONLY_RULES, "not an object")

    def test_extra_branch_rule_fails(self):
        rules = _rules({"name": "main", "type": "branch"}, {"name": "feature/x", "type": "branch"})
        self.assertProblemContains(MAIN_ONLY_ENV, rules, "must be exactly ['main']")

    def test_duplicate_main_fails(self):
        rules = _rules({"name": "main", "type": "branch"}, {"name": "main", "type": "branch"})
        self.assertProblemContains(MAIN_ONLY_ENV, rules, "must be exactly ['main']")

    def test_wrong_branch_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, _rules({"name": "release", "type": "branch"}), "must be exactly ['main']")

    def test_empty_rules_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, _rules(), "must be exactly ['main']")

    def test_tag_rule_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, _rules({"name": "main", "type": "tag"}), "not of type branch")

    # Defect (a): a rule without a type key must not pass.
    def test_main_without_type_key_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, _rules({"name": "main"}), "not of type branch")

    def test_main_with_null_type_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, _rules({"name": "main", "type": None}), "not of type branch")

    # Defect (b): a null name beside main, and other odd rule shapes.
    def test_null_name_beside_main_fails_cleanly(self):
        rules = _rules({"name": "main", "type": "branch"}, {"name": None, "type": "branch"})
        self.assertProblemContains(MAIN_ONLY_ENV, rules, "has no name")

    def test_rule_not_an_object_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, {"branch_policies": ["main"]}, "not an object")

    # Defect (b): an error body gets its own message, not 'any branch can dispatch'.
    def test_env_error_body_is_not_reported_as_no_restriction(self):
        problems = policy_check.check({"message": "Not Found"}, MAIN_ONLY_RULES)
        self.assertTrue(problems)
        self.assertFalse(any("any branch" in p for p in problems), problems)
        self.assertTrue(any("error body" in p for p in problems), problems)

    def test_policies_error_body_fails_with_error_message(self):
        problems = policy_check.check(MAIN_ONLY_ENV, {"message": "Not Found"})
        self.assertTrue(any("error body" in p for p in problems), problems)

    def test_branch_policies_not_a_list_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, {"branch_policies": {"name": "main"}}, "no branch_policies list")

    def test_top_level_list_env_fails(self):
        self.assertProblemContains([MAIN_ONLY_ENV], MAIN_ONLY_RULES, "not a JSON object")

    def test_null_env_fails(self):
        self.assertProblemContains(None, MAIN_ONLY_RULES, "not a JSON object")

    def test_top_level_list_rules_fails(self):
        self.assertProblemContains(MAIN_ONLY_ENV, [], "not a JSON object")


class CliTests(unittest.TestCase):
    def _run(self, env_text, rules_text):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = pathlib.Path(tmp) / "env.json"
            rules_path = pathlib.Path(tmp) / "rules.json"
            env_path.write_text(env_text, encoding="utf-8")
            rules_path.write_text(rules_text, encoding="utf-8")
            return self._run_paths(str(env_path), str(rules_path))

    def _run_paths(self, env_path, rules_path):
        err = io.StringIO()
        with redirect_stderr(err):
            code = policy_check.main(["--environment-json", env_path, "--policies-json", rules_path])
        return code, err.getvalue()

    def _assert_one_line_failure(self, code, err):
        self.assertEqual(code, 1)
        self.assertNotIn("Traceback", err)
        self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertIn("::error::", err)

    def test_pass_exits_zero_silently(self):
        code, err = self._run(json.dumps(MAIN_ONLY_ENV), json.dumps(MAIN_ONLY_RULES))
        self.assertEqual(code, 0)
        self.assertEqual(err, "")

    def test_change_exits_one_with_error_line(self):
        rules = _rules({"name": "main", "type": "branch"}, {"name": "x", "type": "branch"})
        code, err = self._run(json.dumps(MAIN_ONLY_ENV), json.dumps(rules))
        self.assertEqual(code, 1)
        self.assertIn("::error::", err)

    def test_empty_file_fails_one_line(self):
        self._assert_one_line_failure(*self._run("", json.dumps(MAIN_ONLY_RULES)))

    def test_non_json_file_fails_one_line(self):
        self._assert_one_line_failure(*self._run("<html>not json", json.dumps(MAIN_ONLY_RULES)))

    def test_null_json_fails_one_line(self):
        self._assert_one_line_failure(*self._run("null", json.dumps(MAIN_ONLY_RULES)))

    def test_top_level_list_file_fails_one_line(self):
        self._assert_one_line_failure(*self._run("[]", json.dumps(MAIN_ONLY_RULES)))

    def test_missing_file_fails_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(pathlib.Path(tmp) / "absent.json")
            rules_path = pathlib.Path(tmp) / "rules.json"
            rules_path.write_text(json.dumps(MAIN_ONLY_RULES), encoding="utf-8")
            self._assert_one_line_failure(*self._run_paths(missing, str(rules_path)))

    def test_string_policy_file_fails_one_line(self):
        env = json.dumps({"deployment_branch_policy": "main"})
        self._assert_one_line_failure(*self._run(env, json.dumps(MAIN_ONLY_RULES)))

    def test_null_name_file_fails_one_line(self):
        rules = _rules({"name": "main", "type": "branch"}, {"name": None, "type": "branch"})
        self._assert_one_line_failure(*self._run(json.dumps(MAIN_ONLY_ENV), json.dumps(rules)))

    def test_error_body_file_fails_one_line(self):
        self._assert_one_line_failure(*self._run(json.dumps({"message": "API rate limit"}), json.dumps({"message": "Not Found"})))


if __name__ == "__main__":
    unittest.main()
