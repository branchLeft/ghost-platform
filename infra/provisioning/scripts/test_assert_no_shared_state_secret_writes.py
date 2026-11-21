"""Tests for assert-no-shared-state-secret-writes.py: the seeded fixture is red,
the real workflow is green, and the line parser handles the shapes the real
workflow uses (continuations, comments)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REAL_WORKFLOW = HERE.parents[2] / ".github" / "workflows" / "provision-tenant.yml"


def _load():
    spec = importlib.util.spec_from_file_location("assert_no_shared_state_secret_writes", HERE / "assert-no-shared-state-secret-writes.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check = _load()


def run(*argv: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = check.main(list(argv))
    return code, out.getvalue()


class TheControl(unittest.TestCase):
    def test_the_seeded_fixture_is_red_and_names_each_write(self):
        code, out = run(str(check.SEEDED_FIXTURE))
        self.assertEqual(code, 1, out)
        self.assertIn("writes: HETZNER_S3_ACCESS_KEY_ID", out)
        self.assertIn("writes: TENANT_STATE_S3_SECRET_ACCESS_KEY", out)

    def test_the_real_provisioning_workflow_is_green(self):
        code, out = run(str(REAL_WORKFLOW))
        self.assertEqual(code, 0, out)

    def test_the_self_test_passes(self):
        code, _ = run("--self-test")
        self.assertEqual(code, 0)


class TheScan(unittest.TestCase):
    def test_a_continued_write_is_one_line_and_is_found(self):
        text = "run: |\n  printf '%s' \"$X\" \\\n    | gh secret set HETZNER_S3_SECRET_ACCESS_KEY --repo r\n"
        found = check.scan("f", text)
        self.assertEqual([(f.kind, f.name) for f in found], [("writes", "HETZNER_S3_SECRET_ACCESS_KEY")])

    def test_a_write_through_the_api_is_a_write(self):
        text = "run: gh api -X PUT repos/o/r/actions/secrets/TENANT_STATE_S3_ACCESS_KEY_ID\n"
        self.assertEqual([f.kind for f in check.scan("f", text)], ["writes"])

    def test_a_comment_may_name_the_old_pair(self):
        self.assertEqual(check.scan("f", "      # HETZNER_S3_ACCESS_KEY_ID is retired\n"), [])

    def test_a_read_of_the_old_secret_is_a_mention(self):
        text = "env:\n  K: ${{ secrets.TENANT_STATE_S3_ACCESS_KEY_ID }}\n"
        self.assertEqual([f.kind for f in check.scan("f", text)], ["mentions"])

    def test_the_tenants_own_name_is_not_flagged(self):
        text = "run: printf x | gh secret set STATE_GATEWAY_ACCESS_KEY_ID --repo r --env production\n"
        self.assertEqual(check.scan("f", text), [])

    def test_a_write_whose_name_is_a_variable_is_refused_because_it_cannot_be_read(self):
        text = 'run: printf x | gh secret set "$NAME" --repo r\n'
        self.assertEqual(len(check.scan("f", text)), 1)


class TheSpellingsGitHubTreatsAsTheSameSecret(unittest.TestCase):
    """GitHub secret names are not case-sensitive, so a lower- or mixed-case
    spelling of the shared pair reads or writes the same secret. Each spelling
    is its own test, and each reports the canonical upper-case name."""

    def _kinds_and_names(self, text: str) -> list[tuple[str, str]]:
        return [(f.kind, f.name) for f in check.scan("f", text)]

    def test_a_lower_case_api_put_of_the_access_key_is_a_write(self):
        text = "run: gh api -X PUT repos/o/r/environments/production/secrets/hetzner_s3_access_key_id\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "HETZNER_S3_ACCESS_KEY_ID")])

    def test_a_lower_case_api_put_of_the_provisioning_jobs_name_is_a_write(self):
        text = "run: gh api --method PUT repos/o/r/actions/secrets/tenant_state_s3_access_key_id\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "TENANT_STATE_S3_ACCESS_KEY_ID")])

    def test_a_mixed_case_api_put_with_the_path_first_is_a_write(self):
        text = "run: gh api repos/o/r/actions/secrets/Hetzner_S3_Secret_Access_Key -X PUT\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "HETZNER_S3_SECRET_ACCESS_KEY")])

    def test_a_lower_case_method_word_does_not_hide_an_api_write(self):
        text = "run: gh api -X put repos/o/r/actions/secrets/hetzner_s3_access_key_id\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "HETZNER_S3_ACCESS_KEY_ID")])

    def test_a_lower_case_secret_read_is_a_mention(self):
        text = "env:\n  K: ${{ secrets.hetzner_s3_access_key_id }}\n"
        self.assertEqual(self._kinds_and_names(text), [("mentions", "HETZNER_S3_ACCESS_KEY_ID")])

    def test_a_mixed_case_secret_read_is_a_mention(self):
        text = "env:\n  K: ${{ secrets.Tenant_State_S3_Access_Key_Id }}\n"
        self.assertEqual(self._kinds_and_names(text), [("mentions", "TENANT_STATE_S3_ACCESS_KEY_ID")])

    def test_a_lower_case_name_on_a_secret_set_line_is_a_write(self):
        text = "run: printf x | gh secret set hetzner_s3_secret_access_key --repo r\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "HETZNER_S3_SECRET_ACCESS_KEY")])

    def test_a_mixed_case_name_on_a_secret_set_line_is_a_write(self):
        text = "run: printf x | gh secret set Tenant_State_S3_Secret_Access_Key --repo r\n"
        self.assertEqual(self._kinds_and_names(text), [("writes", "TENANT_STATE_S3_SECRET_ACCESS_KEY")])

    def test_a_lower_case_name_in_a_comment_is_still_allowed(self):
        self.assertEqual(check.scan("f", "      # hetzner_s3_access_key_id is retired\n"), [])

    def test_the_tenants_own_name_in_lower_case_is_not_flagged(self):
        text = "run: gh api -X PUT repos/o/r/environments/production/secrets/state_gateway_access_key_id\n"
        self.assertEqual(self._kinds_and_names(text), [])


if __name__ == "__main__":
    unittest.main()
