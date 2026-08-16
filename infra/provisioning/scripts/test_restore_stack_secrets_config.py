#!/usr/bin/env python3
"""Unit tests for restore-stack-secrets-config.

This script writes the one file that tells Pulumi how to reach a stack's
data key, from an export that a run of this workflow does not otherwise
control the shape of. A wrong-but-plausible restore doesn't fail loudly
here -- it fails later, opaquely, inside whatever `pulumi` command reads the
file next, or worse, it writes something a job holding project-admin-
equivalent GCP credentials then trusts -- so these tests are aimed at the
restore itself: each provider shape restores the right fields, anything
malformed or wrong-typed is refused rather than written, and the
passphrase-provider commit hazard requires each caller to opt in explicitly.
"""

import importlib.util
import json
import pathlib
import tempfile
import unittest


def _load_module():
    """Import the script by path: its filename has hyphens, so it is not a
    legal module name for a plain import."""
    path = pathlib.Path(__file__).resolve().parent / "restore-stack-secrets-config.py"
    spec = importlib.util.spec_from_file_location("restore_stack_secrets_config", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


restore_mod = _load_module()


def _deployment(providers: dict) -> dict:
    return {"deployment": {"secrets_providers": providers}}


class _TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.tmp = pathlib.Path(self._tmpdir.name)

    def _write_deployment(self, providers: dict) -> pathlib.Path:
        path = self.tmp / "deployment.json"
        path.write_text(json.dumps(_deployment(providers)))
        return path

    def _config_path(self, stack: str = "blog") -> pathlib.Path:
        return self.tmp / f"Pulumi.{stack}.yaml"


class RestoreCloudProviderTests(_TempDirCase):
    def test_restores_url_and_encryptedkey(self):
        providers = {
            "type": "cloud",
            "state": {
                "url": "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k",
                "encryptedkey": "deadbeef",
            },
        }
        deployment_path = self._write_deployment(providers)

        written = restore_mod.restore("blog", str(deployment_path), str(self.tmp))

        self.assertEqual(written, self._config_path())
        contents = written.read_text()
        self.assertIn(
            "secretsprovider: gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k",
            contents,
        )
        self.assertIn("encryptedkey: deadbeef", contents)
        self.assertNotIn("encryptionsalt", contents)

    def test_rejects_missing_url(self):
        providers = {"type": "cloud", "state": {"encryptedkey": "deadbeef"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))
        self.assertFalse(self._config_path().exists())

    def test_rejects_missing_encryptedkey(self):
        providers = {"type": "cloud", "state": {"url": "gcpkms://x"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_rejects_non_string_encryptedkey(self):
        providers = {"type": "cloud", "state": {"url": "gcpkms://x", "encryptedkey": 12345}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_rejects_missing_state_block(self):
        providers = {"type": "cloud"}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))


class RestorePassphraseProviderTests(_TempDirCase):
    def test_refuses_by_default(self):
        # The commit hazard this gates: a caller that forgets --allow-passphrase
        # must fail rather than silently restore an offline passphrase
        # verifier into wherever it writes its output.
        providers = {"type": "passphrase", "state": {"salt": "v1:abc123=:v1:def456:ghi789"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit) as ctx:
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))
        self.assertIn("--allow-passphrase", str(ctx.exception))
        self.assertFalse(self._config_path().exists())

    def test_restores_encryptionsalt_when_allowed(self):
        providers = {
            "type": "passphrase",
            "state": {"salt": "v1:abc123=:v1:def456:ghi789"},
        }
        deployment_path = self._write_deployment(providers)

        written = restore_mod.restore(
            "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
        )

        self.assertEqual(written, self._config_path())
        self.assertEqual(written.read_text(), "encryptionsalt: v1:abc123=:v1:def456:ghi789\n")

    def test_never_writes_a_secretsprovider_line(self):
        # A passphrase-managed stack's config file carries no
        # `secretsprovider:` line at all -- its presence would name a provider
        # other than the implicit default, which is not this one.
        providers = {"type": "passphrase", "state": {"salt": "v1:a:b"}}
        deployment_path = self._write_deployment(providers)

        written = restore_mod.restore(
            "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
        )

        self.assertNotIn("secretsprovider", written.read_text())

    def test_rejects_missing_salt(self):
        providers = {"type": "passphrase", "state": {}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )
        self.assertFalse(self._config_path().exists())

    def test_rejects_empty_salt(self):
        providers = {"type": "passphrase", "state": {"salt": ""}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )

    def test_rejects_non_string_salt_int(self):
        providers = {"type": "passphrase", "state": {"salt": 12345}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )
        self.assertFalse(self._config_path().exists())

    def test_rejects_non_string_salt_dict(self):
        providers = {"type": "passphrase", "state": {"salt": {"a": 1}}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )

    def test_rejects_salt_containing_a_newline(self):
        # A newline in a value written by an f-string, not a YAML serialiser,
        # is a YAML-injection path: it can open a new top-level key in the
        # config file this restores into.
        malicious = "v1:a:b\nconfig:\n  gcp:project: attacker-project"
        providers = {"type": "passphrase", "state": {"salt": malicious}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )
        self.assertFalse(self._config_path().exists())

    def test_rejects_salt_without_v1_prefix(self):
        providers = {"type": "passphrase", "state": {"salt": "not-a-real-salt"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )

    def test_rejects_missing_state_block(self):
        providers = {"type": "passphrase"}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )


class RestoreUnknownProviderTests(_TempDirCase):
    def test_rejects_unknown_provider_type(self):
        providers = {"type": "vault", "state": {"whatever": "value"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit) as ctx:
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))
        self.assertIn("vault", str(ctx.exception))
        self.assertFalse(self._config_path().exists())

    def test_rejects_unknown_provider_type_even_when_passphrase_allowed(self):
        # --allow-passphrase opts a caller into restoring `passphrase`
        # specifically -- it must not widen the hard failure for anything else.
        providers = {"type": "vault", "state": {"whatever": "value"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore(
                "blog", str(deployment_path), str(self.tmp), allow_passphrase=True
            )

    def test_rejects_missing_provider_type(self):
        providers = {"state": {}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_a_third_provider_never_silently_becomes_a_warning(self):
        # The whole point of the hard failure: nothing here downgrades an
        # unrecognised provider to a log line and a best-effort write.
        providers = {"type": "unknown-future-provider", "state": {"salt": "x"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))


class RestoreMalformedInputTests(_TempDirCase):
    def test_rejects_malformed_json(self):
        deployment_path = self.tmp / "deployment.json"
        deployment_path.write_text("{not valid json")

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_rejects_missing_deployment_key(self):
        deployment_path = self.tmp / "deployment.json"
        deployment_path.write_text(json.dumps({"unrelated": "shape"}))

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_rejects_null_secrets_providers(self):
        deployment_path = self.tmp / "deployment.json"
        deployment_path.write_text(json.dumps({"deployment": {"secrets_providers": None}}))

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))

    def test_rejects_deployment_not_an_object(self):
        deployment_path = self.tmp / "deployment.json"
        deployment_path.write_text(json.dumps({"deployment": "not-an-object"}))

        with self.assertRaises(SystemExit):
            restore_mod.restore("blog", str(deployment_path), str(self.tmp))


class MainTests(_TempDirCase):
    def test_rejects_wrong_argument_count(self):
        with self.assertRaises(SystemExit):
            restore_mod.main(["restore-stack-secrets-config.py"])
        with self.assertRaises(SystemExit):
            restore_mod.main(
                ["restore-stack-secrets-config.py", "a", "b", "c", "d"]
            )

    def test_writes_and_reports_the_config_path_for_cloud(self):
        providers = {
            "type": "cloud",
            "state": {"url": "gcpkms://x", "encryptedkey": "deadbeef"},
        }
        deployment_path = self._write_deployment(providers)

        restore_mod.main(
            ["restore-stack-secrets-config.py", "blog", str(deployment_path), str(self.tmp)]
        )

        self.assertTrue(self._config_path().exists())

    def test_allow_passphrase_flag_is_required_for_passphrase(self):
        providers = {"type": "passphrase", "state": {"salt": "v1:a:b"}}
        deployment_path = self._write_deployment(providers)

        with self.assertRaises(SystemExit):
            restore_mod.main(
                ["restore-stack-secrets-config.py", "blog", str(deployment_path), str(self.tmp)]
            )
        self.assertFalse(self._config_path().exists())

        restore_mod.main(
            [
                "restore-stack-secrets-config.py",
                "blog",
                str(deployment_path),
                str(self.tmp),
                "--allow-passphrase",
            ]
        )
        self.assertTrue(self._config_path().exists())


if __name__ == "__main__":
    unittest.main()
