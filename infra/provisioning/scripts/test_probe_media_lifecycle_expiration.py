"""Tests for the media-lifecycle current-version expiration probe.

Nothing here touches a network: `signed_request` is patched throughout, so
every test is a claim about this script's own logic -- input refusal, the
rule shape it writes, the receipt round trip, and how it reads a pair of
status codes back into a verdict -- never a claim about what Hetzner
actually does. The live question is answered only by a human running
`setup` then `check` against a real disposable bucket, days apart.
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

    def test_check_refuses_a_receipt_naming_a_non_probe_bucket_before_any_request(self):
        # The gap the review round found: check() used to read receipt["bucket"]
        # straight into a HEAD with no guard at all. A stale or hand-edited
        # receipt naming a real bucket is exactly the half-awake, days-later
        # mistake this whole script exists to survive.
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = pathlib.Path(tmp) / "receipt.json"
            receipt_path.write_text(json.dumps({
                "bucket": "branchleft-media-blog",
                "endpoint": "https://hel1.your-objectstorage.com",
                "region": "hel1",
                "probe_key": probe.PROBE_OBJECT_KEY,
                "control_key": probe.CONTROL_OBJECT_KEY,
                "rule_shape": "media",
                "noncurrent_days": 1,
                "uploaded_at": "2026-08-01T00:00:00+00:00",
                "earliest_decisive_check": "2026-08-03T00:00:00+00:00",
            }))
            with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
                with self.assertRaises(probe.ProbeInputError):
                    probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)
        self.assertEqual(calls, [], "a receipt naming a disallowed bucket must never reach the transport")


class TestTheRuleShapeMatchesProduction(unittest.TestCase):
    """The whole probe is worthless if its rule differs from what the two
    real generators actually ship."""

    def test_the_media_shape_carries_noncurrent_version_expiration_and_abort_multipart(self):
        body = probe.lifecycle_document(1, include_abort_multipart_upload=True).decode()
        self.assertIn("<NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays>", body)
        self.assertIn("<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation>", body)

    def test_the_backup_shape_omits_abort_multipart_entirely(self):
        # configure_backup_bucket.py's lifecycle_document() carries NO
        # AbortIncompleteMultipartUpload element at all -- not a different
        # value, an absent one.
        body = probe.lifecycle_document(35, include_abort_multipart_upload=False).decode()
        self.assertIn("<NoncurrentVersionExpiration><NoncurrentDays>35</NoncurrentDays>", body)
        self.assertNotIn("AbortIncompleteMultipartUpload", body)

    def test_neither_shape_carries_a_current_version_expiration_element(self):
        for include_abort in (True, False):
            with self.subTest(include_abort_multipart_upload=include_abort):
                body = probe.lifecycle_document(1, include_abort_multipart_upload=include_abort).decode()
                self.assertNotIn("<Expiration>", body)

    def test_the_rule_filter_scopes_to_the_probe_prefix_not_the_whole_bucket(self):
        # This is what makes the control object a valid discriminator: the
        # rule must provably not cover it.
        body = probe.lifecycle_document(1).decode()
        self.assertIn(f"<Filter><Prefix>{probe.PROBE_OBJECT_PREFIX}</Prefix></Filter>", body)
        self.assertTrue(probe.PROBE_OBJECT_KEY.startswith(probe.PROBE_OBJECT_PREFIX))
        self.assertFalse(probe.CONTROL_OBJECT_KEY.startswith(probe.PROBE_OBJECT_PREFIX))

    def test_noncurrent_days_is_the_only_value_parametrised_alongside_the_shape_switch(self):
        one_day = probe.lifecycle_document(1, include_abort_multipart_upload=True)
        thirty_days = probe.lifecycle_document(30, include_abort_multipart_upload=True)
        self.assertIn(b"<NoncurrentDays>1</NoncurrentDays>", one_day)
        self.assertIn(b"<NoncurrentDays>30</NoncurrentDays>", thirty_days)
        self.assertEqual(
            one_day.replace(b"<NoncurrentDays>1</NoncurrentDays>", b""),
            thirty_days.replace(b"<NoncurrentDays>30</NoncurrentDays>", b""),
        )

    def test_rule_shapes_registry_names_exactly_media_and_backup(self):
        self.assertEqual(probe.RULE_SHAPES, {"media": True, "backup": False})


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

    def test_the_receipt_names_the_bucket_both_keys_and_upload_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_setup(tmp)
            receipt = json.loads((pathlib.Path(tmp) / "receipt.json").read_text())
        self.assertEqual(receipt["bucket"], DISPOSABLE_BUCKET)
        self.assertEqual(receipt["probe_key"], probe.PROBE_OBJECT_KEY)
        self.assertEqual(receipt["control_key"], probe.CONTROL_OBJECT_KEY)
        self.assertEqual(receipt["rule_shape"], "media")
        self.assertEqual(receipt["noncurrent_days"], 1)
        self.assertIn("uploaded_at", receipt)
        self.assertIn("earliest_decisive_check", receipt)

    def test_the_receipt_records_the_backup_rule_shape_when_asked(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_setup(tmp, rule_shape="backup", noncurrent_days=35)
            receipt = json.loads((pathlib.Path(tmp) / "receipt.json").read_text())
        self.assertEqual(receipt["rule_shape"], "backup")
        self.assertEqual(receipt["noncurrent_days"], 35)

    def test_an_unknown_rule_shape_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(probe.ProbeInputError):
                self._run_setup(tmp, rule_shape="something-else")

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
            "probe_key": probe.PROBE_OBJECT_KEY,
            "control_key": probe.CONTROL_OBJECT_KEY,
            "rule_shape": "media",
            "noncurrent_days": 1,
            "uploaded_at": "2026-08-01T00:00:00+00:00",
            "earliest_decisive_check": "2026-08-03T00:00:00+00:00",
        }
        data.update(overrides)
        path = pathlib.Path(tmp) / "receipt.json"
        path.write_text(json.dumps(data))
        return path

    def _check_with(self, receipt_path, statuses_by_key):
        def fake_signed_request(**kwargs):
            return statuses_by_key[kwargs["key"]], b""

        with mock.patch.object(probe, "signed_request", side_effect=fake_signed_request):
            return probe.check(receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY)

    def test_probe_and_control_both_surviving_is_reading_a(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 200, probe.CONTROL_OBJECT_KEY: 200}
            )
        self.assertIn("SURVIVES", verdict)
        self.assertIn("READING A", verdict)

    def test_probe_gone_control_surviving_is_reading_b_confirmed(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 404, probe.CONTROL_OBJECT_KEY: 200}
            )
        self.assertIn("GONE, CONTROL SURVIVES", verdict)
        self.assertIn("READING B", verdict)
        self.assertIn("CONFIRMED", verdict)
        self.assertIn("escalate to Rob", verdict)

    def test_both_gone_is_inconclusive_not_reading_b(self):
        # The exact case the review round's finding 2 was about: a bucket-wide
        # loss must NOT be reported as a confirmed reading B.
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 404, probe.CONTROL_OBJECT_KEY: 404}
            )
        self.assertIn("INCONCLUSIVE", verdict)
        self.assertNotIn("READING A", verdict)
        self.assertNotIn("CONFIRMED", verdict)

    def test_probe_surviving_control_gone_is_inconclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 200, probe.CONTROL_OBJECT_KEY: 404}
            )
        self.assertIn("INCONCLUSIVE", verdict)
        self.assertNotIn("READING A", verdict)
        self.assertNotIn("READING B", verdict)

    def test_a_transport_error_on_either_key_is_inconclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 500, probe.CONTROL_OBJECT_KEY: 200}
            )
        self.assertIn("INCONCLUSIVE", verdict)
        self.assertNotIn("READING A", verdict)
        self.assertNotIn("READING B", verdict)

    def test_a_check_before_the_earliest_decisive_time_warns_on_survival_but_still_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            far_future = "2999-01-01T00:00:00+00:00"
            receipt_path = self._receipt(tmp, earliest_decisive_check=far_future)
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 200, probe.CONTROL_OBJECT_KEY: 200}
            )
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

    def test_a_receipt_missing_rule_shape_defaults_to_media_rather_than_crashing(self):
        # Forward compatibility with a receipt written before --rule-shape
        # existed -- absent, not malformed.
        with tempfile.TemporaryDirectory() as tmp:
            data = {
                "bucket": DISPOSABLE_BUCKET,
                "endpoint": "https://hel1.your-objectstorage.com",
                "region": "hel1",
                "probe_key": probe.PROBE_OBJECT_KEY,
                "control_key": probe.CONTROL_OBJECT_KEY,
                "noncurrent_days": 1,
                "uploaded_at": "2026-08-01T00:00:00+00:00",
                "earliest_decisive_check": "2026-08-03T00:00:00+00:00",
            }
            receipt_path = pathlib.Path(tmp) / "receipt.json"
            receipt_path.write_text(json.dumps(data))
            verdict = self._check_with(
                receipt_path, {probe.PROBE_OBJECT_KEY: 200, probe.CONTROL_OBJECT_KEY: 200}
            )
        self.assertIn("'media'", verdict)


class TestMainRequiresBothCredentialEnvVars(unittest.TestCase):
    def test_missing_credentials_stop_before_any_request(self):
        calls = []
        with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
            with mock.patch.dict("os.environ", {}, clear=True):
                exit_code = probe.main(["check", "--receipt", "/nonexistent"])
        self.assertEqual(exit_code, 2)
        self.assertEqual(calls, [])


def _versions_xml(entries):
    """`entries`: list of (key, version_id, is_latest, kind) where kind is
    "version" or "delete_marker". Builds the ListVersions XML body
    `_list_object_versions` parses -- shaped like Hetzner's real RGW
    response, per verify-bucket-fence.py's already-proven reading of it."""
    body = ['<?xml version="1.0" encoding="UTF-8"?>', "<ListVersionsResult>"]
    for key, version_id, is_latest, kind in entries:
        tag = "DeleteMarker" if kind == "delete_marker" else "Version"
        body.append(
            f"<{tag}><Key>{key}</Key><VersionId>{version_id}</VersionId>"
            f"<IsLatest>{'true' if is_latest else 'false'}</IsLatest></{tag}>"
        )
    body.append("<IsTruncated>false</IsTruncated>")
    body.append("</ListVersionsResult>")
    return "".join(body).encode()


class TestListObjectVersions(unittest.TestCase):
    def test_parses_versions_and_delete_markers_with_is_latest(self):
        xml = _versions_xml(
            [
                ("media/control/canary", "v-current", True, "version"),
                ("media/noncurrent/canary", "v-new", True, "version"),
                ("media/noncurrent/canary", "v-old", False, "version"),
                ("media/deleted/canary", "v-marker", True, "delete_marker"),
                ("media/deleted/canary", "v-prior", False, "version"),
            ]
        )
        with mock.patch.object(probe, "signed_request", return_value=(200, xml)):
            versions = probe._list_object_versions(
                host="h", region="hel1", access_key=ACCESS_KEY, secret_key=SECRET_KEY,
                bucket=DISPOSABLE_BUCKET, prefix="media/",
            )
        self.assertEqual(len(versions), 5)
        noncurrent = [v for v in versions if v["key"] == "media/noncurrent/canary" and not v["is_latest"]]
        self.assertEqual(noncurrent, [{"key": "media/noncurrent/canary", "version_id": "v-old", "is_latest": False, "kind": "version"}])
        marker = [v for v in versions if v["kind"] == "delete_marker"]
        self.assertEqual(marker[0]["version_id"], "v-marker")
        self.assertTrue(marker[0]["is_latest"])

    def test_paginates_on_truncation(self):
        page1 = (
            '<?xml version="1.0"?><ListVersionsResult>'
            '<Version><Key>media/a</Key><VersionId>1</VersionId><IsLatest>true</IsLatest></Version>'
            "<IsTruncated>true</IsTruncated><NextKeyMarker>media/a</NextKeyMarker>"
            "<NextVersionIdMarker>1</NextVersionIdMarker></ListVersionsResult>"
        ).encode()
        page2 = _versions_xml([("media/b", "2", True, "version")])
        responses = iter([(200, page1), (200, page2)])
        with mock.patch.object(probe, "signed_request", side_effect=lambda **k: next(responses)):
            versions = probe._list_object_versions(
                host="h", region="hel1", access_key=ACCESS_KEY, secret_key=SECRET_KEY,
                bucket=DISPOSABLE_BUCKET, prefix="media/",
            )
        self.assertEqual([v["key"] for v in versions], ["media/a", "media/b"])

    def test_truncated_with_no_marker_raises_rather_than_under_reporting(self):
        page1 = (
            '<?xml version="1.0"?><ListVersionsResult>'
            '<Version><Key>media/a</Key><VersionId>1</VersionId><IsLatest>true</IsLatest></Version>'
            "<IsTruncated>true</IsTruncated></ListVersionsResult>"
        ).encode()
        with mock.patch.object(probe, "signed_request", return_value=(200, page1)):
            with self.assertRaises(probe.ObjectStorageError):
                probe._list_object_versions(
                    host="h", region="hel1", access_key=ACCESS_KEY, secret_key=SECRET_KEY,
                    bucket=DISPOSABLE_BUCKET, prefix="media/",
                )

    def test_a_non_2xx_response_raises(self):
        with mock.patch.object(probe, "signed_request", return_value=(403, b"AccessDenied")):
            with self.assertRaises(probe.ObjectStorageError):
                probe._list_object_versions(
                    host="h", region="hel1", access_key=ACCESS_KEY, secret_key=SECRET_KEY,
                    bucket=DISPOSABLE_BUCKET, prefix="media/",
                )


class TestOnlyNoncurrentVersionId(unittest.TestCase):
    def test_returns_the_single_noncurrent_version(self):
        versions = [
            {"key": "k", "version_id": "new", "is_latest": True, "kind": "version"},
            {"key": "k", "version_id": "old", "is_latest": False, "kind": "version"},
        ]
        self.assertEqual(probe._only_noncurrent_version_id(versions, "k"), "old")

    def test_zero_matches_raises(self):
        with self.assertRaises(probe.ObjectStorageError):
            probe._only_noncurrent_version_id([], "k")

    def test_two_matches_raises(self):
        versions = [
            {"key": "k", "version_id": "old1", "is_latest": False, "kind": "version"},
            {"key": "k", "version_id": "old2", "is_latest": False, "kind": "version"},
        ]
        with self.assertRaises(probe.ObjectStorageError):
            probe._only_noncurrent_version_id(versions, "k")

    def test_a_delete_marker_is_not_counted_as_a_noncurrent_version(self):
        versions = [
            {"key": "k", "version_id": "marker", "is_latest": True, "kind": "delete_marker"},
            {"key": "k", "version_id": "old", "is_latest": False, "kind": "version"},
        ]
        self.assertEqual(probe._only_noncurrent_version_id(versions, "k"), "old")


class TestPrefixSplitLifecycleDocument(unittest.TestCase):
    """The literal two-rule shape db/provision/configure_backup_bucket.py's
    own generator applies to the real bucket, mirrored here so this proof
    tests the actual production config, not a proxy for it."""

    def test_two_rules_scoped_to_media_and_a_db_style_prefix(self):
        body = probe.prefix_split_lifecycle_document(1, 35).decode()
        self.assertEqual(body.count("<Rule>"), 2)
        self.assertIn("<Filter><Prefix>media/</Prefix></Filter>", body)
        self.assertIn("<Filter><Prefix>dumps/</Prefix></Filter>", body)

    def test_no_abort_multipart_element_on_either_rule(self):
        # configure_backup_bucket.py's own shape, not render-media-bucket-policy.py's.
        body = probe.prefix_split_lifecycle_document(1, 35).decode()
        self.assertNotIn("AbortIncompleteMultipartUpload", body)

    def test_each_rule_carries_its_own_days(self):
        body = probe.prefix_split_lifecycle_document(1, 35).decode()
        self.assertIn("<Filter><Prefix>media/</Prefix></Filter><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays>", body)
        self.assertIn("<Filter><Prefix>dumps/</Prefix></Filter><NoncurrentVersionExpiration><NoncurrentDays>35</NoncurrentDays>", body)

    def test_defaults_match_the_real_production_values(self):
        body = probe.prefix_split_lifecycle_document().decode()
        self.assertIn("<NoncurrentDays>1</NoncurrentDays>", body)
        self.assertIn("<NoncurrentDays>35</NoncurrentDays>", body)


class TestSetupPrefixSplit(unittest.TestCase):
    def _run(self, tmp, **overrides):
        kwargs = dict(
            bucket=DISPOSABLE_BUCKET,
            endpoint="https://hel1.your-objectstorage.com",
            region="hel1",
            access_key=ACCESS_KEY,
            secret_key=SECRET_KEY,
            receipt_path=pathlib.Path(tmp) / "receipt.json",
        )
        kwargs.update(overrides)
        return probe.setup_prefix_split(**kwargs)

    def _fake_transport(self):
        """A minimal fake that tracks PUT/DELETE writes and answers `?versions`
        listings from what was actually written, so `setup_prefix_split`'s own
        version-id bookkeeping is exercised against real-shaped responses,
        not a canned XML fixture."""
        store: dict[str, list[str]] = {}  # key -> ordered list of "version ids" (content markers)
        deleted_markers: dict[str, str] = {}
        counter = {"n": 0}

        def fake(**kwargs):
            method = kwargs["method"]
            if method == "PUT" and kwargs.get("query") is None and kwargs.get("key"):
                key = kwargs["key"]
                counter["n"] += 1
                # A GLOBALLY unique version id, not a per-key counter -- a
                # per-key "v0" would collide across different keys (the
                # noncurrent/ and deleted/ objects each start their own
                # count from zero), exactly the ambiguity
                # _only_noncurrent_version_id exists to refuse in the real
                # code and must not be accidentally reintroduced by a sloppy
                # test fixture.
                store.setdefault(key, []).append(f"v{counter['n']}")
                return 200, b""
            if method == "DELETE":
                key = kwargs["key"]
                marker = f"marker-{key}"
                deleted_markers[key] = marker
                return 204, b""
            if method == "PUT" and kwargs.get("query"):
                return 200, b""  # versioning / lifecycle
            if method == "GET" and kwargs.get("query") and "versions" in kwargs["query"]:
                prefix = kwargs["query"].get("prefix", "")
                entries = []
                for key, vids in store.items():
                    if not key.startswith(prefix):
                        continue
                    if key in deleted_markers:
                        entries.append((key, deleted_markers[key], True, "delete_marker"))
                        for i, vid in enumerate(vids):
                            entries.append((key, vid, False, "version"))
                    else:
                        for i, vid in enumerate(vids):
                            entries.append((key, vid, i == len(vids) - 1, "version"))
                return 200, _versions_xml(entries)
            raise AssertionError(f"unexpected call: {kwargs}")

        return fake

    def test_writes_a_receipt_naming_both_prefixes_with_one_noncurrent_id_each(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(probe, "signed_request", side_effect=self._fake_transport()):
                self._run(tmp)
            receipt = json.loads((pathlib.Path(tmp) / "receipt.json").read_text())
        self.assertEqual(set(receipt["prefixes"]), {"media", "db"})
        for label, prefix in (("media", "media/"), ("db", "dumps/")):
            info = receipt["prefixes"][label]
            self.assertEqual(info["prefix"], prefix)
            self.assertTrue(info["noncurrent_version_id"])
            self.assertTrue(info["deleted_prior_version_id"])
            self.assertNotEqual(info["noncurrent_version_id"], info["deleted_prior_version_id"])

    def test_a_second_setup_against_an_existing_receipt_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(probe, "signed_request", side_effect=self._fake_transport()):
                self._run(tmp)
                with self.assertRaises(probe.ProbeInputError):
                    self._run(tmp)

    def test_a_non_disposable_bucket_is_refused_before_any_request(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
                with self.assertRaises(probe.ProbeInputError):
                    self._run(tmp, bucket="branchleft-media-blog")
        self.assertEqual(calls, [])

    def test_earliest_decisive_check_is_based_on_the_media_days_not_the_db_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(probe, "signed_request", side_effect=self._fake_transport()):
                self._run(tmp, media_noncurrent_days=1, db_noncurrent_days=35)
            receipt = json.loads((pathlib.Path(tmp) / "receipt.json").read_text())
        import datetime as _dt

        uploaded = _dt.datetime.fromisoformat(receipt["uploaded_at"])
        earliest = _dt.datetime.fromisoformat(receipt["earliest_decisive_check"])
        self.assertEqual((earliest - uploaded).days, 2)  # media_noncurrent_days(1) + 1


class TestCheckPrefixSplit(unittest.TestCase):
    def _receipt(self, tmp, **overrides):
        data = {
            "bucket": DISPOSABLE_BUCKET,
            "endpoint": "https://hel1.your-objectstorage.com",
            "region": "hel1",
            "media_noncurrent_days": 1,
            "db_noncurrent_days": 35,
            "uploaded_at": "2026-08-01T00:00:00+00:00",
            "earliest_decisive_check": "2026-08-03T00:00:00+00:00",
            "prefixes": {
                "media": {
                    "prefix": "media/",
                    "control_key": "media/control/canary",
                    "noncurrent_key": "media/noncurrent/canary",
                    "noncurrent_version_id": "media-noncurrent-old",
                    "deleted_key": "media/deleted/canary",
                    "deleted_prior_version_id": "media-deleted-prior",
                },
                "db": {
                    "prefix": "dumps/",
                    "control_key": "dumps/control/canary",
                    "noncurrent_key": "dumps/noncurrent/canary",
                    "noncurrent_version_id": "db-noncurrent-old",
                    "deleted_key": "dumps/deleted/canary",
                    "deleted_prior_version_id": "db-deleted-prior",
                },
            },
        }
        data.update(overrides)
        path = pathlib.Path(tmp) / "receipt.json"
        path.write_text(json.dumps(data))
        return path

    def _check(self, receipt_path, *, media_versions, db_versions, control_status=200):
        def fake(**kwargs):
            if kwargs["method"] == "HEAD":
                return control_status, b""
            prefix = kwargs["query"]["prefix"]
            entries = media_versions if prefix == "media/" else db_versions
            return 200, _versions_xml(entries)

        with mock.patch.object(probe, "signed_request", side_effect=fake):
            return probe.check_prefix_split(
                receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY
            )

    def _all_current_pruned_media(self):
        # media/'s two noncurrent ids are ABSENT (pruned); currents present.
        media = [
            ("media/noncurrent/canary", "media-noncurrent-new", True, "version"),
            ("media/deleted/canary", "media-delete-marker", True, "delete_marker"),
        ]
        return media

    def _db_intact(self):
        db = [
            ("dumps/noncurrent/canary", "db-noncurrent-new", True, "version"),
            ("dumps/noncurrent/canary", "db-noncurrent-old", False, "version"),
            ("dumps/deleted/canary", "db-delete-marker", True, "delete_marker"),
            ("dumps/deleted/canary", "db-deleted-prior", False, "version"),
        ]
        return db

    def test_media_pruned_db_intact_currents_present_is_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp, earliest_decisive_check="2000-01-01T00:00:00+00:00")
            verdict = self._check(
                receipt_path, media_versions=self._all_current_pruned_media(), db_versions=self._db_intact()
            )
        self.assertIn("PASS", verdict)

    def test_media_not_pruned_before_earliest_is_inconclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            far_future = "2999-01-01T00:00:00+00:00"
            receipt_path = self._receipt(tmp, earliest_decisive_check=far_future)
            verdict = self._check(receipt_path, media_versions=self._db_intact_like_media(), db_versions=self._db_intact())
        self.assertIn("INCONCLUSIVE", verdict)
        self.assertNotIn("PASS", verdict)

    def _db_intact_like_media(self):
        return [
            ("media/noncurrent/canary", "media-noncurrent-new", True, "version"),
            ("media/noncurrent/canary", "media-noncurrent-old", False, "version"),
            ("media/deleted/canary", "media-delete-marker", True, "delete_marker"),
            ("media/deleted/canary", "media-deleted-prior", False, "version"),
        ]

    def test_media_not_pruned_after_earliest_is_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp, earliest_decisive_check="2000-01-01T00:00:00+00:00")
            verdict = self._check(
                receipt_path, media_versions=self._db_intact_like_media(), db_versions=self._db_intact()
            )
        self.assertIn("FAIL", verdict)
        self.assertNotIn("PASS", verdict)

    def test_db_pruned_is_always_fail_and_says_escalate(self):
        # The dangerous case: the long rule expired early, meaning the two
        # rules are not staying independent -- never a PASS at any time.
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp, earliest_decisive_check="2000-01-01T00:00:00+00:00")
            verdict = self._check(
                receipt_path, media_versions=self._all_current_pruned_media(),
                db_versions=self._all_current_pruned_media_as_db(),
            )
        self.assertIn("FAIL", verdict)
        self.assertIn("escalate to Rob", verdict)

    def _all_current_pruned_media_as_db(self):
        return [
            ("dumps/noncurrent/canary", "db-noncurrent-new", True, "version"),
            ("dumps/deleted/canary", "db-delete-marker", True, "delete_marker"),
        ]

    def test_a_missing_current_object_is_fail_never_pass_or_reading_attributed(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp, earliest_decisive_check="2000-01-01T00:00:00+00:00")
            verdict = self._check(
                receipt_path, media_versions=self._all_current_pruned_media(), db_versions=self._db_intact(),
                control_status=404,
            )
        self.assertIn("FAIL", verdict)
        self.assertNotIn("PASS", verdict)

    def test_check_split_without_a_receipt_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "does-not-exist.json"
            with self.assertRaises(probe.ProbeInputError):
                probe.check_prefix_split(receipt_path=missing, access_key=ACCESS_KEY, secret_key=SECRET_KEY)

    def test_check_split_refuses_a_receipt_naming_a_non_probe_bucket(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            receipt_path = self._receipt(tmp, bucket="branchleft-media-blog")
            with mock.patch.object(probe, "signed_request", side_effect=lambda **k: calls.append(k)):
                with self.assertRaises(probe.ProbeInputError):
                    probe.check_prefix_split(
                        receipt_path=receipt_path, access_key=ACCESS_KEY, secret_key=SECRET_KEY
                    )
        self.assertEqual(calls, [])


class TestPrefixSplitCLIWiring(unittest.TestCase):
    def test_setup_split_and_check_split_are_reachable_from_main(self):
        with mock.patch.object(probe, "setup_prefix_split", return_value="ok") as fake_setup:
            with tempfile.TemporaryDirectory() as tmp:
                with mock.patch.dict(
                    "os.environ", {"AWS_ACCESS_KEY_ID": ACCESS_KEY, "AWS_SECRET_ACCESS_KEY": SECRET_KEY}
                ):
                    code = probe.main(
                        [
                            "setup-split", "--bucket", DISPOSABLE_BUCKET,
                            "--receipt", str(pathlib.Path(tmp) / "r.json"),
                        ]
                    )
        self.assertEqual(code, 0)
        fake_setup.assert_called_once()

        with mock.patch.object(probe, "check_prefix_split", return_value="ok") as fake_check:
            with mock.patch.dict(
                "os.environ", {"AWS_ACCESS_KEY_ID": ACCESS_KEY, "AWS_SECRET_ACCESS_KEY": SECRET_KEY}
            ):
                code = probe.main(["check-split", "--receipt", "/tmp/r.json"])
        self.assertEqual(code, 0)
        fake_check.assert_called_once()

    def test_check_split_has_no_bucket_flag_either(self):
        with self.assertRaises(SystemExit) as cm:
            probe.main(["check-split", "--receipt", "x", "--bucket", "branchleft-media-blog"])
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
