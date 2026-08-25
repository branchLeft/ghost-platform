"""Tests for the operational-bucket fence, weighted towards its two failures.

The first failure is a fence that does not fence: every pipeline keeps working,
nothing looks wrong, and every other credential in the project still reaches
the estate's backups. That is the state this repository is in today, and
nothing about it is visible from the outside.

The second is a fence that locks the bucket. It is rarer and far worse: the
statement that would have to be edited is the statement doing the denying, no
other key in the project is exempt, and `DeleteBucket` is denied too. There is
no undo inside the account. Both directions have to be asserted here, because
neither is observable from a successful `put-bucket-policy`.
"""

import importlib.util
import json
import pathlib
import unittest

import bucketpolicy

_MODULE_PATH = pathlib.Path(__file__).with_name("render-bucket-fence-policy.py")
_spec = importlib.util.spec_from_file_location("render_bucket_fence_policy", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
fence = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fence)

PROJECT = "15766609"
WORKLOAD = "W" * 20
SECOND_WORKLOAD = "S" * 20
ADMIN = "O" * 20
STRANGER = "X" * 20
BUCKET = "branchleft-db-backups"
BUCKET_ARN = f"arn:aws:s3:::{BUCKET}"
OBJECT_ARN = f"{BUCKET_ARN}/dumps/2026-08-25.sql.age"


def policy_for(*workloads: str) -> dict:
    return fence.render_policy(BUCKET, PROJECT, list(workloads or (WORKLOAD,)), ADMIN)


def decide(principal: str, action: str, resource: str, policy: dict | None = None) -> str:
    return bucketpolicy.decide(policy or policy_for(), principal, action, resource)


def arn(access_key: str) -> str:
    return bucketpolicy.key_principal(PROJECT, access_key)


class TestTheFenceFences(unittest.TestCase):
    def test_another_key_in_the_project_cannot_list_the_bucket(self):
        # The finding: the tenant-state credential listed branchleft-db-backups
        # and got a 200 with binlog object keys back.
        self.assertEqual(decide(arn(STRANGER), "s3:ListBucket", BUCKET_ARN), "deny")

    def test_another_key_in_the_project_cannot_read_or_destroy_an_object(self):
        for action in ("s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObject"):
            with self.subTest(action=action):
                self.assertEqual(decide(arn(STRANGER), action, OBJECT_ARN), "deny")

    def test_an_action_nobody_enumerated_still_falls_closed_for_a_stranger(self):
        for action in ("s3:GetBucketNotification", "s3:PutBucketReplication", "s3:SomethingNew"):
            with self.subTest(action=action):
                self.assertEqual(decide(arn(STRANGER), action, BUCKET_ARN), "deny")

    def test_anonymous_reaches_nothing(self):
        self.assertEqual(decide("*", "s3:GetObject", OBJECT_ARN), "deny")
        self.assertEqual(decide("*", "s3:ListBucket", BUCKET_ARN), "deny")

    def test_no_statement_grants_anything_to_a_wildcard_principal(self):
        # An operational bucket has no anonymous-read requirement at all, so a
        # wildcard Allow anywhere in it is a mistake rather than a decision.
        for statement in policy_for()["Statement"]:
            if statement["Effect"] != "Allow":
                continue
            with self.subTest(sid=statement["Sid"]):
                self.assertNotIn("*", statement["Principal"]["AWS"])


class TestTheWorkloadKeepsWorking(unittest.TestCase):
    def test_the_workload_can_do_its_whole_job(self):
        # dump_nightly.py and ship_binlogs.py write; prune_backups.py lists and
        # deletes; a restore reads. All four must survive the fence.
        for action, resource in (
            ("s3:PutObject", OBJECT_ARN),
            ("s3:GetObject", OBJECT_ARN),
            ("s3:DeleteObject", OBJECT_ARN),
            ("s3:ListBucket", BUCKET_ARN),
            ("s3:ListBucketVersions", BUCKET_ARN),
            ("s3:GetBucketLocation", BUCKET_ARN),
        ):
            with self.subTest(action=action):
                self.assertEqual(decide(arn(WORKLOAD), action, resource), "allow")

    def test_a_second_workload_key_is_allowed_alongside_the_first(self):
        policy = policy_for(WORKLOAD, SECOND_WORKLOAD)
        for access_key in (WORKLOAD, SECOND_WORKLOAD):
            with self.subTest(key=access_key):
                self.assertEqual(decide(arn(access_key), "s3:PutObject", OBJECT_ARN, policy), "allow")

    def test_the_workload_is_still_denied_on_a_neighbouring_bucket_name(self):
        # `arn:aws:s3:::branchleft-db-backups*` would also match every object
        # in `branchleft-db-backups-archive`; the fence must not reach there.
        neighbour = "arn:aws:s3:::branchleft-db-backups-archive"
        for statement in policy_for()["Statement"]:
            resources = statement["Resource"]
            resources = [resources] if isinstance(resources, str) else resources
            for resource in resources:
                with self.subTest(sid=statement["Sid"], resource=resource):
                    self.assertFalse(bucketpolicy.matches(resource, f"{neighbour}/x"))


class TestTheWorkloadCannotEditItsOwnFence(unittest.TestCase):
    def test_the_workload_cannot_rewrite_or_remove_the_policy(self):
        for action in ("s3:PutBucketPolicy", "s3:DeleteBucketPolicy"):
            with self.subTest(action=action):
                self.assertEqual(decide(arn(WORKLOAD), action, BUCKET_ARN), "deny")

    def test_the_workload_cannot_destroy_the_contents_through_configuration(self):
        # Each of these erases or exposes data without ever calling a delete:
        # a lifecycle rule expires every object, suspended versioning removes
        # the recoverability of an overwrite, a bucket ACL publishes the
        # listing, and DeleteBucket takes the lot.
        for action in (
            "s3:PutLifecycleConfiguration",
            "s3:PutBucketVersioning",
            "s3:PutBucketAcl",
            "s3:DeleteBucket",
        ):
            with self.subTest(action=action):
                self.assertEqual(decide(arn(WORKLOAD), action, BUCKET_ARN), "deny")

    def test_the_workload_cannot_read_back_which_keys_are_named(self):
        self.assertEqual(decide(arn(WORKLOAD), "s3:GetBucketPolicy", BUCKET_ARN), "deny")

    def test_the_bucket_configuration_deny_is_expressed_as_notaction(self):
        # An enumerated denylist would let an action nobody thought of through
        # to Hetzner's project-wide default, which is allow.
        statement = next(
            s for s in policy_for()["Statement"] if s["Sid"] == "DenyBucketConfigurationExceptOperator"
        )
        self.assertIn("NotAction", statement)
        self.assertNotIn("Action", statement)


class TestTheBucketStaysAdministrable(unittest.TestCase):
    def test_the_operator_keeps_the_actions_that_make_the_fence_reversible(self):
        for action in fence.RECOVERY_ACTIONS:
            with self.subTest(action=action):
                self.assertEqual(decide(arn(ADMIN), action, BUCKET_ARN), "allow")

    def test_the_operator_keeps_the_data_and_the_configuration(self):
        self.assertEqual(decide(arn(ADMIN), "s3:GetObject", OBJECT_ARN), "allow")
        self.assertEqual(decide(arn(ADMIN), "s3:PutLifecycleConfiguration", BUCKET_ARN), "allow")

    def test_a_policy_that_would_lock_the_bucket_is_refused(self):
        locked = policy_for()
        for statement in locked["Statement"]:
            if statement["Sid"] == "DenyBucketConfigurationExceptOperator":
                statement["NotPrincipal"]["AWS"] = [arn(STRANGER)]
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.assert_recoverable(locked, arn(ADMIN), BUCKET_ARN)

    def test_the_operator_key_cannot_double_as_the_workload_key(self):
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.render_policy(BUCKET, PROJECT, [ADMIN], ADMIN)


class TestRefusedInput(unittest.TestCase):
    def test_a_fence_naming_no_workload_is_refused(self):
        # It would apply cleanly and stop the backups, which nothing notices
        # until the next restore.
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.render_policy(BUCKET, PROJECT, [], ADMIN)

    def test_a_duplicated_workload_key_is_refused(self):
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.render_policy(BUCKET, PROJECT, [WORKLOAD, WORKLOAD], ADMIN)

    def test_a_value_that_would_change_which_principal_is_named_is_refused(self):
        for bad_key in ["short", "has:colon0000000", 'has"quote00000000', f"{WORKLOAD} extra"]:
            with self.subTest(key=bad_key):
                with self.assertRaises(bucketpolicy.PolicyInputError):
                    fence.render_policy(BUCKET, PROJECT, [bad_key], ADMIN)

    def test_a_value_that_would_change_which_bucket_is_named_is_refused(self):
        for bad_bucket in ["Backups", "has.dot", "b", "trailing-", "*", "bucket/../other"]:
            with self.subTest(bucket=bad_bucket):
                with self.assertRaises(bucketpolicy.PolicyInputError):
                    fence.render_policy(bad_bucket, PROJECT, [WORKLOAD], ADMIN)

    def test_a_non_numeric_project_id_is_refused(self):
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.render_policy(BUCKET, "p15766609", [WORKLOAD], ADMIN)


class TestRenderedCommands(unittest.TestCase):
    def test_the_existing_bucket_sequence_never_creates_a_bucket(self):
        # Creating a bucket is a spend decision and is not this script's to
        # make; the two buckets being fenced already exist.
        commands = fence.render_commands(
            BUCKET, PROJECT, [WORKLOAD], ADMIN, "https://hel1.your-objectstorage.com", "hel1", True
        )
        self.assertNotIn("create-bucket", commands)

    def test_the_new_bucket_sequence_sets_versioning_before_the_policy(self):
        commands = fence.render_commands(
            BUCKET, PROJECT, [WORKLOAD], ADMIN, "https://hel1.your-objectstorage.com", "hel1", False
        )
        self.assertLess(
            commands.index("put-bucket-versioning"), commands.index("put-bucket-policy")
        )

    def test_the_policy_is_put_twice_so_a_lockout_surfaces_immediately(self):
        commands = fence.render_commands(
            BUCKET, PROJECT, [WORKLOAD], ADMIN, "https://hel1.your-objectstorage.com", "hel1", True
        )
        self.assertEqual(commands.count("$S3 put-bucket-policy"), 2)

    def test_the_embedded_policy_is_the_rendered_policy(self):
        commands = fence.render_commands(
            BUCKET, PROJECT, [WORKLOAD], ADMIN, "https://hel1.your-objectstorage.com", "hel1", True
        )
        embedded = commands.split("<<'POLICY'\n", 1)[1].split("\nPOLICY", 1)[0]
        self.assertEqual(json.loads(embedded), policy_for())


class TestSelfTest(unittest.TestCase):
    def test_the_shipped_self_test_passes(self):
        fence._self_test()


if __name__ == "__main__":
    unittest.main()
