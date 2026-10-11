#!/usr/bin/env python3
"""Unit tests for configure_backup_bucket.py.

See test_configure_backup_bucket.md#module-overview.
"""

import base64
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import configure_backup_bucket as cbb

# Neutralised so every test that reaches the fence's double PUT runs instantly
# regardless of FENCE_ENGINE_DWELL_SECONDS's production value. Saved first so
# a test can still assert that value is a real margin over the measured
# read-path cache, not just that the code compiles.
PRODUCTION_FENCE_ENGINE_DWELL_SECONDS = cbb.FENCE_ENGINE_DWELL_SECONDS
cbb._sleep = lambda _seconds: None

BUCKET = "branchleft-db-backups"
BUCKET_ARN = f"arn:aws:s3:::{BUCKET}"
OPERATOR_ARN = "arn:aws:iam:::user/p1231234:OOOOOOOOOOOOOOOOOOOO"
WORKLOAD_ARN = "arn:aws:iam:::user/p1231234:WWWWWWWWWWWWWWWWWWWW"
OPERATOR_KEY = "OOOOOOOOOOOOOOOOOOOO"
WORKLOAD_KEY = "WWWWWWWWWWWWWWWWWWWW"


# The bucket-configuration actions the real generator denies, trimmed to the
# three this file's checks turn on. Enumerated, NOT `NotAction` -- see the
# fixture's docstring.
FENCE_CONFIGURATION_ACTIONS = [
    "s3:GetBucketPolicy",
    "s3:PutBucketPolicy",
    "s3:DeleteBucketPolicy",
    "s3:PutBucketAcl",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketVersioning",
    "s3:DeleteBucket",
]


def fence_policy(bucket: str = BUCKET) -> dict:
    """The shape render-bucket-fence-policy.py emits, trimmed to what this
    file checks.

    See test_configure_backup_bucket.md#fence_policy for what each granted
    statement models and why it is enumerated rather than `NotAction`.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowOperatorFullControl",
                "Effect": "Allow",
                "Principal": {"AWS": [OPERATOR_ARN]},
                "Action": "s3:*",
                "Resource": [bucket_arn, f"{bucket_arn}/*"],
            },
            {
                "Sid": "AllowNamedKeysObjectAccess",
                "Effect": "Allow",
                "Principal": {"AWS": [WORKLOAD_ARN, OPERATOR_ARN]},
                "Action": "s3:*",
                "Resource": f"{bucket_arn}/*",
            },
            {
                "Sid": "DenyBucketConfigurationExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                "Action": FENCE_CONFIGURATION_ACTIONS,
                "Resource": bucket_arn,
            },
            {
                "Sid": "DenyObjectAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [WORKLOAD_ARN, OPERATOR_ARN]},
                "Action": "s3:*",
                "Resource": f"{bucket_arn}/*",
            },
        ],
    }


class FixtureFidelityTests(unittest.TestCase):
    """The fixture above is the input to every lockout-refusal check in this
    file. If it stops resembling what the generator emits, those checks pass
    while describing nothing."""

    def test_the_fixture_has_not_drifted_back(self):
        for statement in fence_policy()["Statement"]:
            self.assertNotIn(
                "NotAction",
                statement,
                f"{statement.get('Sid')}: this engine stores NotAction and does not "
                f"enforce it, so a fixture using it models an inert statement as a "
                f"working one",
            )

    def test_the_fixture_denies_the_workload_the_actions_the_checks_turn_on(self):
        config = next(
            s for s in fence_policy()["Statement"]
            if s.get("Sid") == "DenyBucketConfigurationExceptOperator"
        )
        for action in ("s3:PutBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning"):
            self.assertIn(action, config["Action"])
        self.assertEqual(config["NotPrincipal"]["AWS"], [OPERATOR_ARN])


class DocumentTests(unittest.TestCase):
    def test_versioning_document_enables_versioning(self):
        self.assertIn(b"<Status>Enabled</Status>", cbb.versioning_document())

    def test_lifecycle_document_uses_the_given_noncurrent_days(self):
        doc = cbb.lifecycle_document(35)
        self.assertIn(b"<NoncurrentDays>35</NoncurrentDays>", doc)

    def test_lifecycle_document_is_deterministic_for_the_same_input(self):
        self.assertEqual(cbb.lifecycle_document(35), cbb.lifecycle_document(35))


class MediaLifecyclePrefixSplitTests(unittest.TestCase):
    """Every backup run's own deletion step depends on media/ carrying a
    SHORT noncurrent-version expiry of its own, split out from the 35-day
    rule dumps/ and binlogs/ keep; fence-probe/ shares that same short
    window (see the module docstring). Five prefix-scoped rules, never
    one bucket-wide rule and never two rules whose prefixes could both match
    the same key."""

    @staticmethod
    def _rule(doc: str, prefix: str) -> str:
        return doc.split(f"<Filter><Prefix>{prefix}</Prefix></Filter>", 1)[1].split("</Rule>", 1)[0]

    def test_five_rules_are_present(self):
        doc = cbb.lifecycle_document(35, 1).decode()
        self.assertEqual(doc.count("<Rule>"), 5)

    def test_state_rule_is_scoped_and_both_figures_are_parameters(self):
        doc = cbb.lifecycle_document(35, 1, 10, 28, 46, 3).decode()
        rule = doc.split("<Filter><Prefix>state/</Prefix></Filter>", 1)[1].split("</Rule>", 1)[0]
        self.assertIn("<NoncurrentDays>3</NoncurrentDays>", rule)
        self.assertIn("<Expiration><Days>46</Days></Expiration>", rule)
        zero = cbb.lifecycle_document(35, 1, 10, 28, 0).decode()
        self.assertNotIn("<Days>", zero.split("<Filter><Prefix>state/</Prefix></Filter>", 1)[1])
        with self.assertRaises(ValueError):
            cbb.lifecycle_document(35, 1, 10, 28, -1)

    def test_each_rule_is_scoped_to_its_own_prefix(self):
        doc = cbb.lifecycle_document(35, 1).decode()
        self.assertIn("<Filter><Prefix>dumps/</Prefix></Filter>", doc)
        self.assertIn("<Filter><Prefix>binlogs/</Prefix></Filter>", doc)
        self.assertIn("<Filter><Prefix>media/</Prefix></Filter>", doc)
        self.assertIn("<Filter><Prefix>fence-probe/</Prefix></Filter>", doc)

    def test_db_prefixes_get_the_db_noncurrent_days_media_and_probe_get_their_own(self):
        # dumps/ and binlogs/ each carry their own <NoncurrentDays>35</...>
        # element, and media/ and fence-probe/ each carry an independent
        # <NoncurrentDays>1</...>, sharing the same value. state/ takes its
        # own figure, so it is given a value no other rule has.
        doc = cbb.lifecycle_document(35, 1, 10, 28, 46, 7).decode()
        for prefix, days in (("dumps/", 35), ("binlogs/", 35), ("media/", 1), ("fence-probe/", 1), ("state/", 7)):
            self.assertIn(f"<NoncurrentDays>{days}</NoncurrentDays>", self._rule(doc, prefix), prefix)
        self.assertEqual(doc.count("<NoncurrentDays>35</NoncurrentDays>"), 2)
        self.assertEqual(doc.count("<NoncurrentDays>1</NoncurrentDays>"), 2)

    def test_state_defaults_are_the_46_day_erasure_window(self):
        # 10 current + 1 for the daily pass + 35 noncurrent, as dumps/.
        self.assertEqual(cbb.STATE_CURRENT_EXPIRATION_DAYS, 10)
        self.assertEqual(cbb.STATE_NONCURRENT_VERSION_EXPIRATION_DAYS, 35)
        rule = self._rule(cbb.lifecycle_document().decode(), "state/")
        self.assertIn("<Expiration><Days>10</Days></Expiration>", rule)
        self.assertIn("<NoncurrentDays>35</NoncurrentDays>", rule)

    def test_cli_state_flags_default_to_the_erasure_window_and_are_threaded_through(self):
        import contextlib
        import io
        import os
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            policy_file = Path(directory) / "policy.json"
            policy_file.write_text(json.dumps(fence_policy()))
            environment = {"AWS_ACCESS_KEY_ID": OPERATOR_KEY, "AWS_SECRET_ACCESS_KEY": "secret"}
            captured = []
            base = [
                "--bucket", BUCKET, "--endpoint", "hel1.your-objectstorage.com",
                "--region", "hel1", "--policy-file", str(policy_file), "--engine-diagnostic-passed",
            ]

            def fake_configure(**kwargs):
                captured.append(kwargs)

            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                cbb, "owner_id", return_value="p1231234"
            ), mock.patch.object(cbb, "configure_backup_bucket", fake_configure):
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    codes = [
                        cbb.main(base),
                        cbb.main([*base, "--state-expiration-days", "12", "--state-noncurrent-days", "20"]),
                    ]
        self.assertEqual(codes, [0, 0])
        self.assertEqual(
            [(c["state_expiration_days"], c["state_noncurrent_days"]) for c in captured],
            [(10, 35), (12, 20)],
        )

    def test_no_rule_carries_expired_object_delete_marker(self):
        # A Days expiry cannot share a lifecycle element with
        # ExpiredObjectDeleteMarker, and a second rule on the same prefix is
        # unproven on this engine, so media/'s one rule carries the Days
        # expiry and no rule carries the marker element.
        for media_days in (0, 14):
            doc = cbb.lifecycle_document(35, 1, 10, media_days).decode()
            self.assertNotIn("ExpiredObjectDeleteMarker", doc)

    def test_no_two_prefixes_can_ever_match_the_same_key(self):
        # The actual defence: construct a key under each prefix and confirm
        # it starts with exactly one of the four, never zero and never two
        # -- proving the split is genuinely non-overlapping, not merely
        # "looks like four different strings".
        sample_keys = [
            "dumps/11111111-1111-1111-1111-111111111111/db1-20260924T000000Z.sql.age",
            "binlogs/11111111-1111-1111-1111-111111111111/db1-binlog.000123.age",
            "media/tenant-a/generations/20260924T000000000000Z-0000000000000000/objects/" + "a" * 64 + ".age",
            "media/tenant-a/generations/20260924T000000000000Z-0000000000000000/manifest.json.age",
            "fence-probe/canary",
        ]
        prefixes = [cbb.DB_DUMP_PREFIX, cbb.DB_BINLOG_PREFIX, cbb.MEDIA_OBJECT_PREFIX, cbb.FENCE_PROBE_PREFIX]
        for key in sample_keys:
            matches = [prefix for prefix in prefixes if key.startswith(prefix)]
            self.assertEqual(len(matches), 1, f"{key!r} matched {matches!r}, expected exactly one")

    def test_every_real_writers_own_key_shape_is_covered_by_exactly_one_rule(self):
        # Every prefix a pipeline or verifier actually writes under, in
        # this bucket, sampled from each writer's own known key shape --
        # dump_nightly.py's dump_key(), ship_binlogs.py's own f-string,
        # media_backup_restore.py's generation layout (kept in sync with
        # that module's own docstring rather than imported cross-directory:
        # db/provision/ ships standalone to db1 via `scp -r`, so its test
        # suite must not gain an import dependency on a sibling directory
        # that copy never carries), and verify-bucket-fence.py's
        # PROBE_OBJECT_KEY.
        server_uuid = "11111111-1111-1111-1111-111111111111"
        dump_key = f"dumps/{server_uuid}/db1-20260924T000000Z.sql.age"
        binlog_key = f"binlogs/{server_uuid}/db1-binlog.000123.age"
        media_object_key = (
            "media/tenant-a/generations/20260924T172233000000Z-0000000000000000/objects/" + "a" * 64 + ".age"
        )
        media_manifest_key = "media/tenant-a/generations/20260924T172233000000Z-0000000000000000/manifest.json.age"
        fence_probe_key = "fence-probe/canary"

        prefixes = [cbb.DB_DUMP_PREFIX, cbb.DB_BINLOG_PREFIX, cbb.MEDIA_OBJECT_PREFIX, cbb.FENCE_PROBE_PREFIX]
        for key in (dump_key, binlog_key, media_object_key, media_manifest_key, fence_probe_key):
            matches = [prefix for prefix in prefixes if key.startswith(prefix)]
            self.assertEqual(len(matches), 1, f"{key!r} matched {matches!r}, expected exactly one rule")

    def test_media_and_a_tenant_named_dumps_or_binlogs_do_not_collide(self):
        # media/<tenant>/... is scoped under media/ regardless of what the
        # tenant happens to be named -- a tenant literally named "dumps" or
        # "binlogs" still lives under media/, not under either db prefix.
        for tenant in ("dumps", "binlogs"):
            key = f"media/{tenant}/objects/{'b' * 64}.age"
            self.assertTrue(key.startswith(cbb.MEDIA_OBJECT_PREFIX))
            self.assertFalse(key.startswith(cbb.DB_DUMP_PREFIX))
            self.assertFalse(key.startswith(cbb.DB_BINLOG_PREFIX))

    def test_defaults_match_the_configured_constants(self):
        doc = cbb.lifecycle_document().decode()
        for prefix, days in (
            ("dumps/", cbb.NONCURRENT_VERSION_EXPIRATION_DAYS),
            ("binlogs/", cbb.NONCURRENT_VERSION_EXPIRATION_DAYS),
            ("media/", cbb.MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS),
            ("fence-probe/", cbb.MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS),
            ("state/", cbb.STATE_NONCURRENT_VERSION_EXPIRATION_DAYS),
        ):
            self.assertIn(f"<NoncurrentDays>{days}</NoncurrentDays>", self._rule(doc, prefix), prefix)

    def test_configure_backup_bucket_threads_media_noncurrent_days_through(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            policy_body=b"{}",
            noncurrent_days=35,
            media_noncurrent_days=2,
            put=fake_put,
        )
        lifecycle_call = next(c for c in calls if c["subresource"] == "lifecycle")
        body = lifecycle_call["body"].decode()
        self.assertIn("<Filter><Prefix>media/</Prefix></Filter>", body)
        self.assertIn("<Filter><Prefix>fence-probe/</Prefix></Filter>", body)
        for prefix, days in (("media/", 2), ("fence-probe/", 2), ("dumps/", 35), ("binlogs/", 35)):
            self.assertIn(f"<NoncurrentDays>{days}</NoncurrentDays>", self._rule(body, prefix), prefix)

    def test_cli_media_noncurrent_days_flag_is_threaded_through(self):
        import contextlib
        import io
        import os
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            policy_file = Path(directory) / "policy.json"
            policy_file.write_text(json.dumps(fence_policy()))
            environment = {"AWS_ACCESS_KEY_ID": OPERATOR_KEY, "AWS_SECRET_ACCESS_KEY": "secret"}
            captured = {}

            def fake_configure(**kwargs):
                captured.update(kwargs)

            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                cbb, "owner_id", return_value="p1231234"
            ), mock.patch.object(cbb, "configure_backup_bucket", fake_configure):
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    code = cbb.main(
                        [
                            "--bucket", BUCKET, "--endpoint", "hel1.your-objectstorage.com",
                            "--region", "hel1", "--policy-file", str(policy_file),
                            "--engine-diagnostic-passed", "--media-noncurrent-days", "3",
                        ]
                    )
        self.assertEqual(code, 0)
        self.assertEqual(captured["media_noncurrent_days"], 3)


class DbCurrentVersionExpiryTests(unittest.TestCase):
    """The put-only worker key cannot delete, so dumps/ and binlogs/ age out
    through the bucket's own lifecycle: a current-version expiry on each, and
    on nothing else."""

    @staticmethod
    def _rule(doc: str, prefix: str) -> str:
        return doc.split(f"<Filter><Prefix>{prefix}</Prefix></Filter>", 1)[1].split("</Rule>", 1)[0]

    def test_dumps_and_binlogs_each_expire_current_versions(self):
        doc = cbb.lifecycle_document(35, 1, 10).decode()
        for prefix in ("dumps/", "binlogs/"):
            self.assertIn("<Expiration><Days>10</Days></Expiration>", self._rule(doc, prefix))

    def test_media_and_fence_probe_carry_no_day_based_expiry_unless_media_is_given_one(self):
        doc = cbb.lifecycle_document(35, 1, 10, 0).decode()
        self.assertEqual(doc.count("<Days>"), 3)
        for prefix in ("media/", "fence-probe/"):
            self.assertNotIn("<Days>", self._rule(doc, prefix))

    def test_media_expiry_lands_on_the_media_rule_only(self):
        doc = cbb.lifecycle_document(35, 1, 10, 14).decode()
        self.assertEqual(doc.count("<Days>"), 4)
        self.assertIn("<Expiration><Days>14</Days></Expiration>", self._rule(doc, "media/"))
        self.assertNotIn("<Days>", self._rule(doc, "fence-probe/"))
        for prefix in ("dumps/", "binlogs/"):
            self.assertIn("<Days>10</Days>", self._rule(doc, prefix))

    def test_media_rule_keeps_its_own_short_noncurrent_expiry_beside_the_days_expiry(self):
        media_rule = self._rule(cbb.lifecycle_document(35, 1, 10, 14).decode(), "media/")
        self.assertIn("<NoncurrentDays>1</NoncurrentDays>", media_rule)

    def test_no_lifecycle_element_mixes_days_with_expired_object_delete_marker(self):
        for media_days in (0, 3, 14):
            for db_days in (0, 10):
                doc = cbb.lifecycle_document(35, 1, db_days, media_days).decode()
                for expiration in re.findall(r"<Expiration>.*?</Expiration>", doc):
                    self.assertFalse("<Days>" in expiration and "ExpiredObjectDeleteMarker" in expiration)

    def test_media_default_expires_current_copies_after_28_days(self):
        self.assertEqual(cbb.MEDIA_CURRENT_EXPIRATION_DAYS, 28)
        rule = self._rule(cbb.lifecycle_document().decode(), "media/")
        self.assertIn("<Expiration><Days>28</Days></Expiration>", rule)

    def test_media_expiry_of_zero_still_omits_the_rule(self):
        rule = self._rule(cbb.lifecycle_document(35, 1, 10, 0).decode(), "media/")
        self.assertNotIn("<Expiration>", rule)

    def test_a_negative_media_expiry_is_refused(self):
        with self.assertRaises(ValueError):
            cbb.lifecycle_document(35, 1, 10, -1)

    def test_media_expiry_is_threaded_through_configure(self):
        calls = []
        cbb.configure_backup_bucket(
            bucket="b", endpoint="fsn1.your-objectstorage.com", region="fsn1",
            access_key="AK", secret_key="S", policy_body=b"{}", media_expiration_days=21,
            put=lambda **kwargs: calls.append(kwargs),
        )
        body = next(c for c in calls if c["subresource"] == "lifecycle")["body"].decode()
        self.assertIn("<Expiration><Days>21</Days></Expiration>", self._rule(body, "media/"))

    def test_the_decided_figure_matches_the_prune_script_retention(self):
        import prune_backups

        self.assertEqual(cbb.DB_CURRENT_EXPIRATION_DAYS, prune_backups.RETENTION_DAYS)
        self.assertIn(
            f"<Days>{prune_backups.RETENTION_DAYS}</Days>".encode(),
            cbb.lifecycle_document(db_expiration_days=cbb.DB_CURRENT_EXPIRATION_DAYS),
        )

    def test_zero_omits_the_expiry_and_negative_is_refused(self):
        self.assertNotIn(b"<Days>", cbb.lifecycle_document(35, 1, 0, 0, 0))
        with self.assertRaises(ValueError):
            cbb.lifecycle_document(35, 1, -1)

    def test_the_expiry_is_threaded_through_configure_and_the_cli(self):
        import contextlib
        import io
        import os

        calls = []
        cbb.configure_backup_bucket(
            bucket="b", endpoint="fsn1.your-objectstorage.com", region="fsn1",
            access_key="AK", secret_key="S", policy_body=b"{}", db_expiration_days=7,
            put=lambda **kwargs: calls.append(kwargs),
        )
        body = next(c for c in calls if c["subresource"] == "lifecycle")["body"].decode()
        self.assertEqual(body.count("<Days>7</Days>"), 2)

        with tempfile.TemporaryDirectory() as directory:
            policy_file = Path(directory) / "policy.json"
            policy_file.write_text(json.dumps(fence_policy()))
            captured = {}
            environment = {"AWS_ACCESS_KEY_ID": OPERATOR_KEY, "AWS_SECRET_ACCESS_KEY": "secret"}
            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                cbb, "owner_id", return_value="p1231234"
            ), mock.patch.object(cbb, "configure_backup_bucket", lambda **kw: captured.update(kw)):
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    code = cbb.main(
                        ["--bucket", BUCKET, "--endpoint", "fsn1.your-objectstorage.com",
                         "--region", "fsn1", "--policy-file", str(policy_file),
                         "--engine-diagnostic-passed", "--db-expiration-days", "4"]
                    )
        self.assertEqual(code, 0)
        self.assertEqual(captured["db_expiration_days"], 4)

    def test_the_media_expiry_flag_is_threaded_through_the_cli(self):
        import contextlib
        import io
        import os

        with tempfile.TemporaryDirectory() as directory:
            policy_file = Path(directory) / "policy.json"
            policy_file.write_text(json.dumps(fence_policy()))
            environment = {"AWS_ACCESS_KEY_ID": OPERATOR_KEY, "AWS_SECRET_ACCESS_KEY": "secret"}
            for extra, expected in (([], 28), (["--media-expiration-days", "9"], 9), (["--media-expiration-days", "0"], 0)):
                captured = {}
                with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                    cbb, "owner_id", return_value="p1231234"
                ), mock.patch.object(cbb, "configure_backup_bucket", lambda **kw: captured.update(kw)):
                    out = io.StringIO()
                    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(out):
                        code = cbb.main(
                            ["--bucket", BUCKET, "--endpoint", "fsn1.your-objectstorage.com",
                             "--region", "fsn1", "--policy-file", str(policy_file),
                             "--engine-diagnostic-passed", *extra]
                        )
                self.assertEqual(code, 0)
                self.assertEqual(captured["media_expiration_days"], expected)


class DbCurrentVersionExpiryIsOptInTests(unittest.TestCase):
    """A bucket whose writer key can delete is pruned by prune_backups.py, and a
    lifecycle rule cannot keep the newest object, so the current-version expiry
    on dumps/ and binlogs/ is written only when the operator asks for it."""

    @staticmethod
    def _rule(doc: str, prefix: str) -> str:
        return doc.split(f"<Filter><Prefix>{prefix}</Prefix></Filter>", 1)[1].split("</Rule>", 1)[0]

    @staticmethod
    def _cli(extra):
        import contextlib
        import io
        import os

        with tempfile.TemporaryDirectory() as directory:
            policy_file = Path(directory) / "policy.json"
            policy_file.write_text(json.dumps(fence_policy()))
            captured = {}
            environment = {"AWS_ACCESS_KEY_ID": OPERATOR_KEY, "AWS_SECRET_ACCESS_KEY": "secret"}
            out = io.StringIO()
            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                cbb, "owner_id", return_value="p1231234"
            ), mock.patch.object(cbb, "configure_backup_bucket", lambda **kw: captured.update(kw)):
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(out):
                    code = cbb.main(
                        ["--bucket", BUCKET, "--endpoint", "hel1.your-objectstorage.com",
                         "--region", "hel1", "--policy-file", str(policy_file),
                         "--engine-diagnostic-passed", *extra]
                    )
        return code, captured, out.getvalue()

    def test_the_default_document_has_no_current_expiry_on_dumps_or_binlogs(self):
        doc = cbb.lifecycle_document().decode()
        for prefix in ("dumps/", "binlogs/"):
            self.assertNotIn("<Expiration>", self._rule(doc, prefix))

    def test_the_default_document_still_carries_the_noncurrent_rule_on_both(self):
        doc = cbb.lifecycle_document().decode()
        for prefix in ("dumps/", "binlogs/"):
            self.assertIn("<NoncurrentDays>35</NoncurrentDays>", self._rule(doc, prefix))

    def test_the_default_configure_call_sends_no_current_expiry_on_dumps_or_binlogs(self):
        calls = []
        cbb.configure_backup_bucket(
            bucket="b", endpoint="hel1.your-objectstorage.com", region="hel1",
            access_key="AK", secret_key="S", policy_body=b"{}",
            put=lambda **kwargs: calls.append(kwargs),
        )
        body = next(c for c in calls if c["subresource"] == "lifecycle")["body"].decode()
        for prefix in ("dumps/", "binlogs/"):
            self.assertNotIn("<Expiration>", self._rule(body, prefix))

    def test_an_explicit_figure_writes_it_on_both_prefixes_and_nowhere_else_in_the_db_rules(self):
        calls = []
        cbb.configure_backup_bucket(
            bucket="b", endpoint="fsn1.your-objectstorage.com", region="fsn1",
            access_key="AK", secret_key="S", policy_body=b"{}", db_expiration_days=10,
            put=lambda **kwargs: calls.append(kwargs),
        )
        body = next(c for c in calls if c["subresource"] == "lifecycle")["body"].decode()
        for prefix in ("dumps/", "binlogs/"):
            self.assertIn("<Expiration><Days>10</Days></Expiration>", self._rule(body, prefix))
        self.assertNotIn("<Days>", self._rule(body, "fence-probe/"))

    def test_the_media_expiry_is_unchanged_by_the_db_default(self):
        doc = cbb.lifecycle_document().decode()
        self.assertIn("<Expiration><Days>28</Days></Expiration>", self._rule(doc, "media/"))

    def test_the_cli_without_the_flag_asks_for_no_current_expiry(self):
        code, captured, _ = self._cli([])
        self.assertEqual(code, 0)
        self.assertEqual(captured["db_expiration_days"], 0)

    def test_the_cli_with_the_flag_passes_the_figure_through(self):
        code, captured, _ = self._cli(["--db-expiration-days", "10"])
        self.assertEqual(code, 0)
        self.assertEqual(captured["db_expiration_days"], 10)

    def test_the_cli_says_so_when_no_current_expiry_was_written(self):
        _, _, out = self._cli([])
        self.assertIn("NO current-version expiry on dumps/ and binlogs/", out)
        self.assertNotIn("current-version expiry set on dumps/ and binlogs/", out)

    def test_the_cli_warns_that_a_rerun_replaces_the_whole_lifecycle(self):
        for extra in ([], ["--db-expiration-days", "10"]):
            with self.subTest(extra=extra):
                _, _, out = self._cli(extra)
                self.assertIn("A re-run replaces the whole lifecycle", out)
                self.assertIn("omitting --db-expiration-days", out)

    def test_the_cli_names_the_figure_when_it_was_written(self):
        _, _, out = self._cli(["--db-expiration-days", "10"])
        self.assertIn("10-day current-version expiry set on dumps/ and binlogs/", out)
        self.assertNotIn("NO current-version expiry on dumps/ and binlogs/", out)


class RunbookInvocationTests(unittest.TestCase):
    """Every documented invocation of the script, in every markdown file of this
    repo, agrees with the bucket it names: the bucket whose writer key can
    delete takes no current-version expiry flag, and the bucket whose writer is
    put-only passes the decided figure explicitly. A default that is correct
    for one is wrong for the other, so the page has to say which it is."""

    REPO_ROOT = Path(__file__).resolve().parent.parent.parent
    EXCLUDED_DIR_PARTS = {".git", "node_modules", "worktrees", ".worktrees"}
    SCRIPT = "configure_backup_bucket.py"
    DELETING_WRITER_BUCKET = "branchleft-db-backups"
    PUT_ONLY_WRITER_BUCKET = "branchleft-tenant-backups"
    FLAG = "--db-expiration-days"

    @classmethod
    def command_lines(cls, text: str) -> list[list[str]]:
        """The argument tokens of every command naming the script with a --bucket.

        Backslash continuations are joined first, in the single and the doubled
        spelling a quoted example uses. Prose that only names the script has no
        --bucket and is not a command.
        """
        joined = re.sub(r"\\{1,2}\n\s*", " ", text)
        commands = []
        for line in joined.splitlines():
            if cls.SCRIPT not in line or "--bucket" not in line:
                continue
            rest = line.split(cls.SCRIPT, 1)[1]
            rest = re.split(r"[|;`]|&&", rest, maxsplit=1)[0]
            commands.append(rest.split())
        return commands

    @classmethod
    def markdown_files(cls) -> list[Path]:
        return sorted(
            p
            for p in cls.REPO_ROOT.rglob("*.md")
            if not cls.EXCLUDED_DIR_PARTS & set(p.relative_to(cls.REPO_ROOT).parts)
        )

    @classmethod
    def found(cls) -> list[tuple[str, list[str]]]:
        return [
            (str(path.relative_to(cls.REPO_ROOT)), tokens)
            for path in cls.markdown_files()
            for tokens in cls.command_lines(path.read_text(encoding="utf-8"))
        ]

    @classmethod
    def flag_value(cls, tokens: list[str]):
        for index, token in enumerate(tokens):
            if token == cls.FLAG:
                return tokens[index + 1] if index + 1 < len(tokens) else ""
            if token.startswith(cls.FLAG + "="):
                return token.split("=", 1)[1]
        return None

    @staticmethod
    def bucket(tokens: list[str]):
        return tokens[tokens.index("--bucket") + 1] if "--bucket" in tokens[:-1] else None

    def test_the_invocations_were_actually_found(self):
        """A parser that matched nothing would pass every assertion below."""
        buckets = [self.bucket(tokens) for _, tokens in self.found()]
        self.assertGreaterEqual(buckets.count(self.DELETING_WRITER_BUCKET), 2, buckets)
        self.assertGreaterEqual(buckets.count(self.PUT_ONLY_WRITER_BUCKET), 1, buckets)

    def test_the_database_runbook_names_the_deleting_writer_bucket_without_the_flag(self):
        runbook = self.REPO_ROOT / "db" / "RUNBOOK-db.md"
        commands = self.command_lines(runbook.read_text(encoding="utf-8"))
        self.assertEqual(len(commands), 1, commands)
        self.assertEqual(self.bucket(commands[0]), self.DELETING_WRITER_BUCKET)
        self.assertIsNone(self.flag_value(commands[0]))

    def test_every_invocation_is_classified_and_carries_the_right_flag(self):
        for page, tokens in self.found():
            with self.subTest(page=page, bucket=self.bucket(tokens)):
                bucket = self.bucket(tokens)
                value = self.flag_value(tokens)
                if bucket == self.DELETING_WRITER_BUCKET:
                    self.assertIsNone(
                        value,
                        f"{page}: the bucket whose writer can delete is pruned by "
                        f"prune_backups.py; it must not be given {self.FLAG}",
                    )
                elif bucket == self.PUT_ONLY_WRITER_BUCKET:
                    self.assertEqual(
                        value,
                        str(cbb.DB_CURRENT_EXPIRATION_DAYS),
                        f"{page}: the put-only bucket ages dumps out through its "
                        f"lifecycle only, so it must pass {self.FLAG} explicitly",
                    )
                else:
                    self.fail(f"{page}: an invocation names a bucket this test cannot classify: {bucket!r}")

    def test_the_matcher_catches_a_flag_on_the_deleting_bucket_and_a_missing_one(self):
        """A parser that cannot see the defect would pass the page it checks."""
        with_flag = self.command_lines(
            "python3 db/provision/configure_backup_bucket.py --bucket branchleft-db-backups \\\n"
            "  --region hel1 --db-expiration-days 10 --policy-file p.json\n"
        )
        self.assertEqual(self.flag_value(with_flag[0]), "10")
        self.assertEqual(self.bucket(with_flag[0]), self.DELETING_WRITER_BUCKET)
        without = self.command_lines(
            "python3 db/provision/configure_backup_bucket.py --bucket branchleft-tenant-backups --region fsn1\n"
        )
        self.assertIsNone(self.flag_value(without[0]))
        equals_form = self.command_lines(
            "configure_backup_bucket.py --bucket branchleft-db-backups --db-expiration-days=10\n"
        )
        self.assertEqual(self.flag_value(equals_form[0]), "10")
        self.assertEqual(
            self.command_lines("`configure_backup_bucket.py` always re-applies the fence\n"), []
        )
        self.assertEqual(
            self.command_lines("python3 db/provision/configure_backup_bucket.py --help | grep -c x\n"), []
        )


class ConfigureBackupBucketTests(unittest.TestCase):
    def test_enables_versioning_then_sets_the_lifecycle(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="branchleft-db-backups",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            policy_body=b"{}",
            put=fake_put,
        )

        # The fence last: it denies every bucket-configuration action to
        # every key but the operator's, so the two calls it would block have
        # to have landed already rather than rely on that exemption holding.
        self.assertEqual(
            [call["subresource"] for call in calls],
            ["versioning", "lifecycle", "policy", "policy"],
        )
        self.assertNotIn("content_md5", calls[0])
        self.assertNotIn("content_md5", calls[2])
        self.assertEqual(calls[2]["body"], b"{}")

    def test_the_policy_is_put_twice_so_a_lockout_surfaces_here(self):
        # The second PUT is the control. If this engine reads NotPrincipal as
        # naming every principal rather than exempting the one it lists, the
        # first PUT succeeds and the bucket is already unrecoverable. The
        # second is a no-op when the exemption works and the only signal that
        # exists when it does not.
        #
        # It has to be in the code rather than only in the runbook: the
        # operator path for a rebuilt db1 runs this script and stops.
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            policy_body=b'{"Statement": []}',
            put=fake_put,
        )
        policy_calls = [call for call in calls if call["subresource"] == "policy"]
        self.assertEqual(len(policy_calls), 2)
        # Byte-identical, so a success on the second is genuinely a no-op.
        self.assertEqual(policy_calls[0]["body"], policy_calls[1]["body"])

    def test_a_denied_second_policy_put_fails_the_run(self):
        # The lockout, surfacing at the only moment anything can be done about
        # it. Without this the script would exit 0 on a bucket nobody can ever
        # re-administer.
        seen = {"policy": 0}

        def fake_put(**kwargs):
            if kwargs["subresource"] != "policy":
                return
            seen["policy"] += 1
            if seen["policy"] == 2:
                raise cbb.ObjectStorageError("PUT b?policy failed: HTTP 403 (AccessDenied)")

        with self.assertRaises(cbb.ObjectStorageError):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                put=fake_put,
            )
        self.assertEqual(seen["policy"], 2)

    def test_lifecycle_call_carries_a_correct_content_md5(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            policy_body=b"{}",
            put=fake_put,
        )
        lifecycle_call = calls[1]
        expected = base64.b64encode(
            hashlib.md5(lifecycle_call["body"], usedforsecurity=False).digest()
        ).decode()
        self.assertEqual(lifecycle_call["content_md5"], expected)

    def test_a_failed_versioning_call_never_reaches_lifecycle(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)
            if kwargs["subresource"] == "versioning":
                raise cbb.ObjectStorageError("boom")

        with self.assertRaises(cbb.ObjectStorageError):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                put=fake_put,
            )
        self.assertEqual(len(calls), 1)

    def test_custom_noncurrent_days_is_threaded_through(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        cbb.configure_backup_bucket(
            bucket="b",
            endpoint="hel1.your-objectstorage.com",
            region="hel1",
            access_key="AK",
            secret_key="SECRET",
            policy_body=b"{}",
            noncurrent_days=10,
            put=fake_put,
        )
        self.assertIn(b"<NoncurrentDays>10</NoncurrentDays>", calls[1]["body"])


    def test_a_failed_lifecycle_call_never_applies_the_fence(self):
        # A fence on a bucket whose lifecycle never landed would leave nobody
        # but the operator able to set one.
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)
            if kwargs["subresource"] == "lifecycle":
                raise cbb.ObjectStorageError("boom")

        with self.assertRaises(cbb.ObjectStorageError):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                put=fake_put,
            )
        self.assertEqual([call["subresource"] for call in calls], ["versioning", "lifecycle"])


class EngineCatchupDwellTests(unittest.TestCase):
    """The second PUT is only a control once the dwell has actually run.

    Sent immediately, it is authorised against the same cached pre-PUT
    decision the first PUT was, and a green run tells the operator nothing
    about whether the fence just locked them out. These tests are on the
    security-sensitive path this bug lived on, so they check the dwell's
    timing and its threading through `configure_backup_bucket`, not just that
    two PUTs happen.
    """

    def test_production_dwell_matches_the_verifiers_own_unmeasured_margin(self):
        # The PUT-side propagation window was never measured below "cleared by
        # t+90s" -- there is no smaller figure to assert here, so this floor
        # tracks the verifier's own DWELL_SECONDS rather than undercutting it.
        # A future edit that drops below it has to bring new evidence, not
        # just a smaller number.
        self.assertGreaterEqual(PRODUCTION_FENCE_ENGINE_DWELL_SECONDS, 100.0)

    def test_await_engine_catchup_sleeps_the_full_dwell_in_short_steps(self):
        waits = []
        with mock.patch.object(cbb, "_sleep", waits.append):
            cbb._await_engine_catchup(30.0)
        self.assertEqual(sum(waits), 30.0)
        self.assertTrue(all(step <= 10.0 for step in waits))

    def test_await_engine_catchup_does_nothing_for_a_non_positive_dwell(self):
        with mock.patch.object(cbb, "_sleep") as sleep:
            cbb._await_engine_catchup(0)
        sleep.assert_not_called()

    def test_the_second_put_is_sent_only_after_the_dwell_completes(self):
        events = []

        def fake_put(**kwargs):
            events.append(("put", kwargs["subresource"]))

        def fake_sleep(seconds):
            events.append(("sleep", seconds))

        with mock.patch.object(cbb, "_sleep", fake_sleep):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                fence_dwell_seconds=20.0,
                put=fake_put,
            )
        policy_events = [event for event in events if event[0] in ("put", "sleep")]
        first_policy = next(i for i, e in enumerate(policy_events) if e == ("put", "policy"))
        second_policy = len(policy_events) - 1 - next(
            i for i, e in enumerate(reversed(policy_events)) if e == ("put", "policy")
        )
        self.assertLess(first_policy, second_policy)
        between = policy_events[first_policy + 1 : second_policy]
        self.assertTrue(between, "nothing was waited between the two policy PUTs")
        self.assertTrue(all(event[0] == "sleep" for event in between))
        self.assertEqual(sum(seconds for _, seconds in between), 20.0)

    def test_a_zero_dwell_sends_the_second_put_with_no_wait(self):
        calls = []

        def fake_put(**kwargs):
            calls.append(kwargs)

        with mock.patch.object(cbb, "_sleep") as sleep:
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                fence_dwell_seconds=0,
                put=fake_put,
            )
        sleep.assert_not_called()
        policy_calls = [call for call in calls if call["subresource"] == "policy"]
        self.assertEqual(len(policy_calls), 2)

    def test_a_custom_dwell_is_threaded_through_from_configure_backup_bucket(self):
        waits = []
        with mock.patch.object(cbb, "_sleep", waits.append):
            cbb.configure_backup_bucket(
                bucket="b",
                endpoint="hel1.your-objectstorage.com",
                region="hel1",
                access_key="AK",
                secret_key="SECRET",
                policy_body=b"{}",
                fence_dwell_seconds=5.0,
                put=lambda **_kwargs: None,
            )
        self.assertEqual(sum(waits), 5.0)


class PolicyRefusalTests(unittest.TestCase):
    """The refusals that stand between an operator and an unrecoverable bucket."""

    def test_a_policy_exempting_this_credential_is_accepted(self):
        cbb.assert_policy_fences_this_bucket(fence_policy(), BUCKET, OPERATOR_ARN)

    def test_a_policy_that_would_lock_out_this_credential_is_refused(self):
        # The operator ran it with db1's backup key rather than their own. The
        # policy is correct; applying it from here removes the last credential
        # able to replace it.
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(fence_policy(), BUCKET, WORKLOAD_ARN)
        self.assertIn("lock this bucket permanently", str(caught.exception))

    def test_the_right_access_key_under_the_wrong_account_is_refused(self):
        # The lockout no offline check can see: every principal in a rendered
        # policy comes from one --project-id argument, so the generator's own
        # check compares a fabricated ARN against itself and passes for any
        # value. Live, this ARN names a principal that does not exist, so the
        # NotPrincipal exemption exempts nobody.
        wrong_account = OPERATOR_ARN.replace("p1231234", "p9999999")
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(fence_policy(), BUCKET, wrong_account)
        self.assertIn("project id", str(caught.exception))

    def test_a_deny_naming_this_credential_directly_is_refused(self):
        policy = fence_policy()
        policy["Statement"].append(
            {
                "Sid": "DenyTheOperator",
                "Effect": "Deny",
                "Principal": {"AWS": [OPERATOR_ARN]},
                "Action": "s3:PutBucketPolicy",
                "Resource": BUCKET_ARN,
            }
        )
        with self.assertRaises(cbb.BucketConfigError):
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)

    def test_a_deny_naming_every_principal_is_refused_in_both_spellings(self):
        # `{"AWS": "*"}` and a bare `"*"` are the same statement. The bare form
        # is what most published deny-all examples use, and reading only the
        # dict form skips the statement -- which for a Deny means passing it.
        for principal in ({"AWS": "*"}, "*", {"AWS": ["*"]}):
            with self.subTest(principal=principal):
                policy = fence_policy()
                policy["Statement"].append(
                    {
                        "Sid": "DenyEveryone",
                        "Effect": "Deny",
                        "Principal": principal,
                        "Action": "s3:*",
                        "Resource": BUCKET_ARN,
                    }
                )
                with self.assertRaises(cbb.BucketConfigError):
                    cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)

    def test_a_deny_naming_no_principal_at_all_is_refused(self):
        # Whether an absent Principal means "everybody" or "nobody" is the
        # engine's business, and this one is undocumented. An irreversible
        # write is not the place to find out.
        policy = fence_policy()
        policy["Statement"].append(
            {
                "Sid": "DenyNobodyKnows",
                "Effect": "Deny",
                "Action": "s3:*",
                "Resource": BUCKET_ARN,
            }
        )
        with self.assertRaises(cbb.BucketConfigError):
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)

    def test_a_statement_with_no_resource_is_refused(self):
        policy = fence_policy()
        policy["Statement"].append(
            {"Sid": "DenyEverywhere", "Effect": "Deny", "Principal": {"AWS": "*"}, "Action": "s3:*"}
        )
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("names no Resource", str(caught.exception))

    def test_a_policy_that_fences_nothing_is_refused(self):
        # `--policy-file` is required so that a bucket cannot be configured
        # unfenced. A file with statements but no denials satisfies the flag
        # and fences nothing, which is the same outcome with extra steps.
        policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "AllowOperator",
                    "Effect": "Allow",
                    "Principal": {"AWS": [OPERATOR_ARN]},
                    "Action": "s3:*",
                    "Resource": [BUCKET_ARN, f"{BUCKET_ARN}/*"],
                }
            ],
        }
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("denies nothing", str(caught.exception))

    def test_a_policy_that_opens_the_bucket_to_everyone_is_refused(self):
        # An operational bucket has no anonymous-read requirement, so a
        # wildcard Allow is a paste error, not a decision.
        policy = fence_policy()
        policy["Statement"].append(
            {
                "Sid": "PublicRead",
                "Effect": "Allow",
                "Principal": {"AWS": "*"},
                "Action": "s3:GetObject",
                "Resource": f"{BUCKET_ARN}/*",
            }
        )
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("publish the bucket", str(caught.exception))

    def test_a_policy_for_a_different_bucket_is_refused(self):
        # Two fences are rendered in one session and the wrong file is passed:
        # the bucket in hand stays open while the operator reads success.
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(
                fence_policy("branchleft-tenant-pulumi-state"), BUCKET, OPERATOR_ARN
            )
        self.assertIn("fence the wrong bucket", str(caught.exception))

    def test_a_neighbouring_bucket_name_does_not_count_as_this_bucket(self):
        with self.assertRaises(cbb.BucketConfigError):
            cbb.assert_policy_fences_this_bucket(
                fence_policy("branchleft-db-backups-archive"), BUCKET, OPERATOR_ARN
            )

    def test_an_object_only_deny_never_blocks_the_run(self):
        # A Deny on `<bucket>/*` cannot deny PutBucketPolicy, which is an
        # action on the bucket resource, so exempting only the workload key --
        # not the operator -- from an object-only Deny is not a lockout risk.
        # The bucket-resource Deny here is renamed and reordered relative to
        # the fixture's own, to prove the checks key on Resource/Action/
        # Principal content rather than a Sid string.
        policy = fence_policy()
        policy["Statement"] = [
            statement
            for statement in policy["Statement"]
            if statement["Sid"] != "DenyBucketConfigurationExceptOperator"
        ] + [
            {
                "Sid": "DenyBucketConfigurationRenamed",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                "Action": FENCE_CONFIGURATION_ACTIONS,
                "Resource": BUCKET_ARN,
            },
            {
                "Sid": "DenyObjectsToOthers",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [WORKLOAD_ARN]},
                "Action": "s3:*",
                "Resource": f"{BUCKET_ARN}/*",
            },
        ]
        cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)

    def test_a_notaction_bucket_deny_fences_nothing(self):
        # Hetzner Object Storage accepts, stores and returns NotAction
        # byte-identical to what was sent, and enforces none of it -- a Deny
        # expressed this way withholds nothing, however complete it reads.
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyBucketConfigurationExceptOperator":
                del statement["Action"]
                statement["NotAction"] = ["s3:ListBucket"]
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("NotAction", str(caught.exception))

    def test_a_notaction_object_deny_fences_nothing(self):
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyObjectAccessExceptNamedKeys":
                del statement["Action"]
                statement["NotAction"] = ["s3:PutBucketPolicy"]
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("NotAction", str(caught.exception))

    def test_narrowing_the_bucket_configuration_denys_actions_is_refused(self):
        # "Tightening" a catch-all into an enumerated list that omits one of
        # the actions that matters leaves that action to fall back to
        # Hetzner's project-wide default, which is allow.
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyBucketConfigurationExceptOperator":
                statement["Action"] = ["s3:PutBucketPolicy"]  # drops PutBucketAcl etc.
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("s3:PutBucketAcl", str(caught.exception))

    def test_narrowing_the_object_denys_actions_to_a_read_list_is_refused(self):
        # Narrowing this statement's Action from `s3:*` to a read-only list
        # converts the catch-all into a denylist, and PutObject/DeleteObject
        # fall open.
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyObjectAccessExceptNamedKeys":
                statement["Action"] = ["s3:GetObject"]
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("s3:PutObject", str(caught.exception))
        self.assertIn("s3:DeleteObject", str(caught.exception))

    def test_widening_the_object_denys_notprincipal_to_an_unallowed_key_is_refused(self):
        # Widening this statement's NotPrincipal to also exempt a foreign
        # credential grants that credential full read/write/delete on every
        # backup object -- and nothing else in the policy accounts for it,
        # since no Allow statement names it either.
        foreign_arn = "arn:aws:iam:::user/p1231234:FFFFFFFFFFFFFFFFFFFF"
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyObjectAccessExceptNamedKeys":
                statement["NotPrincipal"]["AWS"].append(foreign_arn)
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn(foreign_arn, str(caught.exception))

    def test_widening_the_bucket_configuration_denys_notprincipal_is_also_refused(self):
        # The same widening on the bucket-resource statement is refused too --
        # not only on the object side.
        foreign_arn = "arn:aws:iam:::user/p1231234:FFFFFFFFFFFFFFFFFFFF"
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyBucketConfigurationExceptOperator":
                statement["NotPrincipal"]["AWS"].append(foreign_arn)
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn(foreign_arn, str(caught.exception))

    def test_a_notprincipal_exemption_backed_by_an_allow_is_accepted(self):
        # The converse of the two tests above: exempting a principal the
        # policy also grants an explicit Allow for is exactly what the real
        # generator's shape does, and must not be refused.
        cbb.assert_policy_fences_this_bucket(fence_policy(), BUCKET, OPERATOR_ARN)


class LoadPolicyTests(unittest.TestCase):
    def test_reads_the_document_verbatim(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_bytes(json.dumps(fence_policy()).encode())
            policy, body = cbb.load_policy(str(path))
        self.assertEqual(policy, fence_policy())
        self.assertEqual(json.loads(body), fence_policy())

    def test_refuses_a_file_that_is_not_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text("not json")
            with self.assertRaises(cbb.BucketConfigError):
                cbb.load_policy(str(path))

    def test_refuses_a_document_with_no_statements(self):
        # An empty policy applies cleanly and fences nothing.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text('{"Version": "2012-10-17", "Statement": []}')
            with self.assertRaises(cbb.BucketConfigError):
                cbb.load_policy(str(path))


class MainTests(unittest.TestCase):
    def _policy_file(self, directory: str, policy: dict) -> str:
        path = Path(directory) / "policy.json"
        path.write_text(json.dumps(policy))
        return str(path)

    def test_refuses_without_credentials(self):
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            policy_file = self._policy_file(directory, fence_policy())
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("AWS_ACCESS_KEY_ID", None)
                os.environ.pop("AWS_SECRET_ACCESS_KEY", None)
                with contextlib.redirect_stderr(stderr):
                    code = cbb.main(
                        [
                            "--bucket",
                            BUCKET,
                            "--endpoint",
                            "hel1.your-objectstorage.com",
                            "--region",
                            "hel1",
                            "--policy-file",
                            policy_file,
                            "--engine-diagnostic-passed",
                        ]
                    )
        self.assertEqual(code, 2)
        self.assertIn("AWS_ACCESS_KEY_ID", stderr.getvalue())

    def test_refuses_to_apply_a_fence_until_the_engine_question_is_settled(self):
        # THE SECOND PATH TO AN APPLY. An operator rebuilding db1 follows
        # db/RUNBOOK-db.md and reaches this script without ever opening
        # RUNBOOK-bucket-fencing.md, so the gate has to be in the script and not
        # only in the prose. A fence that locks the operator out is
        # unrecoverable from inside the account, and every signal this script
        # can see -- a 2xx on the PUT, a green second PUT -- looks identical
        # whether the fence works or locks the account out.
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            policy_file = self._policy_file(directory, fence_policy())
            environment = {
                "AWS_ACCESS_KEY_ID": OPERATOR_KEY,
                "AWS_SECRET_ACCESS_KEY": "secret",
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                with mock.patch.object(cbb, "owner_id") as resolve:
                    with mock.patch.object(
                        cbb, "put_bucket_subresource"
                    ) as put:
                        with contextlib.redirect_stderr(stderr):
                            code = cbb.main(
                                [
                                    "--bucket",
                                    BUCKET,
                                    "--endpoint",
                                    "hel1.your-objectstorage.com",
                                    "--region",
                                    "hel1",
                                    "--policy-file",
                                    policy_file,
                                ]
                            )
        self.assertEqual(code, 2)
        self.assertIn("--diagnose-policy-engine", stderr.getvalue())
        # Nothing at all was sent -- not the policy, and not the versioning or
        # lifecycle calls either. A bucket half-configured by a refused run is
        # worse than one nobody touched.
        resolve.assert_not_called()
        put.assert_not_called()

    def test_refuses_without_a_policy_file(self):
        # There is deliberately no flag to configure a bucket without fencing
        # it: an unfenced bucket is reachable by every key in its project, and
        # the next bucket someone adds inherits whatever this one permits.
        import contextlib
        import io

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                cbb.main(
                    [
                        "--bucket",
                        BUCKET,
                        "--endpoint",
                        "hel1.your-objectstorage.com",
                        "--region",
                        "hel1",
                    ]
                )

    def test_the_account_is_resolved_from_the_credential_not_from_an_argument(self):
        # A project id typed into the generator is not evidence of anything.
        # The account has to come from the credential that will do the writing.
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            policy_file = self._policy_file(directory, fence_policy())
            environment = {
                "AWS_ACCESS_KEY_ID": OPERATOR_KEY,
                "AWS_SECRET_ACCESS_KEY": "secret",
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                with mock.patch.object(cbb, "owner_id", return_value="p9999999") as resolve:
                    with contextlib.redirect_stderr(stderr):
                        code = cbb.main(
                            [
                                "--bucket",
                                BUCKET,
                                "--endpoint",
                                "hel1.your-objectstorage.com",
                                "--region",
                                "hel1",
                                "--policy-file",
                                policy_file,
                                "--engine-diagnostic-passed",
                            ]
                        )
        self.assertEqual(code, 2)
        resolve.assert_called_once()
        self.assertIn("lock this bucket permanently", stderr.getvalue())

    def test_a_locking_policy_stops_the_run_before_any_request(self):
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            policy_file = self._policy_file(directory, fence_policy())
            environment = {
                "AWS_ACCESS_KEY_ID": WORKLOAD_KEY,
                "AWS_SECRET_ACCESS_KEY": "secret",
            }
            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                cbb, "owner_id", return_value="p1231234"
            ):
                with contextlib.redirect_stderr(stderr):
                    code = cbb.main(
                        [
                            "--bucket",
                            BUCKET,
                            "--endpoint",
                            "hel1.your-objectstorage.com",
                            "--region",
                            "hel1",
                            "--policy-file",
                            policy_file,
                            "--engine-diagnostic-passed",
                        ]
                    )
        self.assertEqual(code, 2)
        self.assertIn("lock this bucket permanently", stderr.getvalue())


class TheCheckerRequiresWhatTheGeneratorActuallyDenies(unittest.TestCase):
    """Round-2 review findings: three ways a policy passed the fence check
    while leaving the bucket reachable through Hetzner's project-wide default.

    All three were reproduced against the real function before being fixed, and
    each test here fails if its fix is reverted."""

    def test_a_deny_narrowed_to_the_checkers_own_list_still_leaves_the_bucket_deletable(self):
        """The checker's required list and the generator's emitted list must
        not diverge. They did: the checker asked for four actions where the
        generator denies seven, so a Deny narrowed to exactly the checker's
        four read as fenced while `s3:DeleteBucket` stayed available to every
        credential in the project -- destruction of the backup bucket itself,
        which is the worst outcome in this threat model."""
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyBucketConfigurationExceptOperator":
                statement["Action"] = list(cbb.CRITICAL_BUCKET_CONFIGURATION_ACTIONS)
        # The fixture is the generator's shape; anything it denies and the
        # checker does not require is a hole the checker cannot see.
        self.assertEqual(
            set(),
            set(FENCE_CONFIGURATION_ACTIONS) - set(cbb.CRITICAL_BUCKET_CONFIGURATION_ACTIONS),
            "the generator denies an action the checker does not require, so a Deny "
            "narrowed to the checker's list would certify a bucket this fence does not cover",
        )
        cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)

    def test_an_allow_carrying_notprincipal_is_refused(self):
        """`Allow` + `NotPrincipal` grants everyone it does not name. It is
        `Principal: "*"` written the other way round, and the guard for that
        keyed only on `Principal`, so this passed."""
        policy = fence_policy()
        policy["Statement"].append(
            {
                "Sid": "AllowEveryoneButOperator",
                "Effect": "Allow",
                "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                "Action": "s3:*",
                "Resource": f"{BUCKET_ARN}/*",
            }
        )
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("AllowEveryoneButOperator", str(caught.exception))

    def test_an_unrelated_allow_does_not_account_for_a_notprincipal_exemption(self):
        """The correspondence check asked only whether *some* Allow existed for
        the exempted principal on the resource. A trivial companion Allow for
        an action the Deny does not even cover therefore laundered a full
        exemption from Get/Put/DeleteObject."""
        foreign = "arn:aws:iam:::user/p1231234:FFFFFFFFFFFFFFFFFFFF"
        policy = fence_policy()
        policy["Statement"].append(
            {
                "Sid": "AllowForeignTrivial",
                "Effect": "Allow",
                "Principal": {"AWS": [foreign]},
                "Action": "s3:ListBucket",
                "Resource": f"{BUCKET_ARN}/*",
            }
        )
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyObjectAccessExceptNamedKeys":
                statement["NotPrincipal"]["AWS"].append(foreign)
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        message = str(caught.exception)
        self.assertIn(foreign, message)
        self.assertIn("s3:GetObject", message)

    def test_a_matching_allow_still_accounts_for_an_exemption(self):
        """The check must not become so strict that the generator's own output
        fails: the named workload key is exempted from the object Deny and does
        hold `s3:*` on the objects, so it is accounted for."""
        cbb.assert_policy_fences_this_bucket(fence_policy(), BUCKET, OPERATOR_ARN)


if __name__ == "__main__":
    unittest.main()
