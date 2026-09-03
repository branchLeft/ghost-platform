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
from unittest import mock

import bucketpolicy

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
    return bucketpolicy.decide(policy_for(slug), principal, action, resource)


TENANT = f"arn:aws:iam:::user/p{PROJECT}:{TENANT_KEY}"
ADMIN = f"arn:aws:iam:::user/p{PROJECT}:{ADMIN_KEY}"
OTHER_TENANT = f"arn:aws:iam:::user/p{PROJECT}:CD9VO12DNIH0DHLYOT11"


class TestTheSequenceRunsInTheOperatorsShell(unittest.TestCase):
    def test_the_rendered_commands_survive_zsh(self):
        # zsh does not word-split an unquoted parameter expansion, so
        # `S3='aws ... s3api'` followed by `$S3 ...` fails there with "no such
        # file or directory". This sequence creates a bucket, applies a
        # lifecycle rule and then the fence; aborting partway leaves a tenant's
        # media bucket created and unfenced, reachable by every key in the
        # project.
        commands = policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY, "https://hel1.your-objectstorage.com", "hel1"
        )
        runnable = [line for line in commands.splitlines() if line and not line.startswith("#")]
        self.assertFalse([line for line in runnable if line.startswith("$")])
        self.assertIn(
            's3() { aws --endpoint-url https://hel1.your-objectstorage.com s3api "$@"; }',
            runnable,
        )


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
        # Multipart upload, all object-resource actions.
        self.assertEqual(decide(TENANT, "s3:AbortMultipartUpload", f"{BUCKET_ARN}/x.png"), "allow")
        self.assertEqual(
            decide(TENANT, "s3:ListMultipartUploadParts", f"{BUCKET_ARN}/x.png"), "allow"
        )
        # Retained as SDK headroom, not because Ghost needs it: `exists()` sends
        # `HeadObjectCommand`, an object action, and `S3Storage.ts` issues no
        # `ListBucket` at all. An earlier version of this test claimed the
        # opposite, and that claim was the stated justification for a policy that
        # let the tenant rewrite its own fence.
        self.assertEqual(decide(TENANT, "s3:ListBucket", BUCKET_ARN), "allow")

    def test_the_tenant_key_cannot_edit_the_fence_that_constrains_it(self):
        # The defect this class exists to prevent recurring. The tenant's key
        # lives in `/etc/branchleft/<slug>.env` inside its own container, so any
        # of these would let the tenant undo its own isolation from inside it --
        # and three of them destroy or publish media without ever calling a
        # delete or touching an object.
        for action in (
            "s3:PutBucketPolicy",       # replaces this policy outright
            "s3:DeleteBucketPolicy",    # removes it
            "s3:PutBucketAcl",          # public-read on the bucket == LIST
            "s3:PutLifecycleConfiguration",  # expire everything, no DeleteObject
            "s3:PutBucketVersioning",   # suspend versioning
            "s3:DeleteBucket",
            "s3:ListBucketVersions",
        ):
            with self.subTest(action=action):
                self.assertEqual(decide(TENANT, action, BUCKET_ARN), "deny")

    def test_an_unenumerated_bucket_action_falls_open_for_the_tenant(self):
        # The accepted cost of removing `NotAction`, asserted rather than left
        # in a docstring where nothing checks it. `NotAction` bought exactly
        # this property and did not deliver it. An enumerated denylist IS
        # enforced and does let an unlisted action through, so the mitigation
        # is the breadth of BUCKET_CONFIGURATION_ACTIONS -- pinned member by
        # member in test_bucketpolicy.py -- not the shape of the statement.
        #
        # This test characterises a known loss. If it starts failing, the
        # catch-all has been restored for the tenant somehow: delete THIS test,
        # and do not touch the policy. That instruction applies to this test
        # only -- see the sibling below, which asserts the opposite and must
        # never be deleted.
        self.assertEqual(decide(TENANT, "s3:PutBucketSomethingNewIn2027", BUCKET_ARN), "allow")

    def test_an_unenumerated_bucket_action_still_falls_closed_for_a_stranger(self):
        # NOT a characterisation test. This is the security property, and it is
        # the whole justification for `DenyBucketAccessExceptNamedKeys` using
        # `Action: "s3:*"`. If this fails, a key with no relationship to this
        # tenant has been handed back every bucket sub-resource nobody
        # enumerated -- fix the policy, never the test.
        #
        # It lives apart from its sibling above deliberately: the two make
        # opposite claims, and sharing a name once meant the only guard on this
        # one sat under a comment telling a maintainer to delete it.
        self.assertEqual(decide(OTHER_TENANT, "s3:PutBucketSomethingNewIn2027", BUCKET_ARN), "deny")
        self.assertEqual(decide("*", "s3:PutBucketSomethingNewIn2027", BUCKET_ARN), "deny")

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

    def test_another_tenants_key_reaches_nothing_a_stranger_could_not_reach(self):
        self.assertEqual(decide(OTHER_TENANT, "s3:ListBucket", BUCKET_ARN), "deny")
        self.assertEqual(decide(OTHER_TENANT, "s3:PutObject", f"{BUCKET_ARN}/x.png"), "deny")
        self.assertEqual(decide(OTHER_TENANT, "s3:DeleteObject", f"{BUCKET_ARN}/x.png"), "deny")
        # It keeps the public read, because everyone has it. That is not a leak
        # to close; it is the same fetch any reader makes.
        self.assertEqual(decide(OTHER_TENANT, "s3:GetObject", f"{BUCKET_ARN}/x.png"), "allow")

    def test_the_bucket_configuration_deny_is_an_enumerated_action_list(self):
        # This assertion is inverted from what it used to be. It required
        # `NotAction`, which this engine stores and does not enforce -- so the
        # test was pinning the defect in place rather than guarding it.
        bucket_deny = policy_for()["Statement"][1]
        self.assertEqual(bucket_deny["Sid"], "DenyBucketConfigurationExceptOperator")
        self.assertEqual(bucket_deny["Effect"], "Deny")
        self.assertNotIn("NotAction", bucket_deny)
        self.assertIn("s3:PutBucketPolicy", bucket_deny["Action"])
        self.assertIn("s3:PutBucketVersioning", bucket_deny["Action"])
        self.assertIn("s3:PutBucketAcl", bucket_deny["Action"])
        self.assertIn("s3:PutLifecycleConfiguration", bucket_deny["Action"])
        # The three the tenant keeps must NOT be in the denylist, or the fence
        # becomes an outage.
        for kept in ("s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"):
            self.assertNotIn(kept, bucket_deny["Action"])
        # Only the operator is exempt. The tenant being here was the defect.
        self.assertEqual(bucket_deny["NotPrincipal"]["AWS"], [ADMIN])

    def test_the_object_deny_is_an_enumerated_action_list(self):
        # Also inverted. This is the statement that failed live: written as
        # `NotAction`, it let an unrelated key in the same project PUT an
        # object into a tenant's media bucket. The object resource is the one
        # place the catch-all cannot be recovered with `Action: s3:*`, because
        # anonymous `GetObject` has to survive -- so breadth is the whole of
        # the mitigation and these members are the point of the test.
        object_deny = policy_for()["Statement"][3]
        self.assertEqual(object_deny["Effect"], "Deny")
        self.assertNotIn("NotAction", object_deny)
        for denied in (
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
            "s3:PutObjectAcl",
            "s3:AbortMultipartUpload",
            "s3:RestoreObject",
            "s3:BypassGovernanceRetention",
        ):
            self.assertIn(denied, object_deny["Action"])
        # ...and the two that serve a browser must not be, or every image 404s.
        self.assertNotIn("s3:GetObject", object_deny["Action"])
        self.assertNotIn("s3:GetObjectVersion", object_deny["Action"])

    def test_no_statement_anywhere_uses_notaction(self):
        # The structural guard. The two tests above ask about two statements by
        # index; this one holds for a statement nobody has written yet.
        for statement in policy_for()["Statement"]:
            self.assertNotIn("NotAction", statement, statement.get("Sid"))

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
                bucketpolicy.matches(statement["Resource"], archive_object),
                f"{statement['Sid']} matches another tenant's object",
            )
        for index in (1, 2):
            self.assertFalse(
                bucketpolicy.matches(
                    policy_for("blog")["Statement"][index]["Resource"],
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

    def test_refuses_a_reserved_slug_before_a_bucket_is_created(self):
        # This script runs before the component and before provision-tenant.yml,
        # and its output creates a real bucket, so it must not be the one place
        # a reserved slug gets through.
        for slug in ("website", "edge", "db", "monitoring"):
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

    def test_applies_the_lifecycle_rule_before_the_policy_locks_config_down(self):
        commands = policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY, "https://hel1.your-objectstorage.com", "hel1"
        )
        self.assertLess(
            commands.index("put-bucket-lifecycle-configuration"),
            commands.index("put-bucket-policy"),
        )
        body = commands.split("<<'LIFECYCLE'\n", 1)[1].split("\nLIFECYCLE", 1)[0]
        rule = json.loads(body)["Rules"][0]
        self.assertEqual(rule["NoncurrentVersionExpiration"], {"NoncurrentDays": 30})
        self.assertEqual(rule["AbortIncompleteMultipartUpload"], {"DaysAfterInitiation": 7})
        self.assertEqual(rule["Status"], "Enabled")
        # Hetzner does not support NewerNoncurrentVersions; a count-based
        # retention policy cannot be expressed here at all.
        self.assertNotIn("NewerNoncurrentVersions", body)
        # An Expiration rule on current objects would delete live media.
        self.assertNotIn("Expiration\"", body.replace("NoncurrentVersionExpiration", ""))

    def test_enables_versioning_before_the_lifecycle_rule(self):
        commands = policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY, "https://hel1.your-objectstorage.com", "hel1"
        )
        self.assertLess(
            commands.index("put-bucket-versioning"),
            commands.index("put-bucket-lifecycle-configuration"),
        )

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


class TestTheEmittedSequenceOrdersItsControlFirst(unittest.TestCase):
    """The swap control has to precede the first mutation, not follow it.

    `render_policy` refuses one credential in both roles. It cannot detect the
    two being SWAPPED -- both are well-formed, distinct keys -- so the only
    thing that catches it is a live probe, and a live probe is only useful
    while nothing has been created yet."""

    def commands(self) -> str:
        return policy_module.render_commands(
            "blog", PROJECT, TENANT_KEY, ADMIN_KEY,
            "https://hel1.your-objectstorage.com", "hel1",
        )

    def test_the_control_runs_before_the_bucket_exists(self):
        text = self.commands()
        self.assertLess(
            text.index(f"--bucket {policy_module.CONTROL_BUCKET}"),
            text.index("create-bucket"),
        )

    def test_the_control_runs_before_the_policy_is_applied(self):
        text = self.commands()
        self.assertLess(
            text.index(f"--bucket {policy_module.CONTROL_BUCKET}"),
            text.index("put-bucket-policy"),
        )

    def test_the_control_bucket_is_not_the_one_being_created(self):
        # A control that lists the new bucket proves nothing: it would be
        # unfenced at that point and list for any key in the project.
        self.assertNotEqual(
            policy_module.CONTROL_BUCKET, policy_module.media_bucket_name("blog")
        )


class TestTheGuardIsActuallyWired(unittest.TestCase):
    """A guard is only a guard if the generator calls it.

    Making `assert_enforceable` a no-op turns tests red. REMOVING the call did
    not: each half was correct and nothing asserted they were joined. That is
    the helper-to-caller wiring shape -- a refactor that builds the policy on a
    local and returns it deletes the last thing standing between a `NotAction`
    statement and a live bucket, with a fully green suite.
    """

    def test_render_policy_passes_its_result_through_assert_enforceable(self):
        seen = []
        real = policy_module.assert_enforceable

        def spy(policy):
            seen.append(policy)
            return real(policy)

        with mock.patch.object(policy_module, "assert_enforceable", spy):
            policy = policy_module.render_policy("blog", PROJECT, TENANT_KEY, ADMIN_KEY)

        self.assertEqual(len(seen), 1, "render_policy did not call assert_enforceable")
        self.assertIs(seen[0], policy, "the guarded object is not the returned object")


class TestTheStrangerCatchAll(unittest.TestCase):
    """`DenyBucketAccessExceptNamedKeys` -- the one place the catch-all lost
    with `NotAction` was recovered, and it had no structural test at all."""

    def statement(self) -> dict:
        return next(
            s for s in policy_for()["Statement"]
            if s.get("Sid") == "DenyBucketAccessExceptNamedKeys"
        )

    def test_it_denies_every_bucket_action_not_just_the_reads(self):
        # `Action: "s3:*"`, not a list. Narrowing this to an enumerated set is
        # the regression that gives a stranger back every bucket sub-resource
        # nobody thought to name.
        self.assertEqual(self.statement()["Action"], "s3:*")

    def test_only_the_tenant_and_the_operator_are_exempt(self):
        self.assertEqual(self.statement()["NotPrincipal"]["AWS"], [TENANT, ADMIN])

    def test_it_applies_to_the_bucket_and_not_to_its_objects(self):
        # On the objects ARN this statement would deny anonymous GetObject and
        # 404 every image on the blog.
        self.assertEqual(self.statement()["Resource"], BUCKET_ARN)
        self.assertEqual(self.statement()["Effect"], "Deny")

    def test_the_anonymous_list_deny_is_explicit_rather_than_implicit(self):
        # This is asserted STRUCTURALLY because `decide()` cannot see it:
        # its default for a non-project principal is already `deny`, so
        # `decide("*", "s3:ListBucket", ...)` returns deny with this statement
        # deleted entirely. The distinction the policy exists to create --
        # an implicit deny is overcome by a `public-read` bucket ACL, an
        # explicit policy Deny is not -- lives outside the model, so only the
        # document can be interrogated for it.
        matching = [
            s for s in policy_for()["Statement"]
            if s["Effect"] == "Deny"
            and s["Resource"] == BUCKET_ARN
            and bucketpolicy.matches(s["Action"], "s3:ListBucket")
            and "*" not in s.get("NotPrincipal", {}).get("AWS", [])
        ]
        self.assertTrue(
            matching,
            "no explicit Deny covers s3:ListBucket on the bucket for an anonymous caller",
        )


if __name__ == "__main__":
    unittest.main()
