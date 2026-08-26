"""Tests for the fence verifier, built around the mistake that produced it.

The historical failure was recording one `AccessDenied` as proof that a
credential was scoped to one bucket, when the denial was in fact a project
boundary and the credential was scoped to nothing. Every test here that matters
is a variation on that: a denial arriving for the wrong reason must never come
out of this file as a pass.

There is a second mistake recorded here, and it belongs to this file. Every
object-read test once fed `classify()` a hand-written
`An error occurred (AccessDenied)` stderr, which is the shape the CLI renders
for most commands -- but not for `get-object` against this endpoint, which
cannot render an error response for that command at all. The suite passed while
the probe it covered could not reach a verdict. So responses here are not
"the real shapes" on assertion: each fixture states whether it was observed on
the wire or written, and `TestFixtureProvenance` refuses an unlabelled one.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
import urllib.parse
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


class Completed:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class Response(Completed):
    """A `CompletedProcess`-shaped fixture, with where it came from attached.

    `source` opens with `observed:` or `constructed:` and nothing else. A
    fixture observed on the wire constrains the code; one written here
    constrains only what its author expected, which is how the object-read
    probes shipped unable to reach a verdict.
    """

    def __init__(self, source: str, returncode: int, stdout: str = "", stderr: str = ""):
        super().__init__(returncode, stdout, stderr)
        self.source = source


ENDPOINT_HOST = "hel1.your-objectstorage.com"
AWS_CLI = "observed: aws-cli/2.36.25 against " + ENDPOINT_HOST
CURL = "observed: curl 8.4.0 against " + ENDPOINT_HOST

# botocore's documented rendering, which `classify` is written against.
#
# THIS ENDPOINT DOES NOT PRODUCE IT FOR A DENIAL. Its storage engine returns
# errors with an empty `<Message></Message>` and the client crashes rather than
# render them -- see `AWS_ACCESS_DENIED_CRASH` below, which is what actually
# comes back. These three stay because they are the contract `classify` has to
# keep for any response that IS rendered (the gateway's `NoSuchBucket` is one),
# and because the checks built on them are about control logic rather than
# about wire format. They are labelled here rather than left to be mistaken for
# observations, which is the whole failure this file is recording.
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

# The defect, and it is wider than one command. This endpoint's storage engine
# returns errors with an empty `<Message></Message>`, and the client exits 255
# with a client-internal message and an empty stdout rather than render one.
# The same crash was captured from `get-object`, `list-objects-v2`,
# `get-bucket-policy`, `put-object` and `list-buckets`, for `AccessDenied` and
# `InvalidAccessKeyId` alike -- unsigned in the first case, with a deliberately
# invalid key in the second, so no real credential produced any of them.
AWS_GET_OBJECT_CRASH = Response(
    AWS_CLI + " (get-object)",
    255,
    stderr="\naws: [ERROR]: argument of type 'NoneType' is not a container or iterable\n",
)

# The same crash, from the command the runbook's denial probes actually use.
# This is why `classify` cannot reach a verdict for those probes either, and
# why section 1f cannot come back clean on the CLI transport.
AWS_ACCESS_DENIED_CRASH = Response(
    AWS_CLI + " (list-objects-v2, unsigned, on a bucket that exists)",
    255,
    stderr="\naws: [ERROR]: argument of type 'NoneType' is not a container or iterable\n",
)

# What renders, and why the failure reads at first as one broken command: the
# gateway's own `NoSuchBucket` carries a real message.
AWS_NO_SUCH_BUCKET_RENDERS = Response(
    AWS_CLI + " (list-objects-v2, unsigned, on a bucket that does not exist)",
    254,
    stderr="\naws: [ERROR]: An error occurred (NoSuchBucket) when calling the "
    "ListObjectsV2 operation: The specified bucket does not exist.\n",
)

# Why `head-object` is not the fix. It renders its error cleanly, and renders a
# refusal as the code `403` -- an HTTP status, not an S3 error code, so
# `DENIAL_CODES` cannot match it and every denial would arrive as INCONCLUSIVE
# by a second route.
AWS_HEAD_OBJECT_FORBIDDEN = Response(
    AWS_CLI,
    254,
    stderr="\naws: [ERROR]: An error occurred (403) when calling the HeadObject "
    "operation: Forbidden\n",
)

# The signed-HTTP transport. `stdout` is the response body, then the status on
# its own line, which is what `--write-out '\n%{http_code}'` produces.
#
# `RequestId` and `HostId` are replaced with the `N/A` this endpoint itself
# returns on some paths: they name one request on Hetzner's side and carry
# nothing a fixture needs.
CURL_ACCESS_DENIED = Response(
    CURL + ", UNSIGNED, so no credential was involved. A signed read refused by a "
    "fence is expected to carry this same code; that is the part only a live "
    "run with real credentials can confirm",
    0,
    stdout='<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code>'
    f"<Message></Message><BucketName>{FENCED}</BucketName>"
    "<RequestId>N/A</RequestId><HostId>N/A</HostId></Error>\n403",
)

# The same 403 as a denial, carrying a code that is not one. This is the pair
# that makes an HTTP status useless on its own.
CURL_INVALID_ACCESS_KEY = Response(
    CURL + ", signed with a deliberately invalid key",
    0,
    stdout='<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code>'
    "<Message></Message><RequestId>N/A</RequestId><HostId>N/A</HostId></Error>\n403",
)

# A third rendering from the same endpoint: pretty-printed, with a different
# element set. The verdict is parsed out of the document rather than matched in
# the text because these do not agree on whitespace, and the next one need not
# either.
CURL_NO_SUCH_BUCKET = Response(
    CURL + ", unsigned",
    0,
    stdout='<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n    <Code>NoSuchBucket</Code>\n'
    "    <Message>The specified bucket does not exist.</Message>\n"
    "    <RequestId>N/A</RequestId>\n    <HostId>N/A</HostId>\n</Error>\n404",
)

CURL_NO_SUCH_KEY = Response(
    "constructed: the owner observed `<Error><Code>NoSuchKey</Code><BucketName>...` "
    f"against {ENDPOINT_HOST} but transcribed it truncated, so the closing elements "
    "and the status line here are written rather than captured",
    0,
    stdout=f"<Error><Code>NoSuchKey</Code><BucketName>{FENCED}</BucketName></Error>\n404",
)

CURL_OK = Response(
    "constructed: a successful read needs a credential that reaches the bucket. Only "
    "the status is load-bearing -- a 2xx is `allowed` and the body is never read on "
    "success -- and the body-then-status framing it relies on was observed",
    0,
    stdout="\n200",
)

CURL_403_NO_DOCUMENT = Response(
    "constructed: a refusal carrying no error document. The fail-safe case, which "
    "nothing observed can be relied on to keep producing",
    0,
    stdout="\n403",
)

CURL_BAD_GATEWAY_HTML = Response(
    "constructed: an HTML error page from something sitting in front of the endpoint",
    0,
    stdout="<html><head><title>502 Bad Gateway</title></head></html>\n502",
)

CURL_CONNECTION_REFUSED = Response(
    "observed: curl 8.4.0 against a closed port",
    7,
    stdout="\n000",
    stderr="curl: (7) Failed to connect to 127.0.0.1 port 1 after 0 ms: "
    "Couldn't connect to server\n",
)

# How a curl older than 7.75 fails on `--aws-sigv4`: it never sends a request,
# so there is no status and no document to read a verdict out of.
CURL_OPTION_UNKNOWN = Response(
    "observed: curl 8.4.0 rejecting an option it does not have",
    2,
    stderr="curl: option --not-a-real-option: is unknown\n",
)


class Runner:
    """Answers each probe by (role, operation, bucket), recording every call.

    Two clients reach this: `aws s3api ...` and the signed `curl` used for
    object reads. Both are keyed the same way, so a test says what a probe
    asked of the bucket without saying how it was sent.
    """

    def __init__(self, answers: dict, default=None):
        self.answers = answers
        self.default = default or Completed(0)
        self.calls: list[tuple] = []

    def __call__(self, argv, env):
        if argv[0] == "curl":
            operation = "get-object"
            path = urllib.parse.urlsplit(argv[-1]).path.lstrip("/")
            bucket = path.split("/", 1)[0]
        else:
            operation = argv[argv.index("s3api") + 1]
            bucket = argv[argv.index("--bucket") + 1] if "--bucket" in argv else None
        role = {
            OPERATOR_KEY: "operator",
            WORKLOAD_KEY: "workload",
            FOREIGN_KEY: "foreign",
        }.get(env.get("AWS_ACCESS_KEY_ID"), "anonymous")
        self.calls.append((role, operation, bucket))
        return self.answers.get((role, operation, bucket), self.default)


def a_fully_working_fence() -> dict:
    """Every probe answering the way a correct, live fence answers."""
    denied = Completed(1, stderr=ACCESS_DENIED)
    return {
        ("workload", "get-bucket-policy", FENCED): denied,
        ("workload", "put-bucket-policy", FENCED): denied,
        ("workload", "put-bucket-versioning", FENCED): denied,
        ("foreign", "list-objects-v2", FENCED): denied,
        ("foreign", "put-object", FENCED): denied,
        ("anonymous", "list-objects-v2", FENCED): denied,
        # The object reads, over the signed transport.
        ("workload", "get-object", FENCED): CURL_OK,
        ("foreign", "get-object", FENCED): CURL_ACCESS_DENIED,
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
        answers[("workload", "get-object", FENCED)] = CURL_ACCESS_DENIED
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
            and check.probe.operation == "get-object"
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
        # substitution that made a project boundary look like a fence.
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


class TestNotPrincipalProbe(unittest.TestCase):
    """The reversible test of the assumption every other check rests on.

    Every other guard in this repository validates a document against a model
    of S3 evaluation. If Hetzner's engine reads `NotPrincipal` as matching
    everybody rather than exempting the named key, all of them pass and the
    fence still locks the bucket permanently. These tests are about that one
    question, and about the probe being unable to cause the harm it detects.
    """

    def _answers(self, operator_read, foreign_read):
        return {
            ("operator", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
            ("operator", "get-bucket-policy", FENCED): Completed(
                1, stderr=NO_SUCH_BUCKET_POLICY
            ),
            ("operator", "put-object", FENCED): Completed(0),
            ("operator", "put-bucket-policy", FENCED): Completed(0),
            ("operator", "delete-bucket-policy", FENCED): Completed(0),
            ("operator", "get-object", FENCED): operator_read,
            ("foreign", "get-object", FENCED): foreign_read,
            ("operator", "list-object-versions", FENCED): Completed(0, stdout="{}"),
        }

    def _run(self, operator_read, foreign_read, extra=()):
        return run(
            self._answers(operator_read, foreign_read),
            extra_args=["--probe-notprincipal", *extra],
        )

    def test_an_engine_that_exempts_the_named_key_passes(self):
        code, output, _ = self._run(CURL_OK, CURL_ACCESS_DENIED)
        self.assertEqual(code, 0, output)

    def test_an_engine_that_denies_the_named_key_fails_loudly(self):
        # The finding that would otherwise arrive as a locked bucket.
        code, output, _ = self._run(CURL_ACCESS_DENIED, CURL_ACCESS_DENIED)
        self.assertEqual(code, 1)
        self.assertIn("WOULD HAVE LOCKED THE BUCKET", output)
        self.assertIn("DO NOT APPLY", output)

    def test_an_engine_that_ignores_the_statement_fails(self):
        # Stored and not enforced: a fence that fences nothing, while every
        # other signal says it worked.
        code, output, _ = self._run(CURL_OK, CURL_OK)
        self.assertEqual(code, 1)
        self.assertIn("NotPrincipal DENIES everyone else", output)

    def test_the_probe_reads_the_object_over_the_signed_transport(self):
        # The two reads that decide this probe are the ones `aws s3api
        # get-object` could not answer. If either went back through the CLI
        # both rows would report INCONCLUSIVE and the runbook would stop here.
        _, _, runner = self._run(CURL_OK, CURL_ACCESS_DENIED)
        argvs = [call for call in runner.calls if call[1] == "get-object"]
        self.assertEqual(argvs, [("operator", "get-object", FENCED), ("foreign", "get-object", FENCED)])

    def test_a_read_the_transport_cannot_interpret_is_inconclusive_not_a_denial(self):
        # A refusal carrying no error document. The operator row must not read
        # as "denied", which is the verdict that stops the whole programme with
        # `WOULD HAVE LOCKED THE BUCKET`, and the foreign row must not read as
        # "denied" either, which would be a pass bought with an unreadable
        # response.
        code, output, _ = self._run(CURL_403_NO_DOCUMENT, CURL_403_NO_DOCUMENT)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)
        self.assertNotIn("WOULD HAVE LOCKED THE BUCKET", output)

    def test_the_probe_policy_can_never_deny_its_own_removal(self):
        # The property that makes asking the question safe. Asserted against
        # the worst case the probe is testing for: NotPrincipal matching
        # everybody. Even then, nothing on the bucket resource is denied, so
        # PutBucketPolicy and DeleteBucketPolicy survive for every key.
        policy = verify.probe_policy(FENCED, OPERATOR_ARN)
        verify.assert_probe_policy_is_reversible(policy, FENCED)
        for statement in policy["Statement"]:
            resource = statement["Resource"]
            resources = [resource] if isinstance(resource, str) else resource
            for entry in resources:
                self.assertNotEqual(entry, f"arn:aws:s3:::{FENCED}")
                self.assertTrue(entry.startswith(f"arn:aws:s3:::{FENCED}/{verify.PROBE_PREFIX}"))

    def test_a_probe_policy_touching_the_bucket_resource_is_refused(self):
        locking = {
            "Statement": [
                {
                    "Sid": "WouldLock",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                    "Action": "s3:*",
                    "Resource": f"arn:aws:s3:::{FENCED}",
                }
            ]
        }
        with self.assertRaises(verify.VerifierError):
            verify.assert_probe_policy_is_reversible(locking, FENCED)

    def test_a_probe_policy_reaching_outside_the_probe_prefix_is_refused(self):
        broad = {
            "Statement": [
                {
                    "Sid": "TooBroad",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                    "Action": "s3:GetObject",
                    "Resource": f"arn:aws:s3:::{FENCED}/*",
                }
            ]
        }
        with self.assertRaises(verify.VerifierError):
            verify.assert_probe_policy_is_reversible(broad, FENCED)

    def test_the_probe_policy_is_removed_even_when_the_reads_fail(self):
        _, _, runner = self._run(CURL_CONNECTION_REFUSED, CURL_CONNECTION_REFUSED)
        self.assertIn(("operator", "delete-bucket-policy", FENCED), runner.calls)

    def test_a_probe_policy_left_behind_is_shouted_about_with_the_fix(self):
        answers = self._answers(CURL_OK, CURL_ACCESS_DENIED)
        answers[("operator", "delete-bucket-policy", FENCED)] = Completed(
            1, stderr=ACCESS_DENIED
        )
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("THE PROBE POLICY IS REMOVED", output)
        self.assertIn("delete-bucket-policy", output)

    def test_it_refuses_a_bucket_that_already_carries_a_policy(self):
        # Replacing a live fence with the probe would un-fence the bucket for
        # the duration of the probe.
        answers = self._answers(CURL_OK, CURL_ACCESS_DENIED)
        answers[("operator", "get-bucket-policy", FENCED)] = Completed(
            0, stdout=json.dumps(POLICY)
        )
        code, output, runner = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("already has a policy", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), runner.calls)

    def test_an_engine_that_rejects_the_document_is_inconclusive_not_a_pass(self):
        answers = self._answers(CURL_OK, CURL_ACCESS_DENIED)
        answers[("operator", "put-bucket-policy", FENCED)] = Completed(
            1, stderr="\nAn error occurred (MalformedPolicy) when calling the "
            "PutBucketPolicy operation: Invalid policy\n"
        )
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("the probe policy is accepted", output)


class TestApplyMode(unittest.TestCase):
    """Pre-flight and the double PUT in one process, so neither can be skipped."""

    def _answers(self):
        return {
            ("operator", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
            ("workload", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
            ("foreign", "list-buckets", None): Completed(0, stdout=f"{ACCOUNT}\n"),
            ("operator", "put-bucket-policy", FENCED): Completed(0),
            ("operator", "get-bucket-policy", FENCED): Completed(0, stdout=json.dumps(POLICY)),
        }

    def test_a_clean_apply_puts_the_policy_twice(self):
        code, output, runner = run(self._answers(), extra_args=["--apply"])
        self.assertEqual(code, 0, output)
        puts = [c for c in runner.calls if c == ("operator", "put-bucket-policy", FENCED)]
        self.assertEqual(len(puts), 2)

    def test_a_failed_preflight_makes_the_put_unreachable(self):
        # The whole reason this is one process rather than two commands.
        answers = self._answers()
        for role in ("operator", "workload", "foreign"):
            answers[(role, "list-buckets", None)] = Completed(0, stdout="p99999999\n")
        code, output, runner = run(answers, extra_args=["--apply"])
        self.assertEqual(code, 1)
        self.assertIn("DO NOT APPLY THIS POLICY", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), runner.calls)

    def test_a_second_put_that_is_denied_reports_a_lockout(self):
        calls = {"n": 0}
        answers = self._answers()

        class Sequenced(Runner):
            def __call__(self, argv, env):
                result = super().__call__(argv, env)
                if argv[argv.index("s3api") + 1] == "put-bucket-policy":
                    calls["n"] += 1
                    if calls["n"] == 2:
                        return Completed(1, stderr=ACCESS_DENIED)
                return result

        runner = Sequenced(answers)
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
                    "--apply",
                ],
                runner=runner,
                environ=dict(ENVIRONMENT),
            )
        self.assertEqual(code, 1)
        self.assertIn("THE BUCKET MAY BE LOCKED", out.getvalue())


class TestObjectReadsDoNotUseTheAwsCli(unittest.TestCase):
    """The defect: `aws s3api get-object` cannot reach a verdict on this endpoint."""

    def test_the_client_crash_carries_no_error_code_to_classify(self):
        # Against this endpoint the command exits 255 with a client-internal
        # message and empty stdout, for EVERY failure -- including a plain
        # missing object on a bucket the credential can read, so a denial is
        # not required to produce it. `classify` finds nothing, which is
        # correct and fail-safe, and is also why the probe could never pass.
        outcome, reason = verify.classify(
            AWS_GET_OBJECT_CRASH.returncode, AWS_GET_OBJECT_CRASH.stderr
        )
        self.assertEqual(outcome, "error")
        self.assertIn("no S3 error code", reason)

    def test_the_crash_is_the_error_document_shape_not_the_command(self):
        # The scope of the defect, recorded because getting it wrong is what
        # made this look like a one-command problem. The SAME crash comes back
        # from `list-objects-v2` -- the command four denial probes use -- when
        # the answer is `AccessDenied`, while the gateway's `NoSuchBucket`
        # renders fine from the same command. The difference is the empty
        # `<Message></Message>` in the engine's own error documents.
        self.assertEqual(
            verify.classify(
                AWS_ACCESS_DENIED_CRASH.returncode, AWS_ACCESS_DENIED_CRASH.stderr
            )[0],
            "error",
        )
        outcome, reason = verify.classify(
            AWS_NO_SUCH_BUCKET_RENDERS.returncode, AWS_NO_SUCH_BUCKET_RENDERS.stderr
        )
        self.assertEqual(outcome, "error")
        self.assertIn("NoSuchBucket", reason)

    def test_the_cli_denial_probes_cannot_yet_reach_a_verdict_on_this_endpoint(self):
        # The state of the world, asserted rather than described, so that the
        # change which moves these probes onto the signed transport has to come
        # back here and say so. Every denial probe still on the CLI answers
        # INCONCLUSIVE against a correctly fenced bucket -- fail-safe, and not
        # a pass, but not proof either.
        answers = a_fully_working_fence()
        for probe in (
            ("foreign", "list-objects-v2", FENCED),
            ("foreign", "put-object", FENCED),
            ("workload", "get-bucket-policy", FENCED),
            ("workload", "put-bucket-policy", FENCED),
            ("anonymous", "list-objects-v2", FENCED),
        ):
            answers[probe] = AWS_ACCESS_DENIED_CRASH
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)
        self.assertNotIn(verify.FAIL, output)
        # The object read is the one denial that still reaches a verdict.
        self.assertIn(f"{verify.PASS}          foreign key cannot read an object", output)

    def test_head_object_is_not_the_substitute(self):
        # It renders its error cleanly and calls a refusal `403`, which is an
        # HTTP status rather than an S3 error code. Swapping to it would turn
        # every denial into INCONCLUSIVE by a second route.
        outcome, reason = verify.classify(
            AWS_HEAD_OBJECT_FORBIDDEN.returncode, AWS_HEAD_OBJECT_FORBIDDEN.stderr
        )
        self.assertEqual(outcome, "error")
        self.assertIn("403", reason)
        self.assertNotIn("403", verify.DENIAL_CODES)

    def test_no_check_reads_an_object_through_the_cli(self):
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key=f"{verify.PROBE_PREFIX}x.txt",
            versioning_already_enabled=True,
        )
        reads = [check for check in checks if check.probe.operation == "get-object"]
        self.assertEqual(len(reads), 2)
        for check in reads:
            with self.subTest(check=check.name):
                self.assertEqual(check.probe.kind, "object-read")
                self.assertEqual(check.probe.args, [])

    def test_a_whole_run_sends_no_get_object_to_the_cli(self):
        # Asserted on what actually went out, not on the check set: the object
        # reads happened, and no `aws s3api` invocation was one of them.
        sent: list[list[str]] = []

        def recording(argv, env):
            sent.append(argv)
            return Runner(a_fully_working_fence())(argv, env)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            verify.main(
                ["--bucket", FENCED, "--foreign-control-bucket", CONTROL,
                 "--policy-file", POLICY_FILE],
                runner=recording,
                environ=dict(ENVIRONMENT),
            )
        s3api = [argv for argv in sent if "s3api" in argv]
        self.assertTrue(s3api)
        for argv in s3api:
            self.assertNotIn("get-object", argv)
        self.assertEqual(len([argv for argv in sent if argv[0] == "curl"]), 2)


class TestObjectReadClassification(unittest.TestCase):
    """The signed transport's verdicts, and the one route to `denied`."""

    def _classify(self, response):
        return verify.classify_object_read(
            response.returncode, response.stdout, response.stderr
        )

    def test_a_2xx_is_allowed(self):
        self.assertEqual(self._classify(CURL_OK)[0], "allowed")

    def test_an_access_denied_document_is_a_denial(self):
        outcome, reason = self._classify(CURL_ACCESS_DENIED)
        self.assertEqual(outcome, "denied")
        self.assertEqual(reason, "AccessDenied")

    def test_a_dead_key_is_an_error_despite_arriving_as_the_same_403(self):
        # The pair that makes an HTTP status useless on its own, and the reason
        # this transport never reads one. Both fixtures were observed against
        # the live endpoint and both are 403.
        self.assertEqual(
            verify._split_status(CURL_ACCESS_DENIED.stdout)[1],
            verify._split_status(CURL_INVALID_ACCESS_KEY.stdout)[1],
        )
        outcome, reason = self._classify(CURL_INVALID_ACCESS_KEY)
        self.assertEqual(outcome, "error")
        self.assertIn("says nothing about the fence", reason)

    def test_a_missing_object_is_an_error_and_never_a_denial(self):
        # A read that finds nothing proves nothing about the fence.
        self.assertEqual(self._classify(CURL_NO_SUCH_KEY)[0], "error")

    def test_a_pretty_printed_document_is_read_the_same_as_a_flat_one(self):
        # This endpoint emits both. A verdict that depended on the whitespace
        # would hold until the day the other renderer answered.
        outcome, reason = self._classify(CURL_NO_SUCH_BUCKET)
        self.assertEqual(outcome, "error")
        self.assertIn("NoSuchBucket", reason)

    def test_a_refusal_with_no_error_document_is_an_error(self):
        outcome, reason = self._classify(CURL_403_NO_DOCUMENT)
        self.assertEqual(outcome, "error")
        self.assertIn("no S3 error document", reason)

    def test_a_body_that_is_not_an_error_document_yields_no_verdict(self):
        outcome, _ = self._classify(CURL_BAD_GATEWAY_HTML)
        self.assertEqual(outcome, "error")

    def test_a_code_element_that_is_not_a_code_yields_no_verdict(self):
        # `report()` prints a reason as a line of its own, so text of arbitrary
        # length or containing newlines would forge report lines. An S3 error
        # code is a short identifier and anything else in that element is not
        # one -- held to the same shape the CLI side already enforces.
        for text in (
            "Nope\nPASS          foreign key cannot read an object",
            "A" * 65,
            "Access Denied",
            "Access-Denied",
            "<b>AccessDenied</b>",
        ):
            with self.subTest(text=text[:30]):
                body = f"<Error><Code>{text}</Code></Error>"
                outcome, reason = verify.classify_object_read(0, f"{body}\n403", "")
                self.assertEqual(outcome, "error")
                self.assertNotIn("\n", reason)

    def test_an_expensive_document_cannot_produce_an_expensive_reason(self):
        # ElementTree expands internal entities, so a small body can become a
        # very large string. The body is capped before parsing and the code is
        # capped after it.
        entity = "<!DOCTYPE r [<!ENTITY a \"" + "A" * 5000 + "\">]>"
        body = entity + "<Error><Code>" + "&a;" * 2000 + "</Code></Error>"
        outcome, reason = verify.classify_object_read(0, f"{body}\n403", "")
        self.assertEqual(outcome, "error")
        self.assertLess(len(reason), 500)

    def test_a_request_that_never_reached_the_endpoint_is_an_error(self):
        outcome, reason = self._classify(CURL_CONNECTION_REFUSED)
        self.assertEqual(outcome, "error")
        self.assertIn("did not complete", reason)

    def test_a_curl_too_old_for_aws_sigv4_is_an_error(self):
        # `--aws-sigv4` arrived in curl 7.75. An older one exits before
        # sending anything, so there is no status and no document.
        outcome, _ = self._classify(CURL_OPTION_UNKNOWN)
        self.assertEqual(outcome, "error")

    def test_an_object_whose_own_contents_look_like_a_denial_is_still_allowed(self):
        # The body is not consulted on success, and a 2xx is a successful read
        # whatever it returned.
        response = Response(
            "constructed: an object whose bytes happen to be an S3 error document",
            0,
            stdout="<Error><Code>AccessDenied</Code></Error>\n200",
        )
        self.assertEqual(self._classify(response)[0], "allowed")

    def test_denied_is_reachable_only_through_the_two_denial_codes(self):
        # The property the file exists for, asserted exhaustively rather than
        # by example: across every status and every code this endpoint might
        # return, `denied` comes out for `AccessDenied` and `AllAccessDisabled`
        # and for nothing else.
        codes = sorted(
            verify.DENIAL_CODES
            | set(verify.NOT_A_DENIAL)
            | {"NoSuchKey", "NoSuchBucketPolicy", "InternalError", "SlowDown", "403", ""}
        )
        for status in (200, 204, 206, 301, 400, 403, 404, 405, 500, 502, 503):
            for code in codes:
                body = f"<Error><Code>{code}</Code></Error>" if code else "<Error></Error>"
                outcome, _ = verify.classify_object_read(0, f"{body}\n{status}", "")
                with self.subTest(status=status, code=code):
                    if 200 <= status < 300:
                        self.assertEqual(outcome, "allowed")
                    elif code in verify.DENIAL_CODES:
                        self.assertEqual(outcome, "denied")
                    else:
                        self.assertEqual(outcome, "error")


class TestObjectReadTransport(unittest.TestCase):
    def _verifier(self, runner):
        return verify.Verifier(
            endpoint="https://hel1.your-objectstorage.com",
            region="hel1",
            credentials={"workload": (WORKLOAD_KEY, "workload-secret")},
            runner=runner,
            environ=dict(ENVIRONMENT),
        )

    def _argv_for(self, key=f"{verify.PROBE_PREFIX}x.txt"):
        captured: dict = {}

        def runner(argv, env):
            captured["argv"] = argv
            captured["env"] = env
            captured["config"] = pathlib.Path(argv[argv.index("--config") + 1]).read_text()
            return CURL_OK

        self._verifier(runner).read_object("workload", FENCED, key)
        return captured

    def test_the_request_is_a_path_style_signed_get(self):
        captured = self._argv_for()
        self.assertEqual(captured["argv"][0], "curl")
        self.assertIn("--aws-sigv4", captured["argv"])
        self.assertEqual(
            captured["argv"][captured["argv"].index("--aws-sigv4") + 1], "aws:amz:hel1:s3"
        )
        # Path-style: a dotted bucket name falls outside this endpoint's
        # one-label wildcard certificate, so the bucket never becomes a
        # hostname.
        self.assertEqual(
            captured["argv"][-1],
            f"https://hel1.your-objectstorage.com/{FENCED}/{verify.PROBE_PREFIX}x.txt",
        )

    def test_the_probe_obeys_no_configuration_but_its_own(self):
        # curl reads ~/.curlrc unless `-q` comes FIRST, and takes proxy
        # settings from the environment whether or not it does. A `proxy` line
        # there would put a response from something that is not the storage
        # backend in front of a denial check -- a generic 403 answering the
        # foreign read reads as PASS -- and an `insecure` line would drop
        # certificate checking on a probe carrying a live credential. Same
        # reasoning as clearing the ambient AWS_* variables, which this file
        # already does.
        captured = self._argv_for()
        self.assertEqual(captured["argv"][1], "-q")
        self.assertEqual(
            captured["argv"][captured["argv"].index("--noproxy") + 1], "*"
        )

    def test_the_status_is_asked_for_explicitly(self):
        # curl exits 0 for a 403 exactly as it does for a 200, so without this
        # every refusal would arrive looking like a successful read.
        captured = self._argv_for()
        self.assertEqual(captured["argv"][captured["argv"].index("--write-out") + 1], "\n%{http_code}")

    def test_the_secret_never_appears_in_the_argument_vector(self):
        # argv is readable out of the process table by every other process on
        # the workstation.
        captured = self._argv_for()
        self.assertNotIn("workload-secret", " ".join(captured["argv"]))
        self.assertIn('user = "', captured["config"])
        self.assertIn("workload-secret", captured["config"])

    def test_the_credential_file_is_removed_even_when_the_read_raises(self):
        paths: list[str] = []

        def runner(argv, env):
            paths.append(argv[argv.index("--config") + 1])
            raise RuntimeError("the client blew up")

        with self.assertRaises(RuntimeError):
            self._verifier(runner).read_object("workload", FENCED, "fence-probe/x.txt")
        self.assertFalse(pathlib.Path(paths[0]).exists())

    def test_a_credential_carrying_a_newline_cannot_inject_a_curl_option(self):
        # An unescaped newline would end the `user` line and turn whatever
        # followed into further options for curl to obey.
        captured: dict = {}

        def runner(argv, env):
            captured["config"] = pathlib.Path(argv[argv.index("--config") + 1]).read_text()
            return CURL_OK

        verifier = verify.Verifier(
            endpoint="https://hel1.your-objectstorage.com",
            region="hel1",
            credentials={"workload": (WORKLOAD_KEY, 'sec\nproxy = "http://attacker"')},
            runner=runner,
            environ=dict(ENVIRONMENT),
        )
        verifier.read_object("workload", FENCED, "fence-probe/x.txt")
        # One physical line, opening and closing on the quote that makes the
        # whole thing one option value. curl reads `\n` and `\"` as characters
        # of that value, so the injected text never becomes an option -- which
        # is what a real curl does with this file, not only what it should.
        self.assertEqual(captured["config"].count("\n"), 1)
        self.assertTrue(captured["config"].startswith('user = "'))
        self.assertTrue(captured["config"].endswith('"\n'))
        self.assertIn("\\n", captured["config"])

    def test_an_unsigned_object_read_is_refused_rather_than_sent(self):
        # There is no anonymous object-read probe, and one that silently went
        # out signed as whichever role ran last would be a false pass.
        sent: list = []
        verifier = self._verifier(lambda argv, env: sent.append(argv))
        outcome, reason = verifier.read_object("anonymous", FENCED, "fence-probe/x.txt")
        self.assertEqual(outcome, "error")
        self.assertEqual(sent, [])

    def test_the_read_runs_with_no_ambient_credential(self):
        # Same clearing as every s3api probe gets, from the same code: an
        # object read is the probe most likely to be run straight after a
        # `put-bucket-policy` that left a key exported.
        with mock.patch.dict(os.environ, {"AWS_PROFILE": "default"}, clear=False):
            captured = self._argv_for()
        self.assertNotIn("AWS_PROFILE", captured["env"])


class TestFixtureProvenance(unittest.TestCase):
    def test_every_fixture_says_whether_it_was_observed_or_written(self):
        # The failure this file is fixing was a fixture nobody had checked
        # against the wire. An unlabelled one is how that happens again.
        fixtures = [value for value in globals().values() if isinstance(value, Response)]
        self.assertGreaterEqual(len(fixtures), 8)
        for fixture in fixtures:
            with self.subTest(source=fixture.source[:40]):
                self.assertTrue(fixture.source.startswith(("observed:", "constructed:")))

    def test_no_fixture_carries_a_live_request_identifier(self):
        # RequestId and HostId name one request on Hetzner's side. Harmless,
        # and pointless to commit.
        for fixture in [value for value in globals().values() if isinstance(value, Response)]:
            with self.subTest(source=fixture.source[:40]):
                self.assertNotIn("-hel1-prod1-", fixture.stdout)


class TestRunnerFailuresNeverStrand(unittest.TestCase):
    def test_a_missing_client_is_an_error_not_a_denial(self):
        outcome, reason = verify.classify(1, "aws is not on PATH")
        self.assertEqual(outcome, "error")
        self.assertIn("not on PATH", reason)

    def test_a_timeout_is_an_error_not_a_denial(self):
        outcome, _ = verify.classify(1, "curl did not return within 120s")
        self.assertEqual(outcome, "error")

    def test_a_non_utf8_response_body_does_not_raise_out_of_the_runner(self):
        # An object read returns the object's own bytes on stdout, where the
        # CLI only ever returned JSON. An exception escaping the runner skips
        # `cleanup()` and leaves probe objects in a production bucket, which is
        # the one thing this function must never do.
        completed = verify._default_runner(
            ["/bin/sh", "-c", "printf '\\377\\376 not utf-8'"], dict(os.environ)
        )
        self.assertEqual(completed.returncode, 0)
        self.assertIsInstance(completed.stdout, str)

    def test_the_runner_names_the_client_it_could_not_start(self):
        # One runner now starts two different binaries, and "the aws CLI is not
        # on PATH" printed for a missing curl sends the reader to the wrong fix.
        completed = verify._default_runner(["curl-that-is-not-installed"], {})
        self.assertEqual(verify.classify(completed.returncode, completed.stderr)[0], "error")
        self.assertIn("curl-that-is-not-installed", completed.stderr)


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
            with self.subTest(operation=probe.operation):
                # put-object into a foreign bucket creates an object, which
                # cleanup removes; that is the one deliberate exception.
                if probe.operation == "put-object":
                    continue
                self.assertIn(probe.operation, self.SAFE_ON_SUCCESS)

    def test_a_probe_that_changes_bucket_state_only_runs_when_that_state_is_asserted(self):
        # Turning versioning on for a bucket that has it off, and no lifecycle
        # rule, retains every superseded object forever. That is storage growth
        # caused by the verification rather than found by it.
        default = {probe.operation for probe in self._denial_probes()}
        gated = {probe.operation for probe in self._denial_probes(versioning_already_enabled=True)}
        self.assertEqual(gated - default, self.GATED_ON_ASSERTED_STATE)
        self.assertFalse(default & self.GATED_ON_ASSERTED_STATE)

    def test_no_probe_replaces_the_bucket_acl(self):
        # `put-bucket-acl` replaces rather than merges, so it is a no-op only
        # if the current ACL is exactly what is sent -- which nothing here can
        # assert. The bucket-configuration deny is one statement, so
        # get/put-bucket-policy already prove it applies.
        for probe in self._denial_probes(versioning_already_enabled=True):
            self.assertNotEqual(probe.operation, "put-bucket-acl")

    def test_the_workload_write_probes_stay_under_the_probe_prefix(self):
        # prune_backups.py reads `dumps/` and `binlogs/`; a probe object under
        # either would enter the retention decision. Asserted on the object the
        # probe names rather than on its arguments, so a probe that changes
        # transport cannot drop out of the check by losing a `--key` flag.
        checks = verify.build_checks(
            bucket=FENCED,
            foreign_control_bucket=CONTROL,
            policy_file=POLICY_FILE,
            probe_key=f"{verify.PROBE_PREFIX}x.txt",
        )
        keyed = [check for check in checks if check.probe.object_key is not None]
        self.assertGreaterEqual(len(keyed), 4)
        for check in keyed:
            with self.subTest(check=check.name):
                self.assertTrue(check.probe.object_key.startswith(verify.PROBE_PREFIX))


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
