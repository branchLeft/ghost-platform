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
        self.assertIn("--user-endpoint-status", stderr.getvalue())

    def test_a_dump_with_a_superstring_scope_still_refuses(self):
        path = self._write("x-oauth-scopes: repo, workflow_dispatch\r\n")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = guard.main(["--headers-file", path])
        self.assertEqual(rc, 1)
        self.assertIn("workflow", stderr.getvalue())


class DecidePolicyTests(unittest.TestCase):
    """The whole policy as a matrix. A classic token is judged on its scopes;
    a token with no scopes header is judged on what GET /user answered.

    The case that matters most is the installation token: it looks identical
    to a fine-grained PAT in the headers, and letting it through would mean
    the run proceeds with a credential that cannot create a repository in the
    organization -- the exact late failure this preflight exists to prevent.
    """

    def test_classic_token_with_both_scopes_passes(self):
        self.assertEqual(guard.decide("repo, workflow", "200")[0], 0)

    def test_classic_token_passes_whatever_the_user_endpoint_said(self):
        # A classic token's scopes are authoritative; /user adds nothing.
        for status in ("200", "403", "429", None):
            with self.subTest(status=status):
                self.assertEqual(guard.decide("repo, workflow", status)[0], 0)

    def test_a_passing_classic_token_prints_nothing(self):
        # No annotation at all: this is the fully verified path, and giving
        # it a message would blur it with the unverified one.
        self.assertEqual(guard.decide("repo, workflow", "200")[1], "")

    def test_classic_token_missing_a_scope_is_not_rescued_by_reading_user(self):
        # Regression guard: the unverifiable path must never be reachable for
        # a token that DID publish scopes, or a classic token missing
        # `workflow` would pass by claiming to be unverifiable.
        code, message = guard.decide("repo", "200")
        self.assertEqual(code, 1)
        self.assertIn("missing the OAuth scope(s)", message)
        self.assertIn("workflow", message)

    def test_present_but_empty_header_is_a_classic_token_with_no_scopes(self):
        # "" and None must not be collapsed: an empty header is a knowably
        # broken classic token, not an unverifiable one.
        code, message = guard.decide("", "200")
        self.assertEqual(code, 1)
        self.assertIn("missing the OAuth scope(s)", message)

    def test_a_non_classic_pat_proceeds_under_an_explicit_warning(self):
        code, message = guard.decide(None, "200")
        self.assertEqual(code, 0)
        self.assertTrue(message.startswith("::warning::"))
        # It must say it is unverified. A message that reads like a pass
        # would be worse than the false refusal it replaces.
        self.assertIn("UNVERIFIED", message)

    def test_the_warning_is_a_single_line_so_its_permission_list_survives(self):
        # Workflow commands are line-oriented: a literal newline ends the
        # annotation and everything after it falls out into plain log text --
        # which would drop the entire permission list this message exists to
        # carry. %0A is the escape that renders as a break inside it.
        _, message = guard.decide(None, "200")
        self.assertNotIn("\n", message)
        self.assertIn("%0A", message)

    def test_the_warning_names_every_permission_the_run_needs(self):
        # Each entry pinned, not just the first: this list is the whole of
        # what replaces verification, so an entry silently dropped from it
        # is a permission an operator is never told to grant.
        _, message = guard.decide(None, "200")
        for permission in (
            "Administration",
            "Contents",
            "Workflows",
            "Environments",
            "Secrets and Variables",
            "Pull requests",
        ):
            with self.subTest(permission=permission):
                self.assertIn(permission, message)

    def test_installation_token_is_refused_and_named(self):
        # Both halves matter, and only the first is about safety. A 403 that
        # fell through to the indeterminate branch would still REFUSE -- so
        # asserting the exit code alone passes against a broken diagnosis.
        # It would then tell the operator the answer could not be determined,
        # when 403 determines it exactly, and send them to re-dispatch a run
        # that can never succeed. The message must be the specific one.
        code, message = guard.decide(None, "403")
        self.assertEqual(code, 1)
        self.assertIn("::error::", message)
        self.assertIn("GITHUB_TOKEN", message)
        self.assertNotIn("could not determine", message)

    def test_an_inconclusive_status_is_never_reported_as_an_installation_token(self):
        # A 429 secondary rate limit or a 5xx means the token may be
        # perfectly good. Telling the operator to replace it is the same
        # class of harm this script was rewritten to stop causing.
        for status in ("401", "429", "500", "502", "418"):
            with self.subTest(status=status):
                code, message = guard.decide(None, status)
                self.assertEqual(code, 1)
                self.assertIn("could not determine", message)
                self.assertIn(status, message)
                self.assertNotIn("is one) is the case this matches", message)

    def test_absent_status_stays_fail_closed(self):
        # An un-updated caller must not accidentally take the passing path.
        for status in (None, "", "   "):
            with self.subTest(status=status):
                code, message = guard.decide(None, status)
                self.assertEqual(code, 1)
                self.assertIn("--user-endpoint-status", message)


class MainStatusTests(unittest.TestCase):
    def _write(self, body):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        )
        handle.write(body)
        handle.close()
        self.addCleanup(lambda: pathlib.Path(handle.name).unlink(missing_ok=True))
        return handle.name

    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = guard.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_non_classic_pat_dump_with_200_passes_and_warns_on_stdout(self):
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n")
        rc, out, err = self._run(
            ["--headers-file", path, "--user-endpoint-status", "200"]
        )
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertIn("::warning::", out)

    def test_installation_token_dump_with_403_refuses(self):
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n")
        rc, _, err = self._run(
            ["--headers-file", path, "--user-endpoint-status", "403"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("installation token", err)

    def test_a_rate_limited_probe_refuses_without_blaming_the_token(self):
        path = self._write("HTTP/2 200 \r\ndate: Wed, 03 Sep 2026\r\n")
        rc, _, err = self._run(
            ["--headers-file", path, "--user-endpoint-status", "429"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("could not determine", err)
        self.assertNotIn("Set GH_PAT_TENANT_PROVISIONING", err)

    def test_the_cli_accepts_an_arbitrary_status_string(self):
        # No argparse `choices` here on purpose: an unexpected status must
        # reach decide() and be refused as indeterminate, not rejected by the
        # parser with exit 2, which would look like a usage error rather than
        # a refusal.
        path = self._write("HTTP/2 200 \r\n")
        rc, _, err = self._run(
            ["--headers-file", path, "--user-endpoint-status", "418"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("could not determine", err)


class WorkflowWiringTests(unittest.TestCase):
    """The discrimination is only a control if the workflow actually performs
    it, and that half lives as inline shell in the YAML with no module to
    import.

    An adversarial review deleted the whole `gh api user` block from
    provision-tenant.yml and every test in this repository stayed green: an
    installation token would have passed the preflight with nothing red. The
    script tests below cannot see that, by construction. These can.
    """

    WORKFLOW = (
        pathlib.Path(__file__).resolve().parents[3]
        / ".github"
        / "workflows"
        / "provision-tenant.yml"
    )

    @classmethod
    def setUpClass(cls):
        cls.source = cls.WORKFLOW.read_text(encoding="utf-8")

    def test_the_workflow_file_is_where_this_test_expects(self):
        # A control case: without it, a moved or renamed workflow would make
        # every assertion below vacuously pass against an empty string.
        self.assertTrue(self.WORKFLOW.is_file(), self.WORKFLOW)
        self.assertIn("name: Provision tenant", self.source)

    def test_the_preflight_probes_the_user_endpoint(self):
        self.assertIn("gh api user --include --silent", self.source)

    def test_the_probe_captures_a_status_rather_than_an_exit_code(self):
        # `if gh api user; then` would collapse 403 with 401, 429 and 5xx,
        # and the refusal would then misname a rate-limited good token an
        # installation token.
        self.assertIn("user_status=$(awk", self.source)
        # Comment lines stripped first: this file's own comments explain the
        # `if gh api user` shape they forbid, and matching prose instead of
        # shell would make this assertion unfixable rather than strict.
        shell = "\n".join(
            line
            for line in self.source.splitlines()
            if not line.lstrip().startswith("#")
        )
        self.assertNotIn("if gh api user", shell)

    def test_the_captured_status_is_passed_to_the_guard(self):
        self.assertIn('--user-endpoint-status "$user_status"', self.source)

    def test_the_probe_and_the_guard_call_are_in_the_same_run_block(self):
        # Passing $user_status from a different step would expand to empty
        # under the shell, which refuses -- fail-closed, but for a reason no
        # message explains. They must be adjacent.
        probe = self.source.index("gh api user --include --silent")
        guard_call = self.source.index('--user-endpoint-status "$user_status"')
        self.assertLess(probe, guard_call)
        between = self.source[probe:guard_call]
        self.assertNotIn("- name:", between)

    def test_the_probe_cannot_abort_the_step_it_measures(self):
        # The step runs under `set -euo pipefail`; a non-2xx `gh api` exits
        # non-zero, and without `|| true` that would kill the step before the
        # refusal it exists to produce.
        probe_line = next(
            line
            for line in self.source.splitlines()
            if "gh api user --include --silent" in line
        )
        self.assertIn("|| true", probe_line)


if __name__ == "__main__":
    unittest.main()
