#!/usr/bin/env python3
"""Unit tests for restore-stack-secrets-config.

This script writes the one file that tells Pulumi how to reach a stack's
data key. A wrong-but-plausible restore doesn't fail loudly here -- it fails
later, opaquely, inside whatever `pulumi` command reads the file next -- so
these tests are aimed at the restore itself: each provider shape restores the
right fields, and anything the script does not recognise is refused rather
than silently written as something else.
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


class RestoreCloudProviderTests(unittest.TestCase):
    def test_restores_url_and_encryptedkey(self):
        providers = {
            "type": "cloud",
            "state": {
                "url": "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k",
                "encryptedkey": "deadbeef",
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            written = restore_mod.restore("blog", str(deployment_path), tmp)

            self.assertEqual(written, pathlib.Path(tmp) / "Pulumi.blog.yaml")
            contents = written.read_text()
            self.assertIn("secretsprovider: gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k", contents)
            self.assertIn("encryptedkey: deadbeef", contents)
            self.assertNotIn("encryptionsalt", contents)

    def test_rejects_missing_url(self):
        providers = {"type": "cloud", "state": {"encryptedkey": "deadbeef"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)
            self.assertFalse((pathlib.Path(tmp) / "Pulumi.blog.yaml").exists())

    def test_rejects_missing_encryptedkey(self):
        providers = {"type": "cloud", "state": {"url": "gcpkms://x"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)


class RestorePassphraseProviderTests(unittest.TestCase):
    def test_restores_encryptionsalt(self):
        providers = {
            "type": "passphrase",
            "state": {"salt": "v1:abc123=:v1:def456:ghi789"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            written = restore_mod.restore("blog", str(deployment_path), tmp)

            self.assertEqual(written, pathlib.Path(tmp) / "Pulumi.blog.yaml")
            contents = written.read_text()
            self.assertEqual(contents, "encryptionsalt: v1:abc123=:v1:def456:ghi789\n")

    def test_never_writes_a_secretsprovider_line(self):
        # A passphrase-managed stack's config file carries no
        # `secretsprovider:` line at all -- its presence would name a provider
        # other than the implicit default, which is not this one.
        providers = {"type": "passphrase", "state": {"salt": "v1:a:b"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            written = restore_mod.restore("blog", str(deployment_path), tmp)

            self.assertNotIn("secretsprovider", written.read_text())

    def test_rejects_missing_salt(self):
        providers = {"type": "passphrase", "state": {}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)
            self.assertFalse((pathlib.Path(tmp) / "Pulumi.blog.yaml").exists())

    def test_rejects_empty_salt(self):
        providers = {"type": "passphrase", "state": {"salt": ""}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)


class RestoreUnknownProviderTests(unittest.TestCase):
    def test_rejects_unknown_provider_type(self):
        providers = {"type": "vault", "state": {"whatever": "value"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit) as ctx:
                restore_mod.restore("blog", str(deployment_path), tmp)
            self.assertIn("vault", str(ctx.exception))
            self.assertFalse((pathlib.Path(tmp) / "Pulumi.blog.yaml").exists())

    def test_rejects_missing_provider_type(self):
        providers = {"state": {}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)

    def test_a_third_provider_never_silently_becomes_a_warning(self):
        # The whole point of the hard failure: nothing here downgrades an
        # unrecognised provider to a log line and a best-effort write.
        providers = {"type": "unknown-future-provider", "state": {"salt": "x"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            with self.assertRaises(SystemExit):
                restore_mod.restore("blog", str(deployment_path), tmp)


class MainTests(unittest.TestCase):
    def test_rejects_wrong_argument_count(self):
        with self.assertRaises(SystemExit):
            restore_mod.main(["restore-stack-secrets-config.py"])
        with self.assertRaises(SystemExit):
            restore_mod.main(
                ["restore-stack-secrets-config.py", "a", "b", "c", "d"]
            )

    def test_writes_and_reports_the_config_path(self):
        providers = {"type": "passphrase", "state": {"salt": "v1:a:b"}}
        with tempfile.TemporaryDirectory() as tmp:
            deployment_path = pathlib.Path(tmp) / "deployment.json"
            deployment_path.write_text(json.dumps(_deployment(providers)))

            restore_mod.main(
                ["restore-stack-secrets-config.py", "blog", str(deployment_path), tmp]
            )

            self.assertTrue((pathlib.Path(tmp) / "Pulumi.blog.yaml").exists())


if __name__ == "__main__":
    unittest.main()
