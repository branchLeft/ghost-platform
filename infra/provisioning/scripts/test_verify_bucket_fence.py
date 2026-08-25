"""Tests for the fence verifier, built around the mistake that produced it.

The historical failure was recording one `AccessDenied` as proof that a
credential was scoped to one bucket, when the denial was in fact a project
boundary and the credential was scoped to nothing. Every test here that matters
is a variation on that: a denial arriving for the wrong reason must never come
out of this file as a pass.

Responses are the real shapes. The AWS CLI renders every service error as
`An error occurred (Code) when calling the Operation operation: message` on
stderr and exits non-zero, and the listing that started
branchLeft/workspace#286 was an HTTP 200 carrying object keys -- which the CLI
reports simply as exit 0.
"""

import contextlib
import importlib.util
import io
import os
import pathlib
import unittest
from unittest import mock

_MODULE_PATH = pathlib.Path(__file__).with_name("verify-bucket-fence.py")
_spec = importlib.util.spec_from_file_location("verify_bucket_fence", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
verify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify)

FENCED = "branchleft-db-backups"
CONTROL = "branchleft-tenant-pulumi-state"
POLICY_FILE = "/tmp/branchleft-db-backups-policy.json"

OPERATOR_KEY = "O" * 20
WORKLOAD_KEY = "W" * 20
FOREIGN_KEY = "F" * 20

ENVIRONMENT = {
    "FENCE_OPERATOR_ACCESS_KEY_ID": OPERATOR_KEY,
    "FENCE_OPERATOR_SECRET_ACCESS_KEY": "operator-secret",
    "FENCE_WORKLOAD_ACCESS_KEY_ID": WORKLOAD_KEY,
    "FENCE_WORKLOAD_SECRET_ACCESS_KEY": "workload-secret",
    "FENCE_FOREIGN_ACCESS_KEY_ID": FOREIGN_KEY,
    "FENCE_FOREIGN_SECRET_ACCESS_KEY": "foreign-secret",
}

# The two verbatim CLI renderings this file classifies.
ACCESS_DENIED = (
    "\nAn error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied\n"
)
INVALID_KEY = (
    "\nAn error occurred (InvalidAccessKeyId) when calling the ListObjectsV2 operation: "
    "The AWS Access Key Id you provided does not exist in our records.\n"
)
NO_SUCH_BUCKET_POLICY = (
    "\nAn error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation: "
    "The bucket policy does not exist\n"
)


class Completed:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class Runner:
    """Answers each probe by (role, subcommand, bucket), recording every call."""

    def __init__(self, answers: dict, default=None):
        self.answers = answers
        self.default = default or Completed(0)
        self.calls: list[tuple] = []

    def __call__(self, argv, env):
        subcommand = argv[argv.index("s3api") + 1]
        bucket = argv[argv.index("--bucket") + 1] if "--bucket" in argv else None
        role = {
            OPERATOR_KEY: "operator",
            WORKLOAD_KEY: "workload",
            FOREIGN_KEY: "foreign",
        }.get(env.get("AWS_ACCESS_KEY_ID"), "anonymous")
        self.calls.append((role, subcommand, bucket))
        return self.answers.get((role, subcommand, bucket), self.default)


def a_fully_working_fence() -> dict:
    """Every probe answering the way a correct, live fence answers."""
    denied = Completed(1, stderr=ACCESS_DENIED)
    return {
        ("workload", "get-bucket-policy", FENCED): denied,
        ("workload", "put-bucket-policy", FENCED): denied,
        ("workload", "put-bucket-acl", FENCED): denied,
        ("workload", "put-bucket-versioning", FENCED): denied,
        ("foreign", "list-objects-v2", FENCED): denied,
        ("foreign", "get-object", FENCED): denied,
        ("foreign", "put-object", FENCED): denied,
        ("anonymous", "list-objects-v2", FENCED): denied,
        ("operator", "list-object-versions", FENCED): Completed(0, stdout="{}"),
    }


def run(answers, environment=None):
    runner = Runner(answers)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = verify.main(
            [
                "--bucket",
                FENCED,
                "--foreign-control-bucket",
                CONTROL,
                "--policy-file",
                POLICY_FILE,
            ],
            runner=runner,
            environ=dict(environment or ENVIRONMENT),
        )
    return code, out.getvalue(), runner


class TestClassification(unittest.TestCase):
    def test_a_clean_exit_is_allowed(self):
        self.assertEqual(verify.classify(0, "")[0], "allowed")

    def test_the_real_access_denied_rendering_is_a_denial(self):
        self.assertEqual(verify.classify(255, ACCESS_DENIED)[0], "denied")

    def test_a_dead_credential_is_an_error_and_never_a_denial(self):
        # This is the whole point: a key that reaches nothing fails exactly
        # like a fenced key does, to anyone reading the exit code.
        outcome, reason = verify.classify(255, INVALID_KEY)
        self.assertEqual(outcome, "error")
        self.assertIn("says nothing about the fence", reason)

    def test_an_unrecognised_service_error_is_an_error(self):
        outcome, reason = verify.classify(255, NO_SUCH_BUCKET_POLICY)
        self.assertEqual(outcome, "error")
        self.assertIn("NoSuchBucketPolicy", reason)

    def test_output_with_no_service_error_at_all_is_an_error(self):
        outcome, _ = verify.classify(1, "Unable to locate credentials\n")
        self.assertEqual(outcome, "error")


class TestBothDirections(unittest.TestCase):
    def test_a_correct_fence_passes_every_check(self):
        code, output, _ = run(a_fully_working_fence())
        self.assertEqual(code, 0, output)
        self.assertNotIn(verify.FAIL, output)
        self.assertNotIn(verify.INCONCLUSIVE, output)

    def test_the_finding_that_opened_the_issue_fails(self):
        # A foreign key listing the backup bucket returned 200 with binlog
        # object keys. Nothing else about the estate looked wrong.
        answers = a_fully_working_fence()
        answers[("foreign", "list-objects-v2", FENCED)] = Completed(
            0, stdout='{"Contents": [{"Key": "binlogs/..."}]}'
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("FAIL", output)
        self.assertIn("foreign key cannot list the bucket", output)

    def test_a_fence_that_denies_the_workload_fails_rather_than_passing(self):
        # A policy that denies everybody is an outage, not a boundary, and on
        # the backup bucket it is silent until the next restore.
        answers = a_fully_working_fence()
        answers[("workload", "put-object", FENCED)] = Completed(1, stderr=ACCESS_DENIED)
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("the key that must keep working is denied", output)


class TestControlsMakeDenialsMeanSomething(unittest.TestCase):
    def test_a_denial_from_a_credential_that_reaches_nothing_is_inconclusive(self):
        # The exact historical mistake: an AccessDenied recorded as proof, from
        # a key whose entitlement was never established.
        answers = a_fully_working_fence()
        answers[("foreign", "list-objects-v2", CONTROL)] = Completed(1, stderr=ACCESS_DENIED)
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)
        self.assertIn("is not evidence about the fence", output)

    def test_a_denial_from_a_mistyped_key_is_inconclusive(self):
        answers = a_fully_working_fence()
        answers[("foreign", "list-objects-v2", CONTROL)] = Completed(1, stderr=INVALID_KEY)
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)

    def test_an_inconclusive_run_never_exits_zero(self):
        answers = a_fully_working_fence()
        answers[("workload", "get-bucket-policy", FENCED)] = Completed(
            1, stderr=NO_SUCH_BUCKET_POLICY
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("An inconclusive check is not a pass", output)

    def test_the_anonymous_check_declares_that_it_has_no_control(self):
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key="fence-probe/x.txt",
        )
        anonymous = [check for check in checks if check.probe.role == "anonymous"]
        self.assertEqual(len(anonymous), 1)
        self.assertIsNone(anonymous[0].control)
        self.assertIn("no control exists", anonymous[0].note)

    def test_every_other_denial_check_carries_a_control_on_its_own_credential(self):
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key="fence-probe/x.txt",
        )
        for check in checks:
            if check.expect != "deny" or check.probe.role == "anonymous":
                continue
            with self.subTest(check=check.name):
                self.assertIsNotNone(check.control)
                self.assertEqual(check.control.role, check.probe.role)


class TestLockout(unittest.TestCase):
    def test_a_bucket_that_cannot_be_re_administered_is_shouted_about(self):
        answers = a_fully_working_fence()
        answers[("operator", "put-bucket-policy", FENCED)] = Completed(1, stderr=ACCESS_DENIED)
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("THE BUCKET MAY BE LOCKED", output)
        self.assertIn("Hetzner support request", output)

    def test_the_recoverability_check_runs_before_anything_touches_the_bucket(self):
        _, _, runner = run(a_fully_working_fence())
        put_policy = runner.calls.index(("operator", "put-bucket-policy", FENCED))
        put_object = runner.calls.index(("workload", "put-object", FENCED))
        self.assertLess(put_policy, put_object)


class TestProbesAreNonDestructive(unittest.TestCase):
    def test_no_probe_would_damage_the_bucket_if_the_fence_let_it_through(self):
        # Every denial probe has to be safe on success, because a probe whose
        # success is the incident cannot be run on a live bucket at all.
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key="fence-probe/x.txt",
        )
        args = [" ".join(check.probe.args) for check in checks if check.expect == "deny"]
        joined = "\n".join(args)
        self.assertNotIn("Status=Suspended", joined)
        self.assertNotIn("public-read", joined)
        self.assertNotIn("delete-bucket", joined)
        self.assertNotIn("delete-bucket-policy", joined)

    def test_the_workload_write_probes_stay_under_the_probe_prefix(self):
        # prune_backups.py reads `dumps/` and `binlogs/`; a probe object under
        # either would enter the retention decision.
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key=f"{verify.PROBE_PREFIX}x.txt",
        )
        for check in checks:
            if "--key" not in check.probe.args:
                continue
            key = check.probe.args[check.probe.args.index("--key") + 1]
            with self.subTest(check=check.name):
                self.assertTrue(key.startswith(verify.PROBE_PREFIX))


class TestCleanup(unittest.TestCase):
    def test_every_probe_object_version_and_delete_marker_is_removed(self):
        # A plain delete on a versioned bucket leaves the prior version
        # readable at ?versionId=, so the workload's delete is a check, not a
        # cleanup.
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = Completed(
            0,
            stdout='{"Versions": [{"Key": "fence-probe/a.txt", "VersionId": "v1"}],'
            ' "DeleteMarkers": [{"Key": "fence-probe/a.txt", "VersionId": "v2"}]}',
        )
        _, _, runner = run(answers)
        deletes = [call for call in runner.calls if call == ("operator", "delete-object", FENCED)]
        self.assertEqual(len(deletes), 2)

    def test_a_probe_object_left_behind_fails_the_run(self):
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = Completed(
            1, stderr=ACCESS_DENIED
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("CLEANUP", output)


class TestSetupRefusals(unittest.TestCase):
    def test_missing_credentials_stop_the_run_with_no_verdict(self):
        environment = dict(ENVIRONMENT)
        del environment["FENCE_FOREIGN_ACCESS_KEY_ID"]
        with self.assertRaises(verify.VerifierError):
            verify.read_credentials(environment)

    def test_two_roles_on_one_key_stop_the_run(self):
        # Otherwise every check that distinguishes them is meaningless and the
        # run reports a fence it never tested.
        environment = dict(ENVIRONMENT)
        environment["FENCE_FOREIGN_ACCESS_KEY_ID"] = WORKLOAD_KEY
        with self.assertRaises(verify.VerifierError):
            verify.read_credentials(environment)

    def test_probes_never_inherit_an_ambient_credential(self):
        # An operator arrives at this script with a key already exported, from
        # the put-bucket-policy step immediately before it. A probe that
        # silently ran as that key is the failure with no symptom: the
        # anonymous check would pass as the operator, and the workload denials
        # would all report FAIL on a correct bucket.
        verifier = verify.Verifier(
            endpoint="https://hel1.your-objectstorage.com",
            region="hel1",
            credentials={"workload": (WORKLOAD_KEY, "workload-secret")},
            runner=Runner({}),
        )
        ambient = {
            "AWS_ACCESS_KEY_ID": OPERATOR_KEY,
            "AWS_SECRET_ACCESS_KEY": "operator-secret",
            "AWS_PROFILE": "default",
        }
        with mock.patch.dict(os.environ, ambient, clear=False):
            anonymous = verifier.env_for("anonymous")
            workload = verifier.env_for("workload")
        self.assertNotIn("AWS_ACCESS_KEY_ID", anonymous)
        self.assertNotIn("AWS_PROFILE", anonymous)
        self.assertEqual(workload["AWS_ACCESS_KEY_ID"], WORKLOAD_KEY)
        self.assertNotIn("AWS_PROFILE", workload)


if __name__ == "__main__":
    unittest.main()
