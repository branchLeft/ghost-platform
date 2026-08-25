"""Tests for the media bucket policy, weighted towards what it must NOT grant.

The failure this file exists to catch is a policy that works: every image
loads, every upload succeeds, and the bucket is also listable — which publishes
the tenant's object names and, through the bucket name, that the tenant exists
at all. Nothing about that failure is visible from the outside, so it has to be
visible here.
"""

import importlib.util
import json
import pathlib
import unittest

_MODULE_PATH = pathlib.Path(__file__).with_name("render-media-bucket-policy.py")
_spec = importlib.util.spec_from_file_location("render_media_bucket_policy", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
policy_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy_module)

PROJECT = "1231234"
TENANT_KEY = "MJ9VO12DNIH0DHLYOT75"
ADMIN_KEY = "AB9VO12DNIH0DHLYOT99"
BUCKET_ARN = "arn:aws:s3:::branchleft-media-blog"


def policy_for(slug: str = "blog") -> dict:
    return policy_module.render_policy(slug, PROJECT, TENANT_KEY, ADMIN_KEY)


def decide(principal: str, action: str, resource: str, slug: str = "blog") -> str:
    return policy_module._decide(policy_for(slug), principal, action, resource)


TENANT = f"arn:aws:iam:::user/p{PROJECT}:{TENANT_KEY}"
ADMIN = f"arn:aws:iam:::user/p{PROJECT}:{ADMIN_KEY}"
OTHER_TENANT = f"arn:aws:iam:::user/p{PROJECT}:CD9VO12DNIH0DHLYOT11"


class TestPublicReadNotListable(unittest.TestCase):
    """Doc 14 section 6 requirement 2, which is the one that fails silently."""

    def test_anonymous_can_fetch_an_object_by_url(self):
        self.assertEqual(
            decide("*", "s3:GetObject", f"{BUCKET_ARN}/content/images/2026/08/x.png"), "allow"
        )

    def test_anonymous_cannot_list_the_bucket(self):
        for action in ("s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads"):
            with self.subTest(action=action):
                self.assertEqual(decide("*", action, BUCKET_ARN), "deny")

    def test_no_statement_ever_allows_a_list_action(self):
        # Structural, alongside the decision test above: an Allow of a list
        # action would be a defect even if some later Deny happened to cover
        # it, because the Deny is what a future edit removes.
        for statement in policy_for()["Statement"]:
            if statement["Effect"] != "Allow":
                continue
            actions = statement.get("Action", [])
            actions = actions if isinstance(actions, list) else [actions]
            for action in actions:
                self.assertNotIn("List", action)
                self.assertNotEqual(action, "s3:*")

    def test_the_public_allow_names_objects_and_never_the_bucket(self):
        public = policy_for()["Statement"][0]
        self.assertEqual(public["Sid"], "PublicReadObjectsOnly")
        self.assertEqual(public["Resource"], f"{BUCKET_ARN}/*")
        # `arn:aws:s3:::branchleft-media-blog*` — no slash — would match every
        # object in `branchleft-media-blog-archive` as well.
        self.assertNotEqual(public["Resource"], f"{BUCKET_ARN}*")

    def test_anonymous_cannot_write_or_read_the_policy(self):
        self.assertEqual(decide("*", "s3:PutObject", f"{BUCKET_ARN}/x.png"), "deny")
        self.assertEqual(decide("*", "s3:GetBucketPolicy", BUCKET_ARN), "deny")
        self.assertEqual(decide("*", "s3:PutBucketPolicy", BUCKET_ARN), "deny")


class TestAppendOnly(unittest.TestCase):
    """Doc 14 section 6's folded-in decision: media deletion is withheld."""

    def test_the_tenant_key_cannot_delete_its_own_media(self):
        self.assertEqual(decide(TENANT, "s3:DeleteObject", f"{BUCKET_ARN}/x.png"), "deny")
        self.assertEqual(decide(TENANT, "s3:DeleteObjectVersion", f"{BUCKET_ARN}/x.png"), "deny")

    def test_the_tenant_key_can_still_upload(self):
        self.assertEqual(decide(TENANT, "s3:PutObject", f"{BUCKET_ARN}/x.png"), "allow")
        self.assertEqual(decide(TENANT, "s3:GetObject", f"{BUCKET_ARN}/x.png"), "allow")
        # Ghost's `exists()` reaches the bucket resource.
        self.assertEqual(decide(TENANT, "s3:ListBucket", BUCKET_ARN), "allow")

    def test_no_statement_ever_allows_a_delete_action(self):
        for statement in policy_for()["Statement"]:
            if statement["Effect"] != "Allow":
                continue
            actions = statement.get("Action", [])
            actions = actions if isinstance(actions, list) else [actions]
            for action in actions:
                self.assertNotIn("Delete", action)


class TestCredentialIsolation(unittest.TestCase):
    """Doc 14 section 6 requirement 1, and the reason candidate (a) was chosen."""

    def test_another_tenants_key_reaches_nothing_a_stranger_could_not(self):
        self.assertEqual(decide(OTHER_TENANT, "s3:ListBucket", BUCKET_ARN), "deny")
        self.assertEqual(decide(OTHER_TENANT, "s3:PutObject", f"{BUCKET_ARN}/x.png"), "deny")
        self.assertEqual(decide(OTHER_TENANT, "s3:DeleteObject", f"{BUCKET_ARN}/x.png"), "deny")
        # It keeps the public read, because everyone has it. That is not a leak
        # to close; it is the same fetch any reader makes.
        self.assertEqual(decide(OTHER_TENANT, "s3:GetObject", f"{BUCKET_ARN}/x.png"), "allow")

    def test_the_object_deny_is_expressed_as_notaction(self):
        # A list of denied actions is a denylist: an action nobody enumerated
        # falls through it and is then allowed by Hetzner's project-wide
        # default key permission. `NotAction` fails the other way.
        object_deny = policy_for()["Statement"][2]
        self.assertEqual(object_deny["Effect"], "Deny")
        self.assertIn("NotAction", object_deny)
        self.assertNotIn("Action", object_deny)

    def test_the_operator_key_keeps_control_of_the_bucket(self):
        # A policy naming only the tenant's key denies `PutBucketPolicy` to the
        # account that owns the bucket, which is unrecoverable.
        self.assertEqual(decide(ADMIN, "s3:PutBucketPolicy", BUCKET_ARN), "allow")
        self.assertEqual(decide(ADMIN, "s3:DeleteObject", f"{BUCKET_ARN}/x.png"), "allow")
        self.assertEqual(decide(ADMIN, "s3:ListBucket", BUCKET_ARN), "allow")

    def test_refuses_one_key_playing_both_roles(self):
        with self.assertRaises(policy_module.PolicyInputError):
            policy_module.render_policy("blog", PROJECT, TENANT_KEY, TENANT_KEY)


class TestPrefixCollision(unittest.TestCase):
    """A slug that is a prefix of another slug, which is where prefix-scoped
    isolation went wrong on GCP and had to be defended with a trailing slash."""

    def test_two_slugs_sharing_a_prefix_get_two_buckets(self):
        self.assertNotEqual(
            policy_module.media_bucket_name("blog"),
            policy_module.media_bucket_name("blog-archive"),
        )

    def test_blogs_policy_does_not_reach_blog_archives_objects(self):
        archive_object = "arn:aws:s3:::branchleft-media-blog-archive/content/images/x.png"
        # `blog`'s policy must decide nothing at all about `blog-archive`'s
        # objects: no statement in it may match that resource.
        for statement in policy_for("blog")["Statement"]:
            self.assertFalse(
                policy_module._matches(statement["Resource"], archive_object),
                f"{statement['Sid']} matches another tenant's object",
            )
        self.assertFalse(
            policy_module._matches(
                policy_for("blog")["Statement"][1]["Resource"],
                "arn:aws:s3:::branchleft-media-blog-archive",
            )
        )

    def test_the_public_read_of_one_tenant_is_not_the_public_read_of_another(self):
        # The concrete regression: `blog` published, `blog-archive` not yet.
        self.assertEqual(
            decide(
                "*",
                "s3:GetObject",
                "arn:aws:s3:::branchleft-media-blog-archive/x.png",
                slug="blog",
            ),
            "deny",
        )


class TestInputRefusals(unittest.TestCase):
    def test_refuses_a_slug_that_would_make_an_illegal_bucket_name(self):
        for slug in ("blog-", "Blog", "1blog", "", "blog.one", "blog/../website", "a" * 27):
            with self.subTest(slug=slug):
                with self.assertRaises(policy_module.PolicyInputError):
                    policy_module.media_bucket_name(slug)

    def test_accepts_the_slugs_the_platform_permits(self):
        self.assertEqual(policy_module.media_bucket_name("a"), "branchleft-media-a")
        self.assertEqual(
            policy_module.media_bucket_name("example-news"), "branchleft-media-example-news"
        )

    def test_agrees_with_the_components_derivation(self):
        # The literal infra/tenant/media.test.ts asserts. Two languages, one
        # bucket name; a change to either fails the other's tests.
        self.assertEqual(policy_module.media_bucket_name("blog"), "branchleft-media-blog")
        self.assertEqual(policy_module.MEDIA_BUCKET_PREFIX, "branchleft-media-")

    def test_refuses_an_access_key_that_could_change_the_arn_it_names(self):
        for key in ("short", "has:colon0000000", 'has"quote00000000', "has space000000000"):
            with self.subTest(key=key):
                with self.assertRaises(policy_module.PolicyInputError):
                    policy_module.key_principal(PROJECT, key)

    def test_refuses_a_non_numeric_project_id(self):
        for project in ("p1231234", "12:34", "", "abc"):
            with self.subTest(project=project):
                with self.assertRaises(policy_module.PolicyInputError):
                    policy_module.key_principal(project, TENANT_KEY)

    def test_principal_uses_hetzners_arn_form_not_aws(self):
        # Three empty colon-separated fields and a `p`-prefixed project id.
        # The AWS form (`arn:aws:iam::<account>:user/<name>`) names nothing here.
        self.assertEqual(
            policy_module.key_principal(PROJECT, TENANT_KEY),
            f"arn:aws:iam:::user/p{PROJECT}:{TENANT_KEY}",
        )


class TestCommands(unittest.TestCase):
    def test_never_offers_the_public_read_canned_acl(self):
        commands = policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY, "https://hel1.your-objectstorage.com", "hel1"
        )
        self.assertIn("--acl private", commands)
        self.assertNotIn("--acl public-read", commands)

    def test_embeds_a_policy_that_parses(self):
        commands = policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY, "https://hel1.your-objectstorage.com", "hel1"
        )
        body = commands.split("<<'POLICY'\n", 1)[1].split("\nPOLICY", 1)[0]
        self.assertEqual(json.loads(body), policy_for())


class TestSelfTest(unittest.TestCase):
    def test_the_shipped_self_test_passes(self):
        # The workflow and the runbook both run `--self-test` rather than this
        # file, so a self-test that has quietly stopped asserting would pass
        # every run.
        policy_module._self_test()


if __name__ == "__main__":
    unittest.main()
