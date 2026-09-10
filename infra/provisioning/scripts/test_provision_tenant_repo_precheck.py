#!/usr/bin/env python3
"""Tests for the create-only repository precheck in ../../../.github/
workflows/provision-tenant.yml -- the step that refuses to provision a tenant
whose repository already exists.

That guard is load-bearing: it is what stops an existing tenant's hand-set
stack passphrase being minted over, which would rotate a live stack's
wrapping key without re-wrapping its checkpoint.

It was `gh repo view "$TENANT_REPO"`, which follows a rename redirect.
GitHub keeps a renamed repository's former name pointing at it until
something claims that name, so a tenant whose repository was ever renamed
could not be re-provisioned under its original name -- the check reported a
repository that does not exist. It blocked a real run on 2026-09-10.

**These tests execute the lookup, not just the branching.** An earlier
version injected `existing_repo` directly and asserted that an empty value
proceeds silently. That passed while the code did the opposite: on a 404
`gh api` skips the `--jq` filter and copies the raw JSON error body to
STDOUT (only "gh: Not Found" goes to stderr), so a `|| true` capture set the
variable to that body and every ordinary new-tenant run took the redirect
branch. The fixture asserted a value production never produced, which is the
shape of a test that cannot fail. `gh` is stubbed on PATH here so the real
capture runs, and the stub records that it was called.

The check is inline shell in YAML with no module to import, so this follows
`test_provision_tenant_flow_gate.py`: extract the literal block and execute
it under `bash -e`, which is what a `run:` with no `shell:` gets on a Linux
runner. A textual assertion would be satisfied by a comparison that reads
correctly and behaves differently.

`fail` is a function defined earlier in the same step; the harness stubs it,
so what is under test is the lookup and the branching, not that helper.
"""

from __future__ import annotations

import json
import pathlib
import re
import shlex
import subprocess
import tempfile
import unittest

WORKFLOW = (
    pathlib.Path(__file__).resolve().parents[3]
    / ".github"
    / "workflows"
    / "provision-tenant.yml"
)

# From the lookup through the closing `fi` of the branch it feeds. The lookup
# is inside the extracted region deliberately: it is where the defect above
# lived, and a harness that starts after it cannot see that class of bug.
BLOCK = re.compile(
    r"^(\s*)if existing_repo=\$\(gh api .*?^\1fi\n",
    re.DOTALL | re.MULTILINE,
)

# The step's `run:` body sits at this indentation. The block must be at it and
# not deeper -- see test_the_block_is_not_nested_inside_a_conditional.
EXPECTED_INDENT = 10

# What `gh api` really writes to stdout for a repository that does not exist.
NOT_FOUND_BODY = json.dumps(
    {
        "message": "Not Found",
        "documentation_url": "https://docs.github.com/rest/repos/repos#get-a-repository",
        "status": "404",
    }
)


def extract_block(source: str) -> tuple[str, str]:
    match = BLOCK.search(source)
    if match is None:
        raise AssertionError(
            "the repository precheck block was not found in "
            f"{WORKFLOW}. If it was rewritten, this test must be rewritten "
            "with it -- it must not silently stop testing anything."
        )
    indent = match.group(1)
    dedented = "\n".join(
        line[len(indent):] if line.startswith(indent) else line
        for line in match.group(0).splitlines()
    )
    return dedented, indent


class ExtractionTests(unittest.TestCase):
    """A control case. Without it every behavioural test below would pass
    vacuously against an empty string if the workflow moved or the block was
    rewritten."""

    def test_the_workflow_exists_and_is_the_provisioning_one(self):
        self.assertTrue(WORKFLOW.is_file(), WORKFLOW)
        self.assertIn("name: Provision tenant", WORKFLOW.read_text(encoding="utf-8"))

    def test_the_block_is_found_and_contains_the_lookup(self):
        block, _ = extract_block(WORKFLOW.read_text(encoding="utf-8"))
        self.assertIn("gh api", block)
        self.assertIn("existing_repo", block)

    def test_extraction_raises_rather_than_returning_nothing(self):
        with self.assertRaises(AssertionError):
            extract_block("a workflow with no such block\n")

    def test_the_block_is_not_nested_inside_a_conditional(self):
        # Wrapping the block in `if [ "$TENANT_VISIBILITY" = public ]` would
        # skip the create-only guard for every private tenant, and the
        # extraction alone cannot see it -- the regex anchors `fi` to whatever
        # indentation it found, so a re-indented block extracts and passes
        # every behavioural test below. The indentation is the signal.
        _, indent = extract_block(WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(
            len(indent),
            EXPECTED_INDENT,
            "the precheck is indented more deeply than the step's run body, "
            "which means it now sits inside a conditional and does not run "
            "for every tenant",
        )


class PrecheckBehaviourTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.block, _ = extract_block(WORKFLOW.read_text(encoding="utf-8"))

    def _run(self, tenant_repo: str, *, api_stdout: str, api_exit: int):
        """Execute the real block with `gh` stubbed to a chosen response."""
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))

        marker = tmp / "gh-was-called"
        stub = tmp / "gh"
        stub.write_text(
            "#!/bin/sh\n"
            f"touch {shlex.quote(str(marker))}\n"
            f"printf '%s' {shlex.quote(api_stdout)}\n"
            f"exit {api_exit}\n"
        )
        stub.chmod(0o755)

        script = tmp / "block.sh"
        script.write_text(
            "set -e\n"
            f"PATH={shlex.quote(str(tmp))}:$PATH\n"
            'fail() { echo "FAILED: $*" >&2; exit 1; }\n'
            f"TENANT_REPO={shlex.quote(tenant_repo)}\n"
            + self.block
            + '\necho "REACHED THE END"\n'
        )
        result = subprocess.run(
            ["bash", str(script)], capture_output=True, text=True, timeout=30
        )
        # Control: a stub that was never invoked would make every assertion
        # below a statement about nothing.
        self.assertTrue(marker.exists(), "the gh stub was never called")
        return result

    def test_a_genuinely_existing_repository_still_refuses(self):
        # The guard's original purpose, which must survive the fix.
        r = self._run(
            "branchLeft/ghost-tenant-acme",
            api_stdout="branchLeft/ghost-tenant-acme",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 1)
        self.assertIn("already exists", r.stderr)
        self.assertNotIn("REACHED THE END", r.stdout)

    def test_a_repository_that_does_not_exist_proceeds_silently(self):
        # The ordinary new-tenant case, and the one the previous version of
        # this file got wrong. `gh api` exits non-zero AND prints the error
        # body to stdout; neither may be mistaken for a repository name.
        r = self._run(
            "branchLeft/ghost-tenant-newco",
            api_stdout=NOT_FOUND_BODY,
            api_exit=1,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REACHED THE END", r.stdout)
        self.assertNotIn("::warning::", r.stdout)
        self.assertNotIn("Not Found", r.stdout)

    def test_a_rename_redirect_is_not_treated_as_an_existing_repository(self):
        # The bug this change fixes.
        r = self._run(
            "branchLeft/ghost-tenant-blog",
            api_stdout="branchLeft/ghost-tenant-blog-gcp",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REACHED THE END", r.stdout)

    def test_a_rename_redirect_warns_and_names_both_repositories(self):
        r = self._run(
            "branchLeft/ghost-tenant-blog",
            api_stdout="branchLeft/ghost-tenant-blog-gcp",
            api_exit=0,
        )
        self.assertIn("::warning::", r.stdout)
        self.assertIn("branchLeft/ghost-tenant-blog-gcp", r.stdout)
        self.assertIn("renamed", r.stdout)

    def test_a_case_difference_still_refuses(self):
        # GitHub repository names are case-insensitive, but full_name comes
        # back in the casing the repository was created with. A case-sensitive
        # comparison would read this as a different repository and skip the
        # guard for a repository that genuinely exists.
        r = self._run(
            "branchLeft/ghost-tenant-acme",
            api_stdout="branchLeft/ghost-tenant-Acme",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("already exists", r.stderr)

    def test_a_case_difference_in_the_org_login_still_refuses(self):
        # The org login is hardcoded elsewhere in this workflow. A re-case of
        # it would otherwise degrade the guard to warn-and-proceed for every
        # tenant at once.
        r = self._run(
            "branchleft/ghost-tenant-acme",
            api_stdout="branchLeft/ghost-tenant-acme",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 1, r.stdout)

    def test_the_comparison_is_exact_rather_than_a_prefix(self):
        # `ghost-tenant-blog` and `ghost-tenant-blog2` are both real names in
        # this estate; a prefix comparison would refuse one because the other
        # exists.
        r = self._run(
            "branchLeft/ghost-tenant-blog",
            api_stdout="branchLeft/ghost-tenant-blog2",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REACHED THE END", r.stdout)

    def test_a_differently_owned_repository_of_the_same_name_does_not_refuse(self):
        r = self._run(
            "branchLeft/ghost-tenant-blog",
            api_stdout="someoneelse/ghost-tenant-blog",
            api_exit=0,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REACHED THE END", r.stdout)


class WiringTests(unittest.TestCase):
    """What the extracted block cannot show: that nothing else reintroduces
    the redirect-following lookup."""

    @classmethod
    def setUpClass(cls):
        source = WORKFLOW.read_text(encoding="utf-8")
        cls.source = source
        cls.shell = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )

    def test_the_value_comes_from_the_api(self):
        self.assertIn(
            'existing_repo=$(gh api "repos/$TENANT_REPO" --jq .full_name', self.source
        )

    def test_gh_repo_view_is_not_used_against_the_tenant_repo_in_any_spelling(self):
        # A literal substring assertion missed `gh repo view "${TENANT_REPO}"`,
        # which restores the original bug while every test stayed green.
        pattern = re.compile(r"gh\s+repo\s+view\s+\"?\$\{?TENANT_REPO\}?\"?")
        self.assertIsNone(
            pattern.search(self.shell),
            "gh repo view follows a rename redirect and must not be used to "
            "decide whether the tenant repository exists",
        )

    def test_the_lookup_branches_on_exit_status_not_on_emptiness(self):
        # `|| true` here captures gh's JSON 404 body from stdout, which is
        # never empty -- the defect that made every new-tenant run warn.
        line = next(
            line for line in self.shell.splitlines() if "existing_repo=$(gh api" in line
        )
        self.assertIn("; then :; else", line)
        self.assertNotIn("|| true", line)

    def test_the_comparison_is_case_folded(self):
        self.assertIn("tr '[:upper:]' '[:lower:]'", self.shell)
        self.assertIn('[ "$existing_lower" = "$requested_lower" ]', self.shell)


if __name__ == "__main__":
    unittest.main()
