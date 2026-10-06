#!/usr/bin/env python3
"""Tests that provision-tenant.yml writes only with the minted App token and
has no route back to a personal one. They read the workflow's structure, not
its behaviour: every `GH_TOKEN` binding must be the mint step's output, the
mint step must fail the run, and nothing may read a personal-token secret.
"""

from __future__ import annotations

import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import test_provision_tenant_flow_gate as gate  # noqa: E402

MINT_STEP = "Mint the provisioning token"
REVOKE_STEP = "Revoke the provisioning token"
TOKEN_EXPRESSION = "${{ steps.app-token.outputs.token }}"
RETIRED_SECRET = "GH_PAT_TENANT_PROVISIONING"


def _steps():
    return gate._steps_block(gate._read_workflow())


def _bodies():
    block = _steps()
    return {name: gate._step_body(block, name) for name in gate._step_names(block)}


class NoPersonalTokenTests(unittest.TestCase):
    def test_the_retired_secret_is_not_named_anywhere_in_the_workflow(self):
        self.assertNotIn(RETIRED_SECRET, gate._read_workflow())

    def test_no_secret_other_than_the_key_and_state_credentials_is_read(self):
        allowed = {
            "TENANT_PROVISIONING_APP_PRIVATE_KEY",
            "TENANT_STATE_S3_ACCESS_KEY_ID",
            "TENANT_STATE_S3_SECRET_ACCESS_KEY",
        }
        used = set(re.findall(r"\$\{\{\s*secrets\.([A-Za-z0-9_]+)", gate._read_workflow()))
        self.assertEqual(used - allowed, set(),
                         "a new secret is read; a token-shaped one must not "
                         "become a second route round the App")

    def test_no_secret_expression_is_ever_bound_to_a_token_variable(self):
        for name, body in _bodies().items():
            for line in body.splitlines():
                if re.match(r"\s+(GH_TOKEN|GITHUB_TOKEN|TOKEN):", line):
                    self.assertNotIn("secrets.", line, name)
                    self.assertNotIn("||", line, "%s: a fallback" % name)

    def test_every_token_binding_is_exactly_the_mint_output(self):
        found = 0
        for name, body in _bodies().items():
            for line in body.splitlines():
                match = re.match(r"\s+GH_TOKEN:\s*(.*)$", line)
                if match:
                    found += 1
                    self.assertEqual(match.group(1).strip(), TOKEN_EXPRESSION, name)
        self.assertGreaterEqual(found, 8)

    def test_the_workflow_level_environment_binds_no_token(self):
        header = gate._read_workflow().split("\n    steps:\n")[0]
        self.assertNotRegex(header, r"\bGH_TOKEN\b")


class MintStepTests(unittest.TestCase):
    def setUp(self):
        self.names = gate._step_names(_steps())
        self.body = gate._step_body(_steps(), MINT_STEP)

    def test_it_exists_with_the_id_every_binding_refers_to(self):
        self.assertIn("\n        id: app-token\n", "\n" + self.body)

    def test_it_runs_after_the_gate_and_before_anything_that_writes(self):
        mint = self.names.index(MINT_STEP)
        self.assertGreater(mint, self.names.index(gate.GATE_STEP_NAME))
        self.assertLess(mint, self.names.index(gate.FIRST_MUTATING_STEP_NAME))

    def test_it_is_ahead_of_the_first_step_that_uses_the_token(self):
        mint = self.names.index(MINT_STEP)
        for name, body in _bodies().items():
            if TOKEN_EXPRESSION in body:
                self.assertLess(mint, self.names.index(name), name)

    def test_it_cannot_be_skipped_or_survived(self):
        keys = gate._step_keys(self.body)
        self.assertEqual(keys - {"id", "env", "run"}, set())
        self.assertNotIn("if", keys)
        self.assertNotIn("continue-on-error", keys)

    def test_it_reads_the_key_from_an_environment_secret_and_the_id_from_a_variable(self):
        self.assertIn(
            "TENANT_PROVISIONING_APP_PRIVATE_KEY: "
            "${{ secrets.TENANT_PROVISIONING_APP_PRIVATE_KEY }}", self.body)
        self.assertIn(
            "TENANT_PROVISIONING_APP_ID: ${{ vars.TENANT_PROVISIONING_APP_ID }}",
            self.body)

    def test_it_runs_the_minting_script_and_nothing_pipes_its_failure_away(self):
        self.assertIn("tenant_provisioning_app_token.py mint", self.body)
        self.assertNotIn("||", self.body)
        self.assertNotIn("| tee", self.body)


class RevokeStepTests(unittest.TestCase):
    def test_it_runs_last_but_for_the_summary_and_always(self):
        names = gate._step_names(_steps())
        self.assertEqual(names[-2:], [REVOKE_STEP, "Summary"])
        self.assertIn("if: always()", gate._step_body(_steps(), REVOKE_STEP))

    def test_it_is_allowed_to_survive_a_failure_and_creates_nothing(self):
        self.assertIn(REVOKE_STEP, gate.STEPS_ALLOWED_TO_SURVIVE_A_FAILED_PREDECESSOR)
        body = gate._step_body(_steps(), REVOKE_STEP)
        self.assertIn("tenant_provisioning_app_token.py revoke", body)
        self.assertNotRegex(body, r"gh (repo|api|secret|variable|pr)\b")


if __name__ == "__main__":
    unittest.main()
