"""Tests that RUNBOOK-tenant-onboarding.md names the credentials the
provision-tenant.yml mint step actually reads, under the kind and scope the
workflow reads them with. See test_runbook_names_match_workflow.md.

The workflow side comes from test_provision_tenant_flow_gate's helpers, so
the workflow is parsed once, there, and not a second time here.
"""

import os
import re
import unittest

from test_provision_tenant_flow_gate import (
    GATE_JOB_NAME,
    _read_workflow,
    _steps_block,
    _step_body,
)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))
_RUNBOOK_PATH = os.path.join(_REPO_ROOT, "RUNBOOK-tenant-onboarding.md")

MINT_STEP_NAME = "Mint the provisioning token"

# The token the workflow no longer reads. The runbook may delete it, never set it.
RETIRED_TOKEN_SECRET = "GH_PAT_TENANT_PROVISIONING"

# The environment the job declares; an environment secret is only read by the
# job when it is set with this scope.
JOB_ENVIRONMENT = "tenant-provisioning"

_WORKFLOW_READ = re.compile(r"\$\{\{\s*(vars|secrets)\.([A-Za-z0-9_]+)\s*\}\}")
_RUNBOOK_SET = re.compile(r"^\s*gh (secret|variable) set ([A-Za-z0-9_]+)(.*)$", re.MULTILINE)
_RUNBOOK_DELETE = re.compile(r"^\s*gh secret delete ([A-Za-z0-9_]+)", re.MULTILINE)

# The workflow's reads are `vars` and `secrets`; the runbook's commands are
# `variable` and `secret`.
_KIND_FOR_CONTEXT = {"vars": "variable", "secrets": "secret"}


def _workflow_mint_reads():
    """(kind, name) for each vars./secrets. the mint step reads, e.g.
    ("variable", "TENANT_PROVISIONING_APP_ID")."""
    body = _step_body(_steps_block(_read_workflow()), MINT_STEP_NAME)
    reads = _WORKFLOW_READ.findall(body)
    if not reads:
        raise AssertionError(
            f"the {MINT_STEP_NAME!r} step in the {GATE_JOB_NAME!r} job reads no "
            "vars or secrets -- has the mint step changed shape?")
    return sorted({(_KIND_FOR_CONTEXT[ctx], name) for ctx, name in reads})


def _runbook_text():
    with open(_RUNBOOK_PATH, encoding="utf-8") as fh:
        return fh.read()


def _runbook_sets():
    """{(kind, name): the rest of the command line} for every gh set in the runbook."""
    return {(kind, name): rest.strip()
            for kind, name, rest in _RUNBOOK_SET.findall(_runbook_text())}


class RunbookNamesTheMintStepCredentials(unittest.TestCase):
    """Every name the mint step reads is set by the runbook, under the same
    kind, and every environment secret is set on the job's environment."""

    def test_mint_step_reads_some_credentials(self):
        self.assertTrue(_workflow_mint_reads())

    def test_runbook_sets_each_name_the_mint_step_reads_with_its_kind(self):
        sets = _runbook_sets()
        missing = [f"gh {kind} set {name}"
                   for kind, name in _workflow_mint_reads()
                   if (kind, name) not in sets]
        self.assertEqual(
            [], missing,
            "the runbook does not set these names, which provision-tenant.yml "
            f"reads at {MINT_STEP_NAME!r}: {missing}")

    def test_environment_secrets_are_set_on_the_job_environment(self):
        sets = _runbook_sets()
        unscoped = [name for kind, name in _workflow_mint_reads()
                    if kind == "secret"
                    and f"--env {JOB_ENVIRONMENT}" not in sets.get(("secret", name), "")]
        self.assertEqual(
            [], unscoped,
            f"these secrets are read by a job with environment {JOB_ENVIRONMENT!r} "
            f"but are not set with --env {JOB_ENVIRONMENT}: {unscoped}")


class RunbookRetiresTheOldTokenWithoutSettingIt(unittest.TestCase):

    def test_runbook_never_sets_the_retired_token(self):
        self.assertNotIn(("secret", RETIRED_TOKEN_SECRET), _runbook_sets())

    def test_runbook_deletes_the_retired_token(self):
        deleted = _RUNBOOK_DELETE.findall(_runbook_text())
        self.assertIn(RETIRED_TOKEN_SECRET, deleted)


if __name__ == "__main__":
    unittest.main()
