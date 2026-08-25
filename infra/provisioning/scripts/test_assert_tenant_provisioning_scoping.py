#!/usr/bin/env python3
"""Unit tests for assert-tenant-provisioning-scoping.py.

This is the credential-scoping guard `provision-tenant.yml` runs before it
creates anything. branchLeft/workspace#284 found it because the guard's
required set and `infra-hosts-ci.yml`'s own repository-level secret used to
be the same two names, so no configuration could ever pass both workflows'
demands. These tests exercise the set logic directly -- missing, shadowed,
both, and the specific case the rename exists to make possible -- and the
CLI's file-reading and exit-code contract, without any network access.
"""

from __future__ import annotations

import importlib.util
import io
import os
import pathlib
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch


def _load_module():
    """Import the script by path: its filename has hyphens, so it is not a
    legal module name for a plain import."""
    path = pathlib.Path(__file__).resolve().parent / "assert-tenant-provisioning-scoping.py"
    spec = importlib.util.spec_from_file_location("assert_tenant_provisioning_scoping", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = _load_module()


class CheckTests(unittest.TestCase):
    def test_the_case_the_rename_exists_to_make_possible(self):
        # HETZNER_S3_* genuinely need to live at the repository level for
        # infra-hosts-ci.yml. Before the rename, the required set named the
        # same two strings, so this configuration could never pass -- that
        # was the whole conflict in branchLeft/workspace#284.
        missing, shadowed = guard.check(
            environment_names=[
                "GH_PAT_TENANT_PROVISIONING",
                "TENANT_STATE_S3_ACCESS_KEY_ID",
                "TENANT_STATE_S3_SECRET_ACCESS_KEY",
            ],
            repository_names=["HETZNER_S3_ACCESS_KEY_ID", "HETZNER_S3_SECRET_ACCESS_KEY"],
        )
        self.assertFalse(missing)
        self.assertFalse(shadowed)

    def test_all_required_secrets_missing(self):
        missing, shadowed = guard.check(environment_names=[], repository_names=[])
        self.assertEqual(missing, guard.REQUIRED_SECRETS)
        self.assertFalse(shadowed)

    def test_one_required_secret_missing(self):
        missing, shadowed = guard.check(
            environment_names=["GH_PAT_TENANT_PROVISIONING", "TENANT_STATE_S3_ACCESS_KEY_ID"],
            repository_names=[],
        )
        self.assertEqual(missing, {"TENANT_STATE_S3_SECRET_ACCESS_KEY"})
        self.assertFalse(shadowed)

    def test_shadowed_even_though_present_in_the_environment(self):
        # Present is not the whole story: `secrets.X` would still resolve the
        # repository copy for a run this environment never gated.
        missing, shadowed = guard.check(
            environment_names=[
                "GH_PAT_TENANT_PROVISIONING",
                "TENANT_STATE_S3_ACCESS_KEY_ID",
                "TENANT_STATE_S3_SECRET_ACCESS_KEY",
            ],
            repository_names=["TENANT_STATE_S3_ACCESS_KEY_ID"],
        )
        self.assertFalse(missing)
        self.assertEqual(shadowed, {"TENANT_STATE_S3_ACCESS_KEY_ID"})

    def test_missing_and_shadowed_can_both_fire_at_once(self):
        # Scoped for one secret, never touched for the other two, one of
        # which also has a stale repository-level copy -- nothing about the
        # two checks is mutually exclusive.
        missing, shadowed = guard.check(
            environment_names=["GH_PAT_TENANT_PROVISIONING"],
            repository_names=["TENANT_STATE_S3_ACCESS_KEY_ID"],
        )
        self.assertEqual(
            missing, {"TENANT_STATE_S3_ACCESS_KEY_ID", "TENANT_STATE_S3_SECRET_ACCESS_KEY"}
        )
        self.assertEqual(shadowed, {"TENANT_STATE_S3_ACCESS_KEY_ID"})

    def test_an_unrelated_repository_secret_is_never_a_shadow(self):
        missing, shadowed = guard.check(
            environment_names=[
                "GH_PAT_TENANT_PROVISIONING",
                "TENANT_STATE_S3_ACCESS_KEY_ID",
                "TENANT_STATE_S3_SECRET_ACCESS_KEY",
            ],
            repository_names=["SOME_OTHER_SECRET", "HCLOUD_TOKEN_ESTATE"],
        )
        self.assertFalse(missing)
        self.assertFalse(shadowed)


class SelfTestTests(unittest.TestCase):
    def test_self_test_passes(self):
        # Calling the module's own self-test is what the workflow step and
        # `infra-platform-ci.yml`'s coverage check both do; a bare call
        # raising means the logic has drifted from what it claims to prove.
        guard._self_test()


class MainTests(unittest.TestCase):
    def _write(self, directory: pathlib.Path, name: str, names: list[str]) -> str:
        path = directory / name
        path.write_text("\n".join(names) + ("\n" if names else ""))
        return str(path)

    def test_exits_zero_and_silent_on_a_clean_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            env_file = self._write(
                directory,
                "env.txt",
                [
                    "GH_PAT_TENANT_PROVISIONING",
                    "TENANT_STATE_S3_ACCESS_KEY_ID",
                    "TENANT_STATE_S3_SECRET_ACCESS_KEY",
                ],
            )
            repo_file = self._write(
                directory, "repo.txt", ["HETZNER_S3_ACCESS_KEY_ID", "HETZNER_S3_SECRET_ACCESS_KEY"]
            )
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                rc = guard.main(["--environment-secrets", env_file, "--repository-secrets", repo_file])
        self.assertEqual(rc, 0)
        self.assertEqual(stderr.getvalue(), "")

    def test_exits_nonzero_and_reports_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            env_file = self._write(directory, "env.txt", [])
            repo_file = self._write(directory, "repo.txt", [])
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                rc = guard.main(["--environment-secrets", env_file, "--repository-secrets", repo_file])
        self.assertEqual(rc, 1)
        self.assertIn("::error::", stderr.getvalue())
        self.assertIn("not scoped to the tenant-provisioning environment", stderr.getvalue())

    def test_exits_nonzero_and_reports_shadowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            env_file = self._write(
                directory,
                "env.txt",
                [
                    "GH_PAT_TENANT_PROVISIONING",
                    "TENANT_STATE_S3_ACCESS_KEY_ID",
                    "TENANT_STATE_S3_SECRET_ACCESS_KEY",
                ],
            )
            repo_file = self._write(directory, "repo.txt", ["TENANT_STATE_S3_ACCESS_KEY_ID"])
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                rc = guard.main(["--environment-secrets", env_file, "--repository-secrets", repo_file])
        self.assertEqual(rc, 1)
        self.assertIn("still exist at the repository level", stderr.getvalue())

    def test_self_test_flag_exits_zero(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            rc = guard.main(["--self-test"])
        self.assertEqual(rc, 0)
        self.assertIn("OK", stdout.getvalue())

    def test_missing_required_flags_without_self_test_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as ctx:
            guard.main([])
        # argparse's own parser.error() exits 2, distinct from the guard's
        # own pass/fail exit codes of 0 and 1.
        self.assertEqual(ctx.exception.code, 2)


class MessageFunctionsTests(unittest.TestCase):
    # The regression this class exists to catch: an earlier draft printed the
    # literal string `<owner>/<repo>` in every failure message, which errors
    # if an operator pastes it straight out of a failed run's log -- exactly
    # when nobody wants to be reconstructing the command by hand.
    def test_missing_message_interpolates_the_given_repo(self):
        message = guard._missing_message(frozenset({"GH_PAT_TENANT_PROVISIONING"}), "acme/widgets")
        self.assertIn("gh secret set <NAME> --repo acme/widgets --env tenant-provisioning", message)

    def test_shadowed_message_interpolates_the_given_repo(self):
        message = guard._shadowed_message(frozenset({"TENANT_STATE_S3_ACCESS_KEY_ID"}), "acme/widgets")
        self.assertIn("gh secret delete <NAME> --repo acme/widgets", message)


class RepoInterpolationTests(unittest.TestCase):
    """`main`'s --repo resolution: explicit flag, then $GITHUB_REPOSITORY --
    which the Actions runner always sets during a real workflow run -- and
    only the placeholder when neither is available."""

    def _write(self, directory: pathlib.Path, name: str, names: list[str]) -> str:
        path = directory / name
        path.write_text("\n".join(names) + ("\n" if names else ""))
        return str(path)

    def _run_and_capture(self, extra_args: list[str]) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            env_file = self._write(directory, "env.txt", [])
            repo_file = self._write(directory, "repo.txt", [])
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                rc = guard.main(
                    ["--environment-secrets", env_file, "--repository-secrets", repo_file]
                    + extra_args
                )
            return rc, stderr.getvalue()

    def test_explicit_repo_flag_is_interpolated(self):
        with patch.dict(os.environ, {}, clear=True):
            rc, stderr = self._run_and_capture(["--repo", "acme/widgets"])
        self.assertEqual(rc, 1)
        self.assertIn("--repo acme/widgets --env tenant-provisioning", stderr)

    def test_github_repository_env_var_is_used_with_no_explicit_flag(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "branchLeft/ghost-platform"}):
            rc, stderr = self._run_and_capture([])
        self.assertEqual(rc, 1)
        self.assertIn("--repo branchLeft/ghost-platform --env tenant-provisioning", stderr)

    def test_falls_back_to_the_placeholder_when_neither_is_set(self):
        with patch.dict(os.environ, {}, clear=True):
            rc, stderr = self._run_and_capture([])
        self.assertEqual(rc, 1)
        self.assertIn(f"--repo {guard.REPO_PLACEHOLDER} --env tenant-provisioning", stderr)

    def test_explicit_repo_flag_overrides_the_environment_variable(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "wrong/repo"}):
            rc, stderr = self._run_and_capture(["--repo", "acme/widgets"])
        self.assertEqual(rc, 1)
        self.assertIn("--repo acme/widgets", stderr)
        self.assertNotIn("wrong/repo", stderr)


if __name__ == "__main__":
    unittest.main()
