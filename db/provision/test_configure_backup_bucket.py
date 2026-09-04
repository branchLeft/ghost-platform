#!/usr/bin/env python3
"""Unit tests for configure_backup_bucket.py.

No real network call: `put` is always a fake. What matters here is the
sequencing (the fence goes on last, after the two configuration calls it
denies to everyone but the operator) and that a failed call never reaches the
next one.

The heaviest weight is on the refusals around the policy. Applying a bucket
policy is the one operation in this file that can be irreversible: a policy
that denies the caller `PutBucketPolicy` cannot be edited or removed by any
key in the project afterwards. Every one of those refusals has to be asserted
here, because none of them is visible from a `put-bucket-policy` that
succeeds.
"""

import base64
import hashlib
import json
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
    """The shape render-bucket-fence-policy.py emits, trimmed to what is
    checked here: one Allow granting the named workload key object access
    (mirroring the generator's AllowNamedKeysObjectAccess -- present so the
    checks below can tell a legitimately-exempted principal from one that
    isn't), one bucket-configuration deny exempting the operator, and one
    object deny exempting both named keys.

    A hand-written fixture is a SECOND COPY of the generator's shape, and it
    drifted: it carried `NotAction` after the generator stopped emitting it,
    so the lockout-refusal checks below -- the ones guarding a live apply --
    were reasoning about a document that can no longer exist. It is enumerated
    now for the same reason the generator is: this engine stores `NotAction`
    and enforces nothing, so a fixture built on it models an inert statement as
    a working one. `test_the_fixture_has_not_drifted_back` below is what keeps
    the two from separating again."""
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
        # branchLeft/ghost-platform#154's confirmed finding: narrowing this
        # statement's Action from `s3:*` to a read-only list converts the
        # catch-all into a denylist, and PutObject/DeleteObject fall open.
        policy = fence_policy()
        for statement in policy["Statement"]:
            if statement["Sid"] == "DenyObjectAccessExceptNamedKeys":
                statement["Action"] = ["s3:GetObject"]
        with self.assertRaises(cbb.BucketConfigError) as caught:
            cbb.assert_policy_fences_this_bucket(policy, BUCKET, OPERATOR_ARN)
        self.assertIn("s3:PutObject", str(caught.exception))
        self.assertIn("s3:DeleteObject", str(caught.exception))

    def test_widening_the_object_denys_notprincipal_to_an_unallowed_key_is_refused(self):
        # branchLeft/ghost-platform#154's other confirmed finding: widening
        # this statement's NotPrincipal to also exempt a foreign credential
        # grants that credential full read/write/delete on every backup
        # object -- and nothing else in the policy accounts for it, since no
        # Allow statement names it either.
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
