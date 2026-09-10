#!/usr/bin/env python3
"""Unit tests for assert-tenant-provisioning-token-scopes.py.

This is the preflight `provision-tenant.yml` runs before it creates
anything: a token missing `workflow` or `repo` fails the run on whichever
later step needs it, after a repository, a stack and a published secret
already exist. These tests exercise the header-extraction and set logic
directly, including the superstring cases (`workflow_dispatch`,
`repo:status`) that a substring-matching check would wrongly accept in
place of the scope it actually requires, and the header-absent case that
must refuse rather than abort.
"""

from __future__ import annotations

import importlib.util
import io
import pathlib
import tempfile
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


class ExtractScopesHeaderTests(unittest.TestCase):
    """The part of this check that a shell `grep | sed | tr` pipeline used
    to do, untested, inside the workflow itself -- including the one path
    that pipeline aborted on instead of refusing: the header entirely
    absent, under `set -o pipefail`."""

    def test_extracts_the_value_from_an_ordinary_header_dump(self):
        dump = (
            "HTTP/2 200 \r\n"
            "date: Wed, 03 Sep 2026 12:00:00 GMT\r\n"
            "x-oauth-scopes: repo, workflow\r\n"
            "x-ratelimit-limit: 5000\r\n"
        )
        self.assertEqual(guard.extract_scopes_header(dump), "repo, workflow")

    def test_matches_case_insensitively(self):
        self.assertEqual(
            guard.extract_scopes_header("X-OAuth-Scopes: repo, workflow\r\n"),
            "repo, workflow",
        )

    def test_header_entirely_absent_returns_none_not_an_exception(self):
        # The bug this test exists to pin: a shell pipeline built on `grep`
        # aborts under `pipefail` when nothing matches. This must not raise.
        # It returns None rather than "" so the caller can tell "not a
        # classic token" from "a classic token holding no scopes" -- two
        # facts that were indistinguishable until a fine-grained PAT was
        # refused as though it were the latter.
        dump = "HTTP/2 200 \r\ndate: Wed, 03 Sep 2026 12:00:00 GMT\r\n"
        self.assertIsNone(guard.extract_scopes_header(dump))

    def test_header_present_but_empty_also_returns_empty_string(self):
        self.assertEqual(guard.extract_scopes_header("x-oauth-scopes:\r\n"), "")

    def test_a_header_value_containing_its_own_colon_is_not_mistaken_for_it(self):
        self.assertIsNone(
            guard.extract_scopes_header("date: Wed, 03 Sep 2026 12:00:00 GMT\r\n")
        )

    def test_no_headers_at_all_returns_none(self):
        self.assertIsNone(guard.extract_scopes_header(""))

    def test_space_after_comma_separation_survives_extraction_and_parsing(self):
        dump = "x-oauth-scopes: repo,  workflow\r\n"
        header = guard.extract_scopes_header(dump)
        self.assertEqual(guard.parse_scopes(header), {"repo", "workflow"})


class CheckTests(unittest.TestCase):
    def test_both_required_scopes_present_is_a_pass(self):
        self.assertFalse(guard.check(guard.parse_scopes("repo, workflow")))

    def test_an_extra_scope_the_run_never_asked_for_is_never_a_reason_to_refuse(self):
        self.assertFalse(
            guard.check(guard.parse_scopes("repo, workflow, read:org, admin:org"))
        )

    def test_no_scopes_at_all_means_everything_is_missing(self):
        self.assertEqual(guard.check(guard.parse_scopes("")), guard.REQUIRED_SCOPES)

    def test_workflow_missing_with_repo_present_is_refused(self):
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


class MainHeadersFileTests(unittest.TestCase):
    """The end-to-end path the workflow actually uses: a raw response dump
    on disk, never a pre-extracted string handed in on the command line."""

    def _write(self, content: str) -> str:
        handle = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        )
        handle.write(content)
        handle.close()
        return handle.name

    def test_a_clean_dump_with_both_scopes_passes(self):
        path = self._write("HTTP/2 200 \r\nx-oauth-scopes: repo, workflow\r\n")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--headers-file", path])
        self.assertEqual(rc, 0)
        self.assertEqual(stderr.getvalue(), "")

    def test_a_dump_with_the_header_entirely_absent_refuses_by_name(self):
        # The exact case the workflow's shell pipeline used to abort on
        # silently instead of reaching this message.
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026 12:00:00 GMT\r\n")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--headers-file", path])
        self.assertEqual(rc, 1)
        self.assertIn("::error::", stderr.getvalue())
        self.assertIn("GH_PAT_TENANT_PROVISIONING", stderr.getvalue())
        # Fail-closed without the new flag: an absent header alone still
        # refuses, and says which flag would let it decide, rather than
        # reporting scopes it never actually read.
        self.assertIn("--token-reads-user-endpoint", stderr.getvalue())

    def test_a_dump_with_a_superstring_scope_still_refuses(self):
        path = self._write("x-oauth-scopes: repo, workflow_dispatch\r\n")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--headers-file", path])
        self.assertEqual(rc, 1)
        self.assertIn("workflow", stderr.getvalue())


class DecidePolicyTests(unittest.TestCase):
    """The whole policy as a matrix. A classic token is judged on its scopes;
    a token with no scopes header is judged on whether it is a PAT at all.

    The case that matters most is the installation token: it looks identical
    to a fine-grained PAT in the headers, and letting it through would mean
    the run proceeds with a credential that cannot create a repository in the
    organization -- the exact late failure this preflight exists to prevent.
    """

    def test_classic_token_with_both_scopes_passes(self):
        code, _ = guard.decide("repo, workflow", True)
        self.assertEqual(code, 0)

    def test_classic_token_passes_regardless_of_the_user_endpoint_answer(self):
        # A classic token's scopes are authoritative; /user adds nothing.
        for reads_user in (True, False, None):
            with self.subTest(reads_user=reads_user):
                self.assertEqual(guard.decide("repo, workflow", reads_user)[0], 0)

    def test_classic_token_missing_a_scope_is_not_rescued_by_reading_user(self):
        # Regression guard: the fine-grained path must never be reachable for
        # a token that DID publish scopes, or a classic token missing
        # `workflow` would pass by claiming to be unverifiable.
        code, message = guard.decide("repo", True)
        self.assertEqual(code, 1)
        self.assertIn("missing the OAuth scope(s)", message)
        self.assertIn("workflow", message)

    def test_present_but_empty_header_is_a_classic_token_with_no_scopes(self):
        # "" and None must not be collapsed: an empty header is a knowably
        # broken classic token, not an unverifiable one.
        code, message = guard.decide("", True)
        self.assertEqual(code, 1)
        self.assertIn("missing the OAuth scope(s)", message)

    def test_fine_grained_token_proceeds_with_an_explicit_notice(self):
        code, message = guard.decide(None, True)
        self.assertEqual(code, 0)
        self.assertIn("::notice::", message)
        # It must say it is unverified. A notice that reads like a pass would
        # be worse than the false refusal it replaces.
        self.assertIn("unverified", message)
        self.assertIn("Administration", message)

    def test_installation_token_is_refused(self):
        code, message = guard.decide(None, False)
        self.assertEqual(code, 1)
        self.assertIn("::error::", message)
        self.assertIn("installation token", message)

    def test_absent_header_without_a_user_answer_stays_fail_closed(self):
        # An un-updated caller must not accidentally take the passing path.
        code, message = guard.decide(None, None)
        self.assertEqual(code, 1)
        self.assertIn("--token-reads-user-endpoint", message)


class MainTristateTests(unittest.TestCase):
    def _write(self, body):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        )
        handle.write(body)
        handle.close()
        self.addCleanup(lambda: pathlib.Path(handle.name).unlink(missing_ok=True))
        return handle.name

    def test_fine_grained_dump_with_yes_passes_and_prints_the_notice(self):
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = guard.main(
                ["--headers-file", path, "--token-reads-user-endpoint", "yes"]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(err.getvalue(), "")
        self.assertIn("::notice::", out.getvalue())

    def test_installation_token_dump_with_no_refuses(self):
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n")
        err = io.StringIO()
        with redirect_stderr(err):
            rc = guard.main(
                ["--headers-file", path, "--token-reads-user-endpoint", "no"]
            )
        self.assertEqual(rc, 1)
        self.assertIn("installation token", err.getvalue())

    def test_each_accepted_spelling_of_the_flag_is_understood(self):
        for yes, no in (("yes", "no"), ("true", "false"), ("1", "0")):
            with self.subTest(spelling=yes):
                self.assertIs(guard._parse_tristate(yes), True)
                self.assertIs(guard._parse_tristate(no), False)
        self.assertIsNone(guard._parse_tristate(None))

    def test_an_unrecognised_flag_value_raises_rather_than_defaulting(self):
        # Defaulting an unknown value to either answer would silently pick a
        # policy branch. argparse `choices` blocks this at the CLI; this pins
        # the parser itself so the two cannot drift apart.
        with self.assertRaises(ValueError):
            guard._parse_tristate("maybe")


if __name__ == "__main__":
    unittest.main()
