"""Run the CLI as CI does: subprocess, real exit code."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assert-environment-gated.py")
REVIEWER_ENV = {"protection_rules": [{"type": "required_reviewers", "reviewers": []}]}
NO_ENV = {"protection_rules": []}
APP = {"custom_deployment_protection_rules": [
    {"id": 1, "enabled": True, "app": {"id": 5090756, "slug": "branchleft-reviewer"}}]}
NO_RULES = {"total_count": 0, "custom_deployment_protection_rules": []}
ERROR_BODY = {"message": "Not Found", "status": "404"}


class Cli(unittest.TestCase):
    def run_cli(self, env, rules):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for name, doc in (("env.json", env), ("rules.json", rules)):
                path = os.path.join(d, name)
                if doc is not None:
                    with open(path, "w") as f:
                        f.write(doc if isinstance(doc, str) else json.dumps(doc))
                paths.append(path)  # a None doc leaves the path absent
            return subprocess.run([sys.executable, SCRIPT, *paths], capture_output=True).returncode

    def test_reviewer_only_exits_zero(self):
        self.assertEqual(self.run_cli(REVIEWER_ENV, NO_RULES), 0)

    def test_app_only_exits_zero(self):
        self.assertEqual(self.run_cli(NO_ENV, APP), 0)

    def test_nothing_exits_nonzero(self):
        self.assertNotEqual(self.run_cli(NO_ENV, NO_RULES), 0)

    def test_missing_file_exits_nonzero(self):
        self.assertNotEqual(self.run_cli(None, APP), 0)
        self.assertNotEqual(self.run_cli(REVIEWER_ENV, None), 0)

    def test_unparsable_file_exits_nonzero(self):
        self.assertNotEqual(self.run_cli("{", APP), 0)
        self.assertNotEqual(self.run_cli(REVIEWER_ENV, ""), 0)

    def test_error_body_exits_nonzero(self):
        self.assertNotEqual(self.run_cli(ERROR_BODY, ERROR_BODY), 0)
        self.assertNotEqual(self.run_cli(REVIEWER_ENV, ERROR_BODY), 0)

    def test_wrong_arguments_exit_nonzero(self):
        self.assertNotEqual(subprocess.run([sys.executable, SCRIPT], capture_output=True).returncode, 0)

    def test_self_test_exits_zero(self):
        self.assertEqual(subprocess.run([sys.executable, SCRIPT, "--self-test"], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
