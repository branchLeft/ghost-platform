"""Tests for the two scripts that hand the tenant its own state backend and
credential: render-tenant-state-backend.py and
receive-minted-state-credential.py. Values are made up; nothing is a real bucket."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def _load(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backend = _load("render-tenant-state-backend.py", "render_tenant_state_backend")
receive = _load("receive-minted-state-credential.py", "receive_minted_state_credential")

PREFIX = "q7f3k9x2m4n8p1r5t6v0w3y8z1"
GOOD = {
    "STATE_GATEWAY_BUCKET": "example-state-shard",
    "STATE_GATEWAY_REGION": "example-1",
    "TENANT_STATE_PREFIX": PREFIX,
    "TENANT": "acme-blog",
    "TENANT_REPO_NAME": "ghost-tenant-acme-blog",
}


def call(module, env: dict[str, str]) -> tuple[int, str, str]:
    """Run a script's main with a scratch $GITHUB_ENV; return (code, stderr+stdout, file text)."""
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "github_env"
        path.write_text("", encoding="utf-8")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = module.main(env, str(path))
        return code, out.getvalue(), path.read_text(encoding="utf-8")


class TheBackendUrl(unittest.TestCase):
    def test_it_is_the_gateway_url_with_the_tenants_own_prefix(self):
        code, out, written = call(backend, GOOD)
        self.assertEqual(code, 0, out)
        self.assertIn(
            f"TENANT_BACKEND_URL=s3://example-state-shard/{PREFIX}"
            "?endpoint=https://state.branchleft.co.uk&s3ForcePathStyle=true&region=example-1\n",
            written,
        )
        self.assertEqual(out, "")

    def test_each_bad_field_is_refused_by_name_and_the_value_is_not_printed(self):
        cases = {
            "STATE_GATEWAY_BUCKET": ["", "branchleft-pulumi-state", "Has Space", "../x"],
            "STATE_GATEWAY_REGION": ["", "x", "has space"],
            "TENANT_STATE_PREFIX": ["", "short", "acme-blog-" + "a" * 20, "UPPERCASEUPPERCASEUPPERCASE", "a/" + "b" * 30],
        }
        for variable, values in cases.items():
            for value in values:
                with self.subTest(variable=variable, value=value):
                    code, out, written = call(backend, {**GOOD, variable: value})
                    self.assertEqual(code, 1, out)
                    self.assertEqual(written, "")
                    expected = "state_prefix" if variable == "TENANT_STATE_PREFIX" else variable
                    self.assertIn(expected, out)
                    if len(value) > 6:
                        self.assertNotIn(value, out)

    def test_a_prefix_that_contains_the_slug_is_refused(self):
        code, out, _ = call(backend, {**GOOD, "TENANT_STATE_PREFIX": "xx-acme-blog-" + "9" * 12})
        self.assertEqual(code, 1)
        self.assertIn("state_prefix", out)

    def test_the_endpoint_is_never_taken_from_the_environment(self):
        code, _, written = call(backend, {**GOOD, "STATE_GATEWAY_ENDPOINT": "https://elsewhere.example"})
        self.assertEqual(code, 0)
        self.assertNotIn("elsewhere", written)


class TheMintedCredential(unittest.TestCase):
    PAIR = {"MINTED_STATE_ACCESS_KEY_ID": "AKIDEXAMPLE0001", "MINTED_STATE_SECRET_ACCESS_KEY": "secret-example-value-0002"}

    def test_a_delivered_pair_is_masked_first_and_handed_on_under_the_tenants_names(self):
        code, out, written = call(receive, dict(self.PAIR))
        self.assertEqual(code, 0, out)
        lines = out.splitlines()
        self.assertEqual(lines, [f"::add-mask::{v}" for v in self.PAIR.values()])
        self.assertEqual(
            written.splitlines(),
            ["STATE_GATEWAY_ACCESS_KEY_ID=AKIDEXAMPLE0001", "STATE_GATEWAY_SECRET_ACCESS_KEY=secret-example-value-0002"],
        )

    def test_an_absent_pair_fails_closed_with_a_loud_error_and_writes_nothing(self):
        code, out, written = call(receive, {})
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)
        self.assertIn("has not been delivered", out)
        self.assertIn("MINTED_STATE_ACCESS_KEY_ID", out)
        self.assertEqual(written, "")

    def test_half_a_pair_or_blank_values_are_refused(self):
        for label, env in (
            ("only the id", {"MINTED_STATE_ACCESS_KEY_ID": "AKIDEXAMPLE0001"}),
            ("only the secret", {"MINTED_STATE_SECRET_ACCESS_KEY": "secret-example-value-0002"}),
            ("blank", {**self.PAIR, "MINTED_STATE_SECRET_ACCESS_KEY": " \t "}),
        ):
            with self.subTest(label):
                code, out, written = call(receive, env)
                self.assertEqual(code, 1, out)
                self.assertEqual(written, "")

    def test_there_is_no_fallback_to_any_other_key(self):
        shared = {
            "AWS_ACCESS_KEY_ID": "SHAREDEXAMPLE001",
            "AWS_SECRET_ACCESS_KEY": "shared-example-secret-002",
            "HETZNER_S3_ACCESS_KEY_ID": "SHAREDEXAMPLE001",
            "TENANT_STATE_S3_ACCESS_KEY_ID": "SHAREDEXAMPLE001",
            "STATE_GATEWAY_ACCESS_KEY_ID": "SHAREDEXAMPLE001",
        }
        code, out, written = call(receive, shared)
        self.assertEqual(code, 1)
        self.assertEqual(written, "")
        self.assertNotIn("SHAREDEXAMPLE001", out)

    def test_a_value_that_could_add_a_line_to_the_env_file_is_refused(self):
        env = {**self.PAIR, "MINTED_STATE_SECRET_ACCESS_KEY": "abcdefgh\nINJECTED=1"}
        code, out, written = call(receive, env)
        self.assertEqual(code, 1)
        self.assertEqual(written, "")
        self.assertNotIn("INJECTED", out)


if __name__ == "__main__":
    unittest.main()
