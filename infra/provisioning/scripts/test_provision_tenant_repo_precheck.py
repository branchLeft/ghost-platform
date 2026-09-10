#!/usr/bin/env python3
"""Tests for the create-only repository precheck in ../../../.github/
workflows/provision-tenant.yml -- the step that refuses to provision a tenant
whose repository already exists.

Why this file exists: the check was `gh repo view "$TENANT_REPO"`, which
follows a rename redirect. GitHub keeps a renamed repository's former name
pointing at it until something claims that name, so a tenant torn down per
`RUNBOOK-tenant-onboarding.md` teardown step 8 -- which says to rename and
archive rather than delete, to keep the audit trail -- leaves its old name
answering. Re-provisioning that tenant under its own name is the normal
lifecycle, and the check refused every one of them, reporting a repository
that does not exist. It blocked a real provisioning run on 2026-09-10.

The check is inline shell in YAML with no module to import, so this follows
`test_provision_tenant_flow_gate.py`: extract the literal block from the
workflow and execute it under `bash -e`, which is what a `run:` with no
`shell:` gets on a Linux runner. A textual assertion would be satisfied by a
comparison that reads correctly and behaves differently -- `=` against `!=`,
or a `-n` test that swallows the distinction this fix turns on.

`fail` is a function defined earlier in the same step; the harness stubs it,
so what is under test is the branching, not that helper.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import tempfile
import unittest

WORKFLOW = (
    pathlib.Path(__file__).resolve().parents[3]
    / ".github"
    / "workflows"
    / "provision-tenant.yml"
)

# The block under test: from the equality test through its closing `fi`.
BLOCK = re.compile(
    r'^(\s*)if \[ "\$existing_repo" = "\$TENANT_REPO" \]; then\n(.*?)^\1fi\n',
    re.DOTALL | re.MULTILINE,
)


def extract_block(source: str) -> str:
    match = BLOCK.search(source)
    if match is None:
        raise AssertionError(
            "the repository precheck's if/elif/fi block was not found in "
            f"{WORKFLOW}. If it was rewritten, this test must be rewritten "
            "with it -- it must not silently stop testing anything."
        )
    body = match.group(0)
    # Strip the YAML block indentation so bash sees ordinary script text.
    indent = match.group(1)
    return "\n".join(
        line[len(indent):] if line.startswith(indent) else line
        for line in body.splitlines()
    )


class ExtractionTests(unittest.TestCase):
    """A control case. Without it every behavioural test below would pass
    vacuously against an empty string if the workflow moved or the block was
    renamed."""

    def test_the_workflow_exists_and_is_the_provisioning_one(self):
        self.assertTrue(WORKFLOW.is_file(), WORKFLOW)
        self.assertIn("name: Provision tenant", WORKFLOW.read_text(encoding="utf-8"))

    def test_the_block_is_found_and_is_not_empty(self):
        block = extract_block(WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("existing_repo", block)
        self.assertIn("fi", block)

    def test_extraction_raises_rather_than_returning_nothing(self):
        # A missing block must stop the suite, not quietly test an empty
        # string -- the failure mode that makes a green run meaningless.
        with self.assertRaises(AssertionError):
            extract_block("a workflow with no such block\n")


class PrecheckBehaviourTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.block = extract_block(WORKFLOW.read_text(encoding="utf-8"))

    def _run(self, tenant_repo: str, existing_repo: str):
        script = (
            "set -e\n"
            'fail() { echo "FAILED: $*" >&2; exit 1; }\n'
            f"TENANT_REPO={tenant_repo!r}\n"
            f"existing_repo={existing_repo!r}\n"
            + self.block
            + '\necho "REACHED THE END"\n'
        )
        with tempfile.NamedTemporaryFile(
            "w", suffix=".sh", delete=False, encoding="utf-8"
        ) as handle:
            handle.write(script)
            path = handle.name
        self.addCleanup(lambda: pathlib.Path(path).unlink(missing_ok=True))
        return subprocess.run(
            ["bash", path], capture_output=True, text=True, timeout=30
        )

    def test_a_genuinely_existing_repository_still_refuses(self):
        # The original purpose of the check, which must survive the fix: it is
        # what stops a live tenant's hand-set passphrase being minted over.
        result = self._run("branchLeft/ghost-tenant-acme", "branchLeft/ghost-tenant-acme")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already exists", result.stderr)
        self.assertNotIn("REACHED THE END", result.stdout)

    def test_a_rename_redirect_is_not_treated_as_an_existing_repository(self):
        # The bug this fixes. The API answers a request for ghost-tenant-blog
        # with ghost-tenant-blog-gcp, because the first was renamed to the
        # second. Nothing occupies the requested name.
        result = self._run(
            "branchLeft/ghost-tenant-blog", "branchLeft/ghost-tenant-blog-gcp"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("REACHED THE END", result.stdout)

    def test_a_rename_redirect_warns_and_names_both_repositories(self):
        # Proceeding silently would be wrong: creating the repository disables
        # the redirect, so links to the old name stop resolving. The operator
        # is told which name is being claimed and what it currently points at.
        result = self._run(
            "branchLeft/ghost-tenant-blog", "branchLeft/ghost-tenant-blog-gcp"
        )
        self.assertIn("::warning::", result.stdout)
        self.assertIn("branchLeft/ghost-tenant-blog-gcp", result.stdout)
        self.assertIn("redirect", result.stdout)

    def test_no_repository_and_no_redirect_proceeds_silently(self):
        # The ordinary new-tenant case: `gh api` 404s, `|| true` yields an
        # empty string, and nothing is printed.
        result = self._run("branchLeft/ghost-tenant-newco", "")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("REACHED THE END", result.stdout)
        self.assertNotIn("::warning::", result.stdout)

    def test_the_comparison_is_exact_rather_than_a_prefix(self):
        # `ghost-tenant-blog` and `ghost-tenant-blog2` are both real tenant
        # names in this estate. A prefix or substring comparison would refuse
        # one because the other exists.
        result = self._run(
            "branchLeft/ghost-tenant-blog", "branchLeft/ghost-tenant-blog2"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("REACHED THE END", result.stdout)

    def test_a_differently_owned_repository_of_the_same_name_does_not_refuse(self):
        # full_name is compared, not name, so someone else's repository with
        # this tenant's slug is not mistaken for ours.
        result = self._run(
            "branchLeft/ghost-tenant-blog", "someoneelse/ghost-tenant-blog"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("REACHED THE END", result.stdout)


class WiringTests(unittest.TestCase):
    """The behavioural tests above execute the block in isolation, so they
    cannot see how `existing_repo` is populated. These read that line."""

    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW.read_text(encoding="utf-8")

    def test_the_value_comes_from_the_api_not_from_gh_repo_view(self):
        # `gh repo view` is the call that follows the redirect. Using it again
        # anywhere for this purpose reintroduces the bug.
        self.assertIn('existing_repo=$(gh api "repos/$TENANT_REPO" --jq .full_name', self.source)
        shell = "\n".join(
            line for line in self.source.splitlines()
            if not line.lstrip().startswith("#")
        )
        self.assertNotIn('gh repo view "$TENANT_REPO"', shell)

    def test_the_lookup_cannot_abort_the_step_on_a_404(self):
        # A new tenant's repository does not exist, so `gh api` exits
        # non-zero. Under this step's `set -e` that would kill the step before
        # the check it feeds -- turning the ordinary case into a hard failure.
        line = next(
            line for line in self.source.splitlines()
            if "existing_repo=$(gh api" in line
        )
        self.assertIn("|| true", line)


if __name__ == "__main__":
    unittest.main()
