"""Tests for the shared media bucket renderer, weighted towards what it must NOT grant.

The gateway's real key is alone in its own project, so it reaches nothing until a
statement names it. `bucketpolicy.decide` models a project-wide default that
every key in the bucket's own project receives; for these buckets the default
applies only to the operator's key, so this file decides with its own evaluator.
"""

import contextlib
import importlib.util
import io
import pathlib
import re
import unittest

import bucketpolicy

_MODULE_PATH = pathlib.Path(__file__).with_name("render-shared-media-buckets.py")
_spec = importlib.util.spec_from_file_location(
    "render_shared_media_buckets", _MODULE_PATH
)
assert _spec is not None and _spec.loader is not None
renderer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(renderer)

GATEWAY_PROJECT, READER_PROJECT, ERASURE_PROJECT, ADMIN_PROJECT = (
    "1000001",
    "1000002",
    "1000003",
    "1000004",
)
GATEWAY_KEY = "GWKEY0000000000000A"
READER_KEY = "RDKEY0000000000000B"
ERASURE_KEY = "ERKEY0000000000000C"
ADMIN_KEY = "ADKEY0000000000000D"

BUCKETS = ["gw-shard-a1", "gw-shard-b2", "gw-shard-c3"]
LOCATION = "fsn1"

GATEWAY = f"arn:aws:iam:::user/p{GATEWAY_PROJECT}:{GATEWAY_KEY}"
READER = f"arn:aws:iam:::user/p{READER_PROJECT}:{READER_KEY}"
ERASURE = f"arn:aws:iam:::user/p{ERASURE_PROJECT}:{ERASURE_KEY}"
ADMIN = f"arn:aws:iam:::user/p{ADMIN_PROJECT}:{ADMIN_KEY}"
ANON = "*"

DELETE = {"s3:DeleteObject", "s3:DeleteObjectVersion"}
LISTING = ["s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"]


def keys() -> object:
    return renderer.Keys(gateway=GATEWAY, reader=READER, erasure=ERASURE, admin=ADMIN)


def policy_for(bucket: str = BUCKETS[0]) -> dict:
    return renderer.render_policy(bucket, keys())


def decide(principal: str, action: str, resource: str, bucket: str = BUCKETS[0]) -> str:
    """Explicit Deny wins; an Allow grants; otherwise only the operator's own project is allowed."""
    policy = policy_for(bucket)
    allowed = False
    for statement in policy["Statement"]:
        if not bucketpolicy.matches(statement["Resource"], resource):
            continue
        if not bucketpolicy.matches(statement["Action"], action):
            continue
        if "NotPrincipal" in statement:
            if bucketpolicy.matches(statement["NotPrincipal"]["AWS"], principal):
                continue
        elif not bucketpolicy.matches(statement["Principal"]["AWS"], principal):
            continue
        if statement["Effect"] == "Deny":
            return "deny"
        allowed = True
    if allowed:
        return "allow"
    return (
        "allow"
        if principal.startswith(f"arn:aws:iam:::user/p{ADMIN_PROJECT}:")
        else "deny"
    )


def object_arn(bucket: str = BUCKETS[0]) -> str:
    return f"arn:aws:s3:::{bucket}/content/images/x.png"


def bucket_arn(bucket: str = BUCKETS[0]) -> str:
    return f"arn:aws:s3:::{bucket}"


class TestEachBucketIsRenderedWhole(unittest.TestCase):
    def test_every_bucket_gets_its_own_policy_naming_only_itself(self):
        for bucket in BUCKETS:
            with self.subTest(bucket=bucket):
                policy = policy_for(bucket)
                self.assertEqual(policy["Id"], bucket)
                resources = {s["Resource"] for s in policy["Statement"]}
                self.assertTrue(
                    resources <= {f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"}
                )

    def test_commands_create_version_lifecycle_and_fence_each_bucket(self):
        text = renderer.render_commands(BUCKETS, LOCATION, keys())
        for bucket in BUCKETS:
            with self.subTest(bucket=bucket):
                self.assertIn(f"s3 create-bucket --bucket {bucket} --acl private", text)
                self.assertIn(f"s3 put-bucket-versioning --bucket {bucket}", text)
                self.assertIn(
                    f"s3 put-bucket-lifecycle-configuration --bucket {bucket}", text
                )
                self.assertIn(f"s3 put-bucket-policy --bucket {bucket}", text)
                self.assertIn(f"s3 get-bucket-policy --bucket {bucket}", text)
        self.assertIn('"NoncurrentDays": 30', text)
        self.assertIn('"DaysAfterInitiation": 7', text)
        self.assertIn("Status=Enabled", text)

    def test_the_location_is_the_one_passed_in(self):
        text = renderer.render_commands(BUCKETS, "nbg1", keys())
        self.assertIn("LocationConstraint=nbg1", text)
        self.assertIn("https://nbg1.your-objectstorage.com", text)
        self.assertNotIn("hel1", text)

    def test_the_policy_json_is_the_same_document_the_commands_carry(self):
        text = renderer.render_commands(BUCKETS, LOCATION, keys())
        expected = renderer.json.dumps(policy_for(BUCKETS[1]), indent=2)
        self.assertIn(expected, text)


class TestTheGatewayKeyHasNoDelete(unittest.TestCase):
    def test_no_allow_statement_naming_the_gateway_carries_a_delete(self):
        for bucket in BUCKETS:
            with self.subTest(bucket=bucket):
                for statement in policy_for(bucket)["Statement"]:
                    principals = statement.get("Principal", {}).get("AWS", [])
                    principals = (
                        [principals] if isinstance(principals, str) else principals
                    )
                    if statement["Effect"] == "Allow" and GATEWAY in principals:
                        actions = statement["Action"]
                        actions = [actions] if isinstance(actions, str) else actions
                        self.assertFalse(set(actions) & DELETE, statement["Sid"])

    def test_the_gateway_can_put_and_read(self):
        self.assertEqual(decide(GATEWAY, "s3:PutObject", object_arn()), "allow")
        self.assertEqual(decide(GATEWAY, "s3:GetObject", object_arn()), "allow")

    def test_the_gateway_cannot_delete_a_version_or_an_object(self):
        for action in DELETE:
            with self.subTest(action=action):
                self.assertEqual(decide(GATEWAY, action, object_arn()), "deny")


class TestTheReaderCannotWrite(unittest.TestCase):
    def test_reader_reads_and_lists(self):
        self.assertEqual(decide(READER, "s3:GetObject", object_arn()), "allow")
        self.assertEqual(decide(READER, "s3:ListBucket", bucket_arn()), "allow")

    def test_reader_cannot_write_delete_or_reconfigure(self):
        for action, resource in [
            ("s3:PutObject", object_arn()),
            ("s3:DeleteObject", object_arn()),
            ("s3:PutBucketPolicy", bucket_arn()),
            ("s3:PutBucketVersioning", bucket_arn()),
        ]:
            with self.subTest(action=action):
                self.assertEqual(decide(READER, action, resource), "deny")


class TestAnonymousCannotList(unittest.TestCase):
    def test_anonymous_fetches_objects_and_versions(self):
        self.assertEqual(decide(ANON, "s3:GetObject", object_arn()), "allow")
        self.assertEqual(decide(ANON, "s3:GetObjectVersion", object_arn()), "allow")

    def test_anonymous_listing_is_refused(self):
        for action in LISTING:
            with self.subTest(action=action):
                self.assertEqual(decide(ANON, action, bucket_arn()), "deny")

    def test_no_public_allow_names_a_listing_action(self):
        for bucket in BUCKETS:
            with self.subTest(bucket=bucket):
                for statement in policy_for(bucket)["Statement"]:
                    if statement["Effect"] == "Allow" and statement["Principal"] == {
                        "AWS": "*"
                    }:
                        self.assertFalse(set(statement["Action"]) & set(LISTING))


class TestErasureDeletes(unittest.TestCase):
    def test_erasure_deletes_versions_and_lists_versions(self):
        self.assertEqual(
            decide(ERASURE, "s3:DeleteObjectVersion", object_arn()), "allow"
        )
        self.assertEqual(
            decide(ERASURE, "s3:ListBucketVersions", bucket_arn()), "allow"
        )

    def test_erasure_cannot_write_or_reconfigure(self):
        self.assertEqual(decide(ERASURE, "s3:PutObject", object_arn()), "deny")
        self.assertEqual(decide(ERASURE, "s3:PutBucketPolicy", bucket_arn()), "deny")


class TestOperatorKeepsAdministration(unittest.TestCase):
    def test_operator_administers_and_deletes(self):
        self.assertEqual(decide(ADMIN, "s3:PutBucketPolicy", bucket_arn()), "allow")
        self.assertEqual(decide(ADMIN, "s3:DeleteObject", object_arn()), "allow")


class TestRefusals(unittest.TestCase):
    def test_no_location_is_a_refusal_with_a_message(self):
        argv = [
            "--bucket",
            BUCKETS[0],
            "--bucket",
            BUCKETS[1],
            "--bucket",
            BUCKETS[2],
            "--gateway-key",
            f"{GATEWAY_PROJECT}:{GATEWAY_KEY}",
            "--reader-key",
            f"{READER_PROJECT}:{READER_KEY}",
            "--erasure-key",
            f"{ERASURE_PROJECT}:{ERASURE_KEY}",
            "--admin-key",
            f"{ADMIN_PROJECT}:{ADMIN_KEY}",
        ]
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            renderer.main(argv)
        self.assertNotEqual(cm.exception.code, 0)
        self.assertIn("--location", err.getvalue())

    def test_no_parser_argument_has_a_default(self):
        parser = renderer.build_parser()
        for action in parser._actions:
            if action.dest == "help":
                continue
            with self.subTest(argument=action.dest):
                if action.dest == "commands":
                    continue
                self.assertIsNone(action.default)

    def test_the_source_names_no_default_location(self):
        self.assertNotIn("hel1", _MODULE_PATH.read_text(encoding="utf-8"))

    def test_a_bad_location_is_refused(self):
        for bad in ["", "FSN1", "fsn1/../x", "hel1.example.com"]:
            with (
                self.subTest(location=bad),
                self.assertRaises(renderer.PolicyInputError),
            ):
                renderer.location_endpoint(bad)

    def test_exactly_three_distinct_buckets_are_required(self):
        with self.assertRaises(renderer.PolicyInputError):
            renderer.check_bucket_names(BUCKETS[:2])
        with self.assertRaises(renderer.PolicyInputError):
            renderer.check_bucket_names([BUCKETS[0], BUCKETS[0], BUCKETS[1]])

    def test_the_four_keys_must_be_four_credentials(self):
        with self.assertRaises(renderer.PolicyInputError):
            renderer.make_keys(
                f"{GATEWAY_PROJECT}:{GATEWAY_KEY}",
                f"{GATEWAY_PROJECT}:{GATEWAY_KEY}",
                f"{ERASURE_PROJECT}:{ERASURE_KEY}",
                f"{ADMIN_PROJECT}:{ADMIN_KEY}",
            )

    def test_two_keys_in_one_project_are_refused(self):
        with self.assertRaises(renderer.PolicyInputError):
            renderer.make_keys(
                f"{GATEWAY_PROJECT}:{GATEWAY_KEY}",
                f"{GATEWAY_PROJECT}:{READER_KEY}",
                f"{ERASURE_PROJECT}:{ERASURE_KEY}",
                f"{ADMIN_PROJECT}:{ADMIN_KEY}",
            )

    def test_a_malformed_key_is_refused(self):
        with self.assertRaises(renderer.PolicyInputError):
            renderer.parse_key("1000001:short")
        with self.assertRaises(renderer.PolicyInputError):
            renderer.parse_key("no-colon-here")


class TestStructure(unittest.TestCase):
    def test_no_statement_uses_not_action(self):
        for statement in policy_for()["Statement"]:
            self.assertNotIn("NotAction", statement)

    def test_every_deny_names_an_action(self):
        for statement in policy_for()["Statement"]:
            if statement["Effect"] == "Deny":
                self.assertIn("Action", statement)

    def test_no_pasted_block_has_an_unbalanced_quote(self):
        text = renderer.render_commands(BUCKETS, LOCATION, keys())
        self.assertEqual(text.count("'") % 2, 0)
        self.assertEqual(text.count('"') % 2, 0)
        self.assertEqual(re.findall(r"^#", text, flags=re.MULTILINE), [])


if __name__ == "__main__":
    unittest.main()
