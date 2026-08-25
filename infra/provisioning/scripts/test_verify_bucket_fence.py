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
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

_MODULE_PATH = pathlib.Path(__file__).with_name("verify-bucket-fence.py")
_spec = importlib.util.spec_from_file_location("verify_bucket_fence", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
verify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify)

FENCED = "branchleft-db-backups"
CONTROL = "branchleft-tenant-pulumi-state"

OPERATOR_KEY = "O" * 20
WORKLOAD_KEY = "W" * 20
FOREIGN_KEY = "F" * 20
ACCOUNT = "p00000000"

OPERATOR_ARN = f"arn:aws:iam:::user/{ACCOUNT}:{OPERATOR_KEY}"
WORKLOAD_ARN = f"arn:aws:iam:::user/{ACCOUNT}:{WORKLOAD_KEY}"

POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "DenyBucketConfigurationExceptOperator",
            "Effect": "Deny",
            "NotPrincipal": {"AWS": [OPERATOR_ARN]},
            "NotAction": ["s3:ListBucket"],
            "Resource": f"arn:aws:s3:::{FENCED}",
        },
        {
            "Sid": "DenyObjectAccessExceptNamedKeys",
            "Effect": "Deny",
            "NotPrincipal": {"AWS": [WORKLOAD_ARN, OPERATOR_ARN]},
            "Action": "s3:*",
            "Resource": f"arn:aws:s3:::{FENCED}/*",
        },
    ],
}

_TEMP = tempfile.TemporaryDirectory()
POLICY_FILE = str(pathlib.Path(_TEMP.name) / "policy.json")
pathlib.Path(POLICY_FILE).write_text(json.dumps(POLICY))

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
        ("workload", "put-bucket-versioning", FENCED): denied,
        ("foreign", "list-objects-v2", FENCED): denied,
        ("foreign", "get-object", FENCED): denied,
        ("foreign", "put-object", FENCED): denied,
        ("anonymous", "list-objects-v2", FENCED): denied,
        ("operator", "list-object-versions", FENCED): Completed(0, stdout="{}"),
        ("operator", "get-bucket-policy", FENCED): Completed(0, stdout=json.dumps(POLICY)),
        ("operator", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
        ("workload", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
        ("foreign", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
    }


def run(answers, environment=None, extra_args=()):
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
                *extra_args,
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

    def test_a_workload_that_can_write_but_not_read_fails(self):
        # The object Allow and the object Deny are separate statements. A write
        # that succeeds says nothing about the read, and a backup nobody can
        # read back is not a backup.
        answers = a_fully_working_fence()
        answers[("workload", "get-object", FENCED)] = Completed(1, stderr=ACCESS_DENIED)
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("workload can read an object back", output)
        self.assertIn(verify.FAIL, output)

    def test_the_workload_read_probe_is_always_in_the_check_set(self):
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key="fence-probe/x.txt",
        )
        reads = [
            check
            for check in checks
            if check.probe.role == "workload"
            and check.expect == "allow"
            and check.probe.args[0] == "get-object"
        ]
        self.assertEqual(len(reads), 1)


class TestStoredPolicy(unittest.TestCase):
    def test_a_stored_policy_that_differs_from_the_sent_one_fails(self):
        # This backend accepts a configuration and silently drops an element of
        # it. Every other probe would still pass -- they would simply be
        # measuring a different fence.
        answers = a_fully_working_fence()
        trimmed = {"Version": POLICY["Version"], "Statement": POLICY["Statement"][:1]}
        answers[("operator", "get-bucket-policy", FENCED)] = Completed(
            0, stdout=json.dumps(trimmed)
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("the stored policy is not the document that was sent", output)

    def test_a_reordered_statement_list_is_not_a_mismatch(self):
        answers = a_fully_working_fence()
        reordered = {
            "Version": POLICY["Version"],
            "Statement": list(reversed(POLICY["Statement"])),
        }
        answers[("operator", "get-bucket-policy", FENCED)] = Completed(
            0, stdout=json.dumps(reordered)
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 0, output)


class TestPreflight(unittest.TestCase):
    def test_a_policy_rendered_against_the_wrong_account_is_caught_before_the_put(self):
        # One mistyped digit in --project-id. The generator's own check passes,
        # because it compares a fabricated ARN against itself. Live, the
        # NotPrincipal names a principal that does not exist, so the operator's
        # exemption exempts nobody and the bucket becomes unrecoverable.
        answers = a_fully_working_fence()
        for role in ("operator", "workload", "foreign"):
            answers[(role, "list-buckets", None)] = Completed(0, stdout="p99999999\n")
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn("DO NOT APPLY THIS POLICY", output)
        self.assertIn("the policy exempts THIS operator credential", output)

    def test_a_correctly_rendered_policy_passes_preflight(self):
        code, output, _ = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertEqual(code, 0, output)
        self.assertIn("safe to apply", output)

    def test_preflight_writes_nothing(self):
        _, _, runner = run(a_fully_working_fence(), extra_args=["--preflight"])
        mutations = [
            call
            for call in runner.calls
            if call[1].startswith("put-") or call[1].startswith("delete-")
        ]
        self.assertEqual(mutations, [])

    def test_a_foreign_key_in_another_account_fails_preflight(self):
        # Its denials would be the account boundary, which is precisely the
        # substitution that produced branchLeft/workspace#286.
        answers = a_fully_working_fence()
        answers[("foreign", "list-buckets", None)] = Completed(0, stdout="p99999999\n")
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn("all three credentials are in one account", output)

    def test_a_credential_that_cannot_resolve_its_account_is_inconclusive(self):
        answers = a_fully_working_fence()
        answers[("operator", "list-buckets", None)] = Completed(1, stderr=INVALID_KEY)
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)


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
    # The property, stated once: a denial probe runs against a live production
    # bucket, so its SUCCESS must leave that bucket exactly as it was. Anything
    # whose success changes bucket state is either removed or gated behind an
    # explicit assertion that the change is a no-op.
    SAFE_ON_SUCCESS = {
        # Reads.
        "get-bucket-policy",
        "get-object",
        "list-objects-v2",
        "list-object-versions",
        "head-object",
        # Writes whose payload is the state the bucket is already in.
        "put-bucket-policy",
    }
    GATED_ON_ASSERTED_STATE = {"put-bucket-versioning"}

    def _denial_probes(self, **kwargs):
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key=f"{verify.PROBE_PREFIX}x.txt",
            **kwargs,
        )
        return [check.probe for check in checks if check.expect == "deny"]

    def test_every_default_denial_probe_is_a_no_op_on_success(self):
        for probe in self._denial_probes():
            operation = probe.args[0]
            with self.subTest(operation=operation):
                # put-object into a foreign bucket creates an object, which
                # cleanup removes; that is the one deliberate exception.
                if operation == "put-object":
                    continue
                self.assertIn(operation, self.SAFE_ON_SUCCESS)

    def test_a_probe_that_changes_bucket_state_only_runs_when_that_state_is_asserted(self):
        # Turning versioning on for a bucket that has it off, and no lifecycle
        # rule, retains every superseded object forever. That is storage growth
        # caused by the verification rather than found by it.
        default = {probe.args[0] for probe in self._denial_probes()}
        gated = {probe.args[0] for probe in self._denial_probes(versioning_already_enabled=True)}
        self.assertEqual(gated - default, self.GATED_ON_ASSERTED_STATE)
        self.assertFalse(default & self.GATED_ON_ASSERTED_STATE)

    def test_no_probe_replaces_the_bucket_acl(self):
        # `put-bucket-acl` replaces rather than merges, so it is a no-op only
        # if the current ACL is exactly what is sent -- which nothing here can
        # assert. The bucket-configuration deny is one statement, so
        # get/put-bucket-policy already prove it applies.
        for probe in self._denial_probes(versioning_already_enabled=True):
            self.assertNotEqual(probe.args[0], "put-bucket-acl")

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

    def test_dry_run_lists_the_matrix_and_touches_nothing(self):
        runner = Runner({})
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
                    "--dry-run",
                ],
                runner=runner,
                environ={},
            )
        self.assertEqual(code, 0)
        self.assertEqual(runner.calls, [])
        self.assertIn("workload can read an object back", out.getvalue())

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
