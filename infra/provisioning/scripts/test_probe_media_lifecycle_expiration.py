"""Tests for the media-lifecycle current-version expiration probe.

Nothing here touches a network: `signed_request` is patched throughout, so
every test is a claim about this script's own logic -- input refusal, the
rule shape it writes, the receipt round trip, and how it reads a status code
back into a verdict -- never a claim about what Hetzner actually does. The
live question is answered only by a human running `setup` then `check`
against a real disposable bucket, days apart.
"""

import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

_MODULE_PATH = pathlib.Path(__file__).with_name("probe-media-lifecycle-expiration.py")
_spec = importlib.util.spec_from_file_location("probe_media_lifecycle_expiration", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

ACCESS_KEY = "A" * 20
SECRET_KEY = "B" * 20
DISPOSABLE_BUCKET = "branchleft-lifecycle-probe-test"


class TestBucketIsRefusedUnlessDisposable(unittest.TestCase):
    def test_a_tenant_media_bucket_is_refused(self):
        with self.assertRaises(probe.ProbeInputError):
            probe.assert_bucket_is_disposable("branchleft-media-blog")

    def test_the_backup_bucket_is_refused_even_though_it_has_no_prefix_match(self):
        with self.assertRaises(probe.ProbeInputError):
            probe.assert_bucket_is_disposable("branchleft-db-backups")

    def test_the_pulumi_state_bucket_is_refused(self):
        with self.assertRaises(probe.ProbeInputError):
            probe.assert_bucket_is_disposable("branchleft-pulumi-state")

    def test_an_unrelated_bucket_with_no_prefix_is_refused(self):
        with self.assertRaises(probe.ProbeInputError):
            probe.assert_bucket_is_disposable("some-other-bucket")

    def test_a_correctly_prefixed_bucket_is_accepted(self):
        probe.assert_bucket_is_disposable(DISPOSABLE_BUCKET)  # does not raise

    def test_setup_refuses_before_sending_a_single_request(self):
        calls = []
        with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(probe.ProbeInputError):
                    probe.setup(
                        bucket="branchleft-media-blog",
                        endpoint="https://hel1.your-objectstorage.com",
                        region="hel1",
                        access_key=ACCESS_KEY,
                        secret_key=SECRET_KEY,
                        noncurrent_days=1,
                        receipt_path=pathlib.Path(tmp) / "receipt.json",
                    )
        self.assertEqual(calls, [], "a refused bucket must never reach the transport")


class TestTheRuleShapeMatchesProduction(unittest.TestCase):
    """The whole probe is worthless if its rule differs from what
    render-media-bucket-policy.py actually ships."""

    def test_it_carries_noncurrent_version_expiration_and_abort_multipart_only(self):
        body = probe.lifecycle_document(1).decode()
        self.assertIn("<NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays>", body)
        self.assertIn("<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation>", body)

    def test_it_carries_no_current_version_expiration_element(self):
        body = probe.lifecycle_document(1).decode()
        self.assertNotIn("<Expiration>", body)

    def test_noncurrent_days_is_the_only_parametrised_value(self):
        one_day = probe.lifecycle_document(1)
        thirty_days = probe.lifecycle_document(30)
        self.assertIn(b"<NoncurrentDays>1</NoncurrentDays>", one_day)
        self.assertIn(b"<NoncurrentDays>30</NoncurrentDays>", thirty_days)
        # Everything else about the two documents is identical.
        self.assertEqual(
            one_day.replace(b"<NoncurrentDays>1</NoncurrentDays>", b""),
            thirty_days.replace(b"<NoncurrentDays>30</NoncurrentDays>", b""),
        )


class TestSetupWritesAReceiptAndNeverOverwritesOne(unittest.TestCase):
    def _run_setup(self, tmp, **overrides):
        kwargs = dict(
            bucket=DISPOSABLE_BUCKET,
            endpoint="https://hel1.your-objectstorage.com",
            region="hel1",
            access_key=ACCESS_KEY,
            secret_key=SECRET_KEY,
            noncurrent_days=1,
            receipt_path=pathlib.Path(tmp) / "receipt.json",
        )
        kwargs.update(overrides)
        with mock.patch.object(probe, "signed_request", return_value=(200, b"")):
            return probe.setup(**kwargs)

    def test_the_receipt_names_the_bucket_key_and_upload_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_setup(tmp)
            receipt = json.loads((pathlib.Path(tmp) / "receipt.json").read_text())
        self.assertEqual(receipt["bucket"], DISPOSABLE_BUCKET)
        self.assertEqual(receipt["key"], probe.PROBE_OBJECT_KEY)
        self.assertEqual(receipt["noncurrent_days"], 1)
        self.assertIn("uploaded_at", receipt)
        self.assertIn("earliest_decisive_check", receipt)

    def test_a_second_setup_against_an_existing_receipt_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_setup(tmp)
            with self.assertRaises(probe.ProbeInputError):
                self._run_setup(tmp)

    def test_a_failed_upload_raises_rather_than_writing_a_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = pathlib.Path(tmp) / "receipt.json"
            with mock.patch.object(probe, "signed_request", return_value=(403, b"AccessDenied")):
                with self.assertRaises(probe.ObjectStorageError):
                    probe.setup(
                        bucket=DISPOSABLE_BUCKET,
                        endpoint="https://hel1.your-objectstorage.com",
                        region="hel1",
                        access_key=ACCESS_KEY,
                        secret_key=SECRET_KEY,
                        noncurrent_days=1,
                        receipt_path=receipt_path,
                    )
            self.assertFalse(receipt_path.exists())


class TestCheckReadsTheReceiptNotOperatorInput(unittest.TestCase):
    def _receipt(self, tmp, **overrides):
        data = {
            "bucket": DISPOSABLE_BUCKET,
            "endpoint": "https://hel1.your-objectstorage.com",
            "region": "hel1",
            "key": probe.PROBE_OBJECT_KEY,
            "noncurrent_days": 1,
            "uploaded_at": "2026-08-01T00:00:00+00:00",
            "earliest_decisive_check": "2026-08-03T00:00:00+00:00",
        }
        data.update(overrides)
        path = pathlib.Path(tmp) / "receipt.json"
        path.write_text(json.dumps(data))
        return path

    def test_a_surviving_object_reads_as_reading_a(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            with mock.patch.object(probe, "signed_request", return_value=(200, b"")):
                verdict = probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)
        self.assertIn("SURVIVES", verdict)
        self.assertIn("READING A", verdict)

    def test_a_missing_object_reads_as_reading_b(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            with mock.patch.object(probe, "signed_request", return_value=(404, b"")):
                verdict = probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)
        self.assertIn("GONE", verdict)
        self.assertIn("READING B", verdict)
        self.assertIn("escalate to Rob", verdict)

    def test_anything_else_is_inconclusive_never_a_pass_or_a_confirmed_gone(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            with mock.patch.object(probe, "signed_request", return_value=(500, b"internal error")):
                verdict = probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)
        self.assertIn("INCONCLUSIVE", verdict)
        self.assertNotIn("READING A", verdict)
        self.assertNotIn("READING B", verdict)

    def test_a_check_before_the_earliest_decisive_time_warns_on_survival_but_still_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            far_future = "2999-01-01T00:00:00+00:00"
            receipt_path = self._receipt(tmp, earliest_decisive_check=far_future)
            with mock.patch.object(probe, "signed_request", return_value=(200, b"")):
                verdict = probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)
        self.assertIn("SURVIVES", verdict)
        self.assertIn("WARNING", verdict)

    def test_check_without_a_receipt_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "does-not-exist.json"
            with self.assertRaises(probe.ProbeInputError):
                probe.check(receipt_path=missing, access_key=ACCESS_KEY, secret_key=SECRET_KEY)

    def test_check_takes_its_bucket_and_endpoint_from_the_receipt_not_a_flag(self):
        # There is no --bucket or --endpoint flag on the `check` subcommand at
        # all -- structural, so an operator cannot be pointed at a bucket
        # other than the one `setup` actually uploaded to. argparse exits(2)
        # on an unrecognised flag, which SystemExit turns into here.
        with self.assertRaises(SystemExit) as cm:
            probe.main(["check", "--receipt", "x", "--bucket", "branchleft-media-blog"])
        self.assertEqual(cm.exception.code, 2)


class TestMainRequiresBothCredentialEnvVars(unittest.TestCase):
    def test_missing_credentials_stop_before_any_request(self):
        calls = []
        with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
            with mock.patch.dict("os.environ", {}, clear=True):
                exit_code = probe.main(["check", "--receipt", "/nonexistent"])
        self.assertEqual(exit_code, 2)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
