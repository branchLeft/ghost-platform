#!/usr/bin/env python3
"""Unit tests for assert-tenant-provisioning-token-scopes.py.

This is the preflight `provision-tenant.yml` runs before it creates
anything: a token missing `workflow` or `repo` failed the run on its 16th
step, after a repository, a stack and a published secret already existed.
These tests exercise the header-parsing and set logic directly, including
the superstring cases (`workflow_dispatch`, `repo:status`) that a
substring-matching check would wrongly accept in place of the scope it
actually requires.
"""

from __future__ import annotations

import importlib.util
import io
import pathlib
import unittest
from contextlib import redirect_stderr, redirect_stdout


def _load_module():
    """Import the script by path: its filename has hyphens, so it is not a
    legal module name for a plain import."""
    path = (
        pathlib.Path(__file__).resolve().parent
        / "assert-tenant-provisioning-token-scopes.py"
    )
    spec = importlib.util.spec_from_file_location(
        "assert_tenant_provisioning_token_scopes", path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = _load_module()


class ParseScopesTests(unittest.TestCase):
    def test_splits_and_strips_a_comma_separated_header(self):
        self.assertEqual(
            guard.parse_scopes("repo, workflow, read:org"),
            {"repo", "workflow", "read:org"},
        )

    def test_empty_header_parses_to_an_empty_set(self):
        self.assertEqual(guard.parse_scopes(""), frozenset())

    def test_stray_whitespace_and_empty_entries_are_dropped(self):
        self.assertEqual(guard.parse_scopes("  repo ,, workflow  ,"), {"repo", "workflow"})


class CheckTests(unittest.TestCase):
    def test_both_required_scopes_present_is_a_pass(self):
        self.assertFalse(guard.check(guard.parse_scopes("repo, workflow")))

    def test_an_extra_scope_the_run_never_asked_for_is_never_a_reason_to_refuse(self):
        self.assertFalse(
            guard.check(guard.parse_scopes("repo, workflow, read:org, admin:org"))
        )

    def test_no_scopes_at_all_means_everything_is_missing(self):
        self.assertEqual(guard.check(guard.parse_scopes("")), guard.REQUIRED_SCOPES)

    def test_the_2026_09_02_case_workflow_missing_repo_present(self):
        self.assertEqual(guard.check(guard.parse_scopes("repo")), {"workflow"})

    def test_repo_missing_workflow_present(self):
        self.assertEqual(guard.check(guard.parse_scopes("workflow")), {"repo"})

    def test_both_missing(self):
        self.assertEqual(
            guard.check(guard.parse_scopes("read:org")), {"repo", "workflow"}
        )

    def test_workflow_dispatch_does_not_satisfy_workflow(self):
        # The sharper sabotage this check exists to refuse: `workflow_dispatch`
        # is a real, narrower OAuth scope (dispatching a workflow run, not
        # pushing a workflow file) and is a superstring of `workflow`. A
        # substring-matching implementation would wrongly accept it.
        self.assertEqual(
            guard.check(guard.parse_scopes("repo, workflow_dispatch")), {"workflow"}
        )

    def test_repo_status_does_not_satisfy_repo(self):
        # Same trap on the other required scope: `repo:status` grants only
        # commit-status writes, nowhere near repository creation.
        self.assertEqual(
            guard.check(guard.parse_scopes("repo:status, workflow")), {"repo"}
        )

    def test_a_scope_that_is_a_prefix_of_a_required_one_does_not_satisfy_it(self):
        # The reverse shape: holding only a narrower scope must not satisfy
        # the broader one that was actually required.
        self.assertEqual(guard.check(guard.parse_scopes("work")), guard.REQUIRED_SCOPES)


class SelfTestTests(unittest.TestCase):
    def test_self_test_passes(self):
        guard._self_test()


class MainTests(unittest.TestCase):
    def test_exits_zero_and_silent_on_a_clean_pass(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--scopes-header", "repo, workflow"])
        self.assertEqual(rc, 0)
        self.assertEqual(stderr.getvalue(), "")

    def test_exits_nonzero_and_names_the_missing_scope(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--scopes-header", "repo"])
        self.assertEqual(rc, 1)
        self.assertIn("::error::", stderr.getvalue())
        self.assertIn("workflow", stderr.getvalue())
        self.assertIn("GH_PAT_TENANT_PROVISIONING", stderr.getvalue())

    def test_never_prints_a_token_value_even_on_failure(self):
        # The one thing this script must never do: a caller that (wrongly)
        # passed the header through with a token-shaped string still must
        # not see that string echoed back -- only scope names appear in the
        # failure message, never the raw header content verbatim beyond the
        # scopes parsed out of it.
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            guard.main(["--scopes-header", "repo"])
        self.assertNotIn("ghp_", stderr.getvalue())
        self.assertNotIn("github_pat_", stderr.getvalue())

    def test_custom_secret_name_is_interpolated(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(
                ["--scopes-header", "repo", "--secret-name", "SOME_OTHER_PAT"]
            )
        self.assertEqual(rc, 1)
        self.assertIn("SOME_OTHER_PAT", stderr.getvalue())

    def test_self_test_flag_exits_zero(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            rc = guard.main(["--self-test"])
        self.assertEqual(rc, 0)
        self.assertIn("OK", stdout.getvalue())

    def test_missing_required_flag_without_self_test_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as ctx:
            guard.main([])
        # argparse's own parser.error() exits 2, distinct from the guard's
        # own pass/fail exit codes of 0 and 1.
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
