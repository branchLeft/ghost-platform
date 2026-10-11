"""Tests for the role-aware fence: put-only writers and read-only readers.

The failure these exist to catch is a narrow key that is narrow only on paper.
Hetzner's project default grants every key in a project every action on every
bucket in it, so a put-only key with no Deny against it can still read, list
and delete -- and nothing about the rendered document would look wrong.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import unittest

import bucketpolicy

_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "render_bucket_fence_policy_roles", _HERE / "render-bucket-fence-policy.py"
)
assert _spec is not None and _spec.loader is not None
fence = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fence)

# The apply-time guard lives with the db1 scripts and imports its siblings
# bare, the way it runs on the host.
_DB_PROVISION = _HERE.parents[2] / "db" / "provision"
sys.path.insert(0, str(_DB_PROVISION))
import configure_backup_bucket  # noqa: E402

PROJECT = "1231234"
WORKLOAD = "W" * 20
WRITER = "P" * 20
SECOND_WRITER = "Q" * 20
READER = "R" * 20
ADMIN = "O" * 20
STRANGER = "X" * 20
BUCKET = "branchleft-backups"
BUCKET_ARN = f"arn:aws:s3:::{BUCKET}"
OBJECT_ARN = f"{BUCKET_ARN}/dumps/tenant/2026-09-28.sql.age"

LEGACY_SIDS = [
    "AllowOperatorFullControl",
    "AllowNamedKeysObjectAccess",
    "AllowNamedKeysBucketReads",
    "DenyBucketConfigurationExceptOperator",
    "DenyBucketAccessExceptNamedKeys",
    "DenyObjectAccessExceptNamedKeys",
    "DenyObjectMutationsExceptOperator",
]


def arn(access_key: str) -> str:
    return bucketpolicy.key_principal(PROJECT, access_key)


def render(workloads=(), writers=(WRITER,), readers=(READER,)) -> dict:
    return fence.render_policy(
        BUCKET, PROJECT, list(workloads), ADMIN,
        writer_access_keys=list(writers), reader_access_keys=list(readers),
    )


def decide(policy: dict, access_key: str, action: str, resource: str) -> str:
    return bucketpolicy.decide(policy, arn(access_key), action, resource)


def statement(policy: dict, sid: str) -> dict:
    return next(s for s in policy["Statement"] if s["Sid"] == sid)


class TestThePutOnlyKeyCanOnlyAdd(unittest.TestCase):
    def setUp(self):
        self.policy = render()

    def test_it_can_put(self):
        self.assertEqual(decide(self.policy, WRITER, "s3:PutObject", OBJECT_ARN), "allow")

    def test_it_cannot_read_an_object_or_a_version_of_one(self):
        for action in ("s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAcl",
                       "s3:GetObjectTagging", "s3:GetObjectTorrent", "s3:RestoreObject"):
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, WRITER, action, OBJECT_ARN), "deny")

    def test_it_cannot_remove_an_object_a_version_or_an_upload_in_flight(self):
        for action in ("s3:DeleteObject", "s3:DeleteObjectVersion",
                       "s3:AbortMultipartUpload", "s3:DeleteObjectTagging"):
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, WRITER, action, OBJECT_ARN), "deny")

    def test_it_cannot_list_by_any_route(self):
        for action in ("s3:ListBucket", "s3:ListBucketVersions",
                       "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"):
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, WRITER, action, BUCKET_ARN), "deny")
        self.assertEqual(
            decide(self.policy, WRITER, "s3:ListMultipartUploadParts", OBJECT_ARN), "deny"
        )

    def test_it_cannot_touch_the_fence_or_the_bucket_configuration(self):
        for action in ("s3:PutBucketPolicy", "s3:GetBucketPolicy", "s3:PutLifecycleConfiguration",
                       "s3:PutBucketVersioning", "s3:DeleteBucket"):
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, WRITER, action, BUCKET_ARN), "deny")

    def test_every_object_action_but_the_put_is_denied_to_it(self):
        for action in bucketpolicy.OBJECT_ACTION_VOCABULARY:
            expected = "allow" if action == "s3:PutObject" else "deny"
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, WRITER, action, OBJECT_ARN), expected)

    def test_its_denial_does_not_rest_on_notprincipal_alone(self):
        # If this engine misread NotPrincipal, the catch-alls would stop
        # denying the writer. The Principal-scoped statements must still do it.
        without_catch_alls = {
            "Statement": [
                s for s in self.policy["Statement"] if "NotPrincipal" not in s
            ]
        }
        for action in ("s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion"):
            self.assertEqual(decide(without_catch_alls, WRITER, action, OBJECT_ARN), "deny")
        self.assertEqual(decide(without_catch_alls, WRITER, "s3:ListBucket", BUCKET_ARN), "deny")

    def test_its_allow_is_exactly_the_put_and_never_a_wildcard(self):
        allow = statement(self.policy, "AllowPutOnlyKeysPut")
        self.assertEqual(allow["Action"], ["s3:PutObject"])
        self.assertEqual(allow["Principal"], {"AWS": [arn(WRITER)]})
        self.assertEqual(allow["Resource"], f"{BUCKET_ARN}/*")

    def test_it_is_left_under_the_bucket_catch_all(self):
        catch_all = statement(self.policy, "DenyBucketAccessExceptNamedKeys")
        self.assertNotIn(arn(WRITER), catch_all["NotPrincipal"]["AWS"])
        self.assertIn(arn(WRITER), statement(
            self.policy, "DenyObjectAccessExceptNamedKeys")["NotPrincipal"]["AWS"])

    def test_every_writer_given_is_fenced(self):
        policy = render(writers=(WRITER, SECOND_WRITER))
        for key in (WRITER, SECOND_WRITER):
            self.assertEqual(decide(policy, key, "s3:PutObject", OBJECT_ARN), "allow")
            self.assertEqual(decide(policy, key, "s3:GetObject", OBJECT_ARN), "deny")


class TestTheReadOnlyKeyChangesNothing(unittest.TestCase):
    def setUp(self):
        self.policy = render()

    def test_it_can_get_and_list(self):
        for action in ("s3:GetObject", "s3:GetObjectVersion"):
            self.assertEqual(decide(self.policy, READER, action, OBJECT_ARN), "allow")
        for action in ("s3:ListBucket", "s3:ListBucketVersions"):
            self.assertEqual(decide(self.policy, READER, action, BUCKET_ARN), "allow")

    def test_it_cannot_write_or_remove(self):
        for action in ("s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
                       "s3:AbortMultipartUpload", "s3:PutObjectTagging", "s3:PutObjectAcl"):
            with self.subTest(action=action):
                self.assertEqual(decide(self.policy, READER, action, OBJECT_ARN), "deny")

    def test_it_cannot_touch_the_fence(self):
        for action in ("s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:GetBucketPolicy",
                       "s3:PutLifecycleConfiguration"):
            self.assertEqual(decide(self.policy, READER, action, BUCKET_ARN), "deny")


class TestTheOtherKeysAreUnchanged(unittest.TestCase):
    def test_a_read_write_key_alongside_the_roles_keeps_everything_it_had(self):
        policy = render(workloads=(WORKLOAD,))
        for action in ("s3:PutObject", "s3:GetObject", "s3:DeleteObject"):
            self.assertEqual(decide(policy, WORKLOAD, action, OBJECT_ARN), "allow")
        self.assertEqual(decide(policy, WORKLOAD, "s3:ListBucket", BUCKET_ARN), "allow")
        self.assertEqual(decide(policy, WORKLOAD, "s3:DeleteObjectVersion", OBJECT_ARN), "deny")

    def test_a_stranger_is_still_denied_everything(self):
        policy = render(workloads=(WORKLOAD,))
        for action in ("s3:PutObject", "s3:GetObject", "s3:DeleteObject"):
            self.assertEqual(decide(policy, STRANGER, action, OBJECT_ARN), "deny")
        self.assertEqual(decide(policy, STRANGER, "s3:ListBucket", BUCKET_ARN), "deny")
        self.assertEqual(bucketpolicy.decide(policy, "*", "s3:GetObject", OBJECT_ARN), "deny")

    def test_the_operator_keeps_the_bucket_and_the_data(self):
        policy = render()
        for action in bucketpolicy.RECOVERY_ACTIONS:
            self.assertEqual(decide(policy, ADMIN, action, BUCKET_ARN), "allow")
        for action in ("s3:GetObject", "s3:DeleteObjectVersion", "s3:PutObject"):
            self.assertEqual(decide(policy, ADMIN, action, OBJECT_ARN), "allow")

    def test_a_read_write_only_fence_is_the_document_it_always_was(self):
        # Re-rendering the existing bucket's policy must change nothing on it.
        policy = fence.render_policy(BUCKET, PROJECT, [WORKLOAD], ADMIN)
        self.assertEqual([s["Sid"] for s in policy["Statement"]], LEGACY_SIDS)
        named = [arn(WORKLOAD), arn(ADMIN)]
        for sid in ("DenyBucketAccessExceptNamedKeys", "DenyObjectAccessExceptNamedKeys"):
            self.assertEqual(statement(policy, sid)["NotPrincipal"]["AWS"], named)
        self.assertEqual(policy, fence.render_policy(
            BUCKET, PROJECT, [WORKLOAD], ADMIN, writer_access_keys=[], reader_access_keys=[]))

    def test_role_statements_follow_the_legacy_ones(self):
        sids = [s["Sid"] for s in render(workloads=(WORKLOAD,))["Statement"]]
        self.assertEqual([s for s in sids if s in LEGACY_SIDS], LEGACY_SIDS)
        for sid in ("AllowPutOnlyKeysPut", "AllowReadOnlyKeysObjectReads",
                    "AllowReadOnlyKeysBucketReads", "DenyPutOnlyKeysReadsAndRemovals",
                    "DenyPutOnlyKeysListing", "DenyReadOnlyKeysMutations"):
            self.assertIn(sid, sids)

    def test_a_writer_alone_renders_without_reader_statements(self):
        sids = [s["Sid"] for s in render(readers=())["Statement"]]
        self.assertNotIn("DenyReadOnlyKeysMutations", sids)
        self.assertIn("DenyPutOnlyKeysReadsAndRemovals", sids)

    def test_a_reader_alone_renders_without_writer_statements(self):
        sids = [s["Sid"] for s in render(writers=())["Statement"]]
        self.assertNotIn("AllowPutOnlyKeysPut", sids)
        self.assertIn("AllowReadOnlyKeysObjectReads", sids)


class TestTheDocumentIsEnforceable(unittest.TestCase):
    def test_no_statement_uses_notaction_or_a_refused_action(self):
        policy = render(workloads=(WORKLOAD,))
        for s in policy["Statement"]:
            self.assertNotIn("NotAction", s)
            actions = s["Action"] if isinstance(s["Action"], list) else [s["Action"]]
            self.assertEqual(set(actions) & bucketpolicy.PARSER_REJECTS, set(), s["Sid"])

    def test_every_deny_uses_a_plain_action_list(self):
        for s in render()["Statement"]:
            if s["Effect"] == "Deny":
                self.assertIn("Action", s)

    def test_the_apply_time_guard_accepts_the_role_fence(self):
        # configure_backup_bucket.py is what the operator runs to PUT this
        # document; a fence it refuses never reaches the bucket.
        for policy in (render(), render(workloads=(WORKLOAD,)),
                       fence.render_policy(BUCKET, PROJECT, [WORKLOAD], ADMIN)):
            configure_backup_bucket.assert_policy_fences_this_bucket(policy, BUCKET, arn(ADMIN))

    def test_the_apply_time_guard_still_refuses_an_unaccounted_exemption(self):
        # The widening above must not make it accept a narrow key whose other
        # actions reach the bucket through the project default.
        policy = render()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyPutOnlyKeysReadsAndRemovals"
        ]
        with self.assertRaises(configure_backup_bucket.BucketConfigError) as caught:
            configure_backup_bucket.assert_policy_fences_this_bucket(policy, BUCKET, arn(ADMIN))
        self.assertIn(arn(WRITER), str(caught.exception))


class TestRefusedRoleInput(unittest.TestCase):
    def test_a_key_in_two_roles_is_refused_and_named(self):
        with self.assertRaises(bucketpolicy.PolicyInputError) as caught:
            render(writers=(WRITER,), readers=(WRITER,))
        self.assertIn("put-only and read-only", str(caught.exception))
        with self.assertRaises(bucketpolicy.PolicyInputError):
            render(workloads=(WRITER,))

    def test_a_writer_given_twice_is_refused(self):
        with self.assertRaises(bucketpolicy.PolicyInputError) as caught:
            render(writers=(WRITER, WRITER))
        self.assertNotIn(" as ", str(caught.exception))

    def test_the_operator_cannot_be_a_narrow_key(self):
        for kwargs in ({"writers": (ADMIN,)}, {"readers": (ADMIN,), "writers": ()}):
            with self.assertRaises(bucketpolicy.PolicyInputError):
                render(**kwargs)

    def test_no_key_in_any_role_is_refused(self):
        with self.assertRaises(bucketpolicy.PolicyInputError):
            render(writers=(), readers=())

    def test_a_malformed_narrow_key_is_refused(self):
        for bad in ("short", "has:colon0000000000"):
            with self.assertRaises(bucketpolicy.PolicyInputError):
                render(writers=(bad,))
            with self.assertRaises(bucketpolicy.PolicyInputError):
                render(readers=(bad,), writers=())


class TestTheRoleGuardIsWired(unittest.TestCase):
    def test_assert_roles_hold_refuses_a_writer_that_can_read(self):
        policy = render()
        policy["Statement"] = [
            s for s in policy["Statement"]
            if s["Sid"] not in ("DenyPutOnlyKeysReadsAndRemovals",)
        ]
        principals = {bucketpolicy.READ_WRITE: [], bucketpolicy.PUT_ONLY: [arn(WRITER)],
                      bucketpolicy.READ_ONLY: [arn(READER)]}
        # The object catch-all still exempts the writer, so without its own
        # Deny it falls to the project default: allowed to read.
        with self.assertRaises(bucketpolicy.PolicyInputError) as caught:
            fence.assert_roles_hold(policy, principals, BUCKET_ARN, f"{BUCKET_ARN}/*")
        self.assertIn("put-only", str(caught.exception))

    def test_assert_roles_hold_refuses_a_reader_that_cannot_list(self):
        policy = render()
        statement(policy, "DenyBucketAccessExceptNamedKeys")["NotPrincipal"]["AWS"].remove(
            arn(READER))
        principals = {bucketpolicy.READ_WRITE: [], bucketpolicy.PUT_ONLY: [],
                      bucketpolicy.READ_ONLY: [arn(READER)]}
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.assert_roles_hold(policy, principals, BUCKET_ARN, f"{BUCKET_ARN}/*")

    def test_render_policy_calls_it(self):
        source = (_HERE / "render-bucket-fence-policy.py").read_text()
        self.assertIn("assert_roles_hold(policy, principals, bucket_arn, objects_arn)", source)


class TestTheCommandLine(unittest.TestCase):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fence.main(argv)
        return code, out.getvalue(), err.getvalue()

    def base(self):
        return ["--bucket", BUCKET, "--project-id", PROJECT, "--admin-access-key", ADMIN]

    def test_writer_and_reader_flags_reach_the_policy(self):
        code, out, _ = self.run_main(
            self.base() + ["--writer-access-key", WRITER, "--reader-access-key", READER])
        self.assertEqual(code, 0)
        policy = json.loads(out)
        self.assertEqual(policy, render())

    def test_the_command_sequence_carries_the_role_fence(self):
        code, out, _ = self.run_main(
            self.base() + ["--writer-access-key", WRITER, "--commands", "existing-bucket"])
        self.assertEqual(code, 0)
        self.assertIn("DenyPutOnlyKeysReadsAndRemovals", out)
        self.assertIn(arn(WRITER), out)

    def test_no_key_at_all_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_main(self.base())
        self.assertEqual(caught.exception.code, 2)

    def test_a_key_in_two_roles_exits_nonzero(self):
        code, out, err = self.run_main(
            self.base() + ["--writer-access-key", WRITER, "--reader-access-key", WRITER])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("put-only and read-only", err)

    def test_the_self_test_covers_the_roles(self):
        code, _, err = self.run_main(["--self-test"])
        self.assertEqual(code, 0)
        self.assertIn("self-test: ok", err)


ADMIN_PROJECT = "1000001"
WORKLOAD_PROJECT = "1000002"
READER_PROJECT = "1000003"
WRITER_PROJECT = "1000004"
STATE_BUCKET = "branchleft-estate-state"
STATE_BUCKET_ARN = f"arn:aws:s3:::{STATE_BUCKET}"
STATE_OBJECT_ARN = f"{STATE_BUCKET_ARN}/.pulumi/stacks/estate.json"


def split_arn(project: str, access_key: str) -> str:
    return bucketpolicy.key_principal(project, access_key)


def render_split() -> dict:
    """The estate-state bucket: the operator, the state key and the read-only
    key, each in a project of its own, as one project per storage key lays
    them out."""
    return fence.render_policy(
        STATE_BUCKET, ADMIN_PROJECT, [WORKLOAD], ADMIN,
        reader_access_keys=[READER],
        workload_project_id=WORKLOAD_PROJECT, reader_project_id=READER_PROJECT,
    )


class TestEachKeyIsNamedUnderItsOwnProject(unittest.TestCase):
    """A principal built from the wrong project names nobody. Under a
    `NotPrincipal` deny that is not an inert statement: it denies the real
    key, and the bucket reads as fenced while the pipeline is locked out."""

    def setUp(self):
        self.policy = render_split()
        self.admin = split_arn(ADMIN_PROJECT, ADMIN)
        self.workload = split_arn(WORKLOAD_PROJECT, WORKLOAD)
        self.reader = split_arn(READER_PROJECT, READER)

    def test_every_exempted_principal_carries_its_own_project(self):
        named = statement(self.policy, "DenyObjectAccessExceptNamedKeys")["NotPrincipal"]["AWS"]
        self.assertEqual(sorted(named), sorted([self.admin, self.workload, self.reader]))
        bucket_named = statement(
            self.policy, "DenyBucketAccessExceptNamedKeys")["NotPrincipal"]["AWS"]
        self.assertEqual(sorted(bucket_named), sorted([self.admin, self.workload, self.reader]))
        self.assertEqual(
            statement(self.policy, "AllowOperatorFullControl")["Principal"]["AWS"], [self.admin])

    def test_the_real_keys_get_their_jobs_and_nothing_more(self):
        for principal, action, resource, expected in [
            (self.admin, "s3:PutBucketPolicy", STATE_BUCKET_ARN, "allow"),
            (self.workload, "s3:PutObject", STATE_OBJECT_ARN, "allow"),
            (self.workload, "s3:GetObject", STATE_OBJECT_ARN, "allow"),
            (self.workload, "s3:ListBucket", STATE_BUCKET_ARN, "allow"),
            (self.workload, "s3:PutBucketPolicy", STATE_BUCKET_ARN, "deny"),
            (self.reader, "s3:GetObject", STATE_OBJECT_ARN, "allow"),
            (self.reader, "s3:ListBucket", STATE_BUCKET_ARN, "allow"),
            (self.reader, "s3:PutObject", STATE_OBJECT_ARN, "deny"),
            (self.reader, "s3:DeleteObject", STATE_OBJECT_ARN, "deny"),
        ]:
            with self.subTest(principal=principal, action=action):
                self.assertEqual(
                    bucketpolicy.decide(self.policy, principal, action, resource), expected)

    def test_the_same_access_keys_under_the_operators_project_are_strangers(self):
        for access_key in (WORKLOAD, READER):
            for action, resource in (
                ("s3:GetObject", STATE_OBJECT_ARN), ("s3:ListBucket", STATE_BUCKET_ARN)
            ):
                with self.subTest(access_key=access_key, action=action):
                    self.assertEqual(
                        bucketpolicy.decide(
                            self.policy, split_arn(ADMIN_PROJECT, access_key), action, resource),
                        "deny",
                    )

    def test_the_apply_time_guard_accepts_the_split_policy(self):
        configure_backup_bucket.assert_policy_fences_this_bucket(
            self.policy, STATE_BUCKET, self.admin)

    def test_a_put_only_key_in_its_own_project_is_named_under_it(self):
        policy = fence.render_policy(
            "branchleft-backups", ADMIN_PROJECT, [], ADMIN,
            writer_access_keys=[WRITER], reader_access_keys=[READER],
            writer_project_id=WRITER_PROJECT, reader_project_id=READER_PROJECT,
        )
        writer = split_arn(WRITER_PROJECT, WRITER)
        self.assertEqual(statement(policy, "AllowPutOnlyKeysPut")["Principal"]["AWS"], [writer])
        self.assertEqual(
            statement(policy, "DenyPutOnlyKeysReadsAndRemovals")["Principal"]["AWS"], [writer])
        self.assertEqual(
            bucketpolicy.decide(policy, writer, "s3:PutObject", f"{BUCKET_ARN}/dumps/x"), "allow")
        self.assertEqual(
            bucketpolicy.decide(policy, writer, "s3:GetObject", f"{BUCKET_ARN}/dumps/x"), "deny")

    def test_omitting_the_role_projects_is_the_single_project_document(self):
        self.assertEqual(
            fence.render_policy(BUCKET, PROJECT, [WORKLOAD], ADMIN, reader_access_keys=[READER]),
            fence.render_policy(
                BUCKET, PROJECT, [WORKLOAD], ADMIN, reader_access_keys=[READER],
                workload_project_id=PROJECT, reader_project_id=PROJECT),
        )

    def test_a_malformed_role_project_id_is_refused(self):
        with self.assertRaises(bucketpolicy.PolicyInputError):
            fence.render_policy(
                STATE_BUCKET, ADMIN_PROJECT, [WORKLOAD], ADMIN, workload_project_id="p1000002")


class TestThePerKeyProjectFlags(unittest.TestCase):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = fence.main(argv)
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def split(self):
        return [
            "--bucket", STATE_BUCKET, "--admin-access-key", ADMIN,
            "--admin-project-id", ADMIN_PROJECT,
            "--workload-access-key", WORKLOAD, "--workload-project-id", WORKLOAD_PROJECT,
            "--reader-access-key", READER, "--reader-project-id", READER_PROJECT,
        ]

    def test_the_flags_reach_the_policy(self):
        code, out, _ = self.run_main(self.split())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), render_split())

    def test_the_command_sequence_carries_each_projects_principal(self):
        code, out, _ = self.run_main(self.split() + ["--commands", "existing-bucket"])
        self.assertEqual(code, 0)
        for project, key in (
            (ADMIN_PROJECT, ADMIN), (WORKLOAD_PROJECT, WORKLOAD), (READER_PROJECT, READER)
        ):
            self.assertIn(split_arn(project, key), out)

    def test_project_id_is_the_single_project_form_and_cannot_be_mixed(self):
        code, out, err = self.run_main(
            ["--bucket", STATE_BUCKET, "--admin-access-key", ADMIN, "--project-id", ADMIN_PROJECT,
             "--workload-access-key", WORKLOAD, "--workload-project-id", WORKLOAD_PROJECT])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--workload-project-id", err)

    def test_a_role_with_keys_and_no_project_id_is_refused_not_defaulted(self):
        argv = [a for a in self.split() if a not in ("--reader-project-id", READER_PROJECT)]
        code, out, err = self.run_main(argv)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--reader-project-id", err)

    def test_the_operators_project_is_required(self):
        argv = [a for a in self.split() if a not in ("--admin-project-id", ADMIN_PROJECT)]
        code, out, err = self.run_main(argv)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--admin-project-id", err)

    def test_a_project_id_naming_no_key_is_refused(self):
        code, out, err = self.run_main(self.split() + ["--writer-project-id", WRITER_PROJECT])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--writer-project-id", err)


if __name__ == "__main__":
    unittest.main()
