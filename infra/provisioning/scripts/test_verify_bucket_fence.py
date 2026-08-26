"""Tests for the fence verifier, built around the mistake that produced it.

The historical failure was recording one `AccessDenied` as proof that a
credential was scoped to one bucket, when the denial was in fact a project
boundary and the credential was scoped to nothing. Every test here that matters
is a variation on that: a denial arriving for the wrong reason must never come
out of this file as a pass.

There is a second mistake recorded here, and it belongs to this file. Every
object-read test once fed the classifier a hand-written
`An error occurred (AccessDenied)` stderr, which is the shape the `aws` CLI
renders for most commands -- but not for anything against this endpoint, whose
storage engine returns error documents the CLI cannot render at all. The suite
passed while the probes it covered could not reach a verdict. So responses here
are not "the real shapes" on assertion: each fixture states whether it was
observed on the wire or written, and `TestFixtureProvenance` refuses an
unlabelled one.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
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

ROLE_OF_KEY = {OPERATOR_KEY: "operator", WORKLOAD_KEY: "workload", FOREIGN_KEY: "foreign"}

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
POLICY_DOCUMENT = json.dumps(POLICY).encode()

_TEMP = tempfile.TemporaryDirectory()
POLICY_FILE = str(pathlib.Path(_TEMP.name) / "policy.json")
pathlib.Path(POLICY_FILE).write_bytes(POLICY_DOCUMENT)

ENVIRONMENT = {
    "FENCE_OPERATOR_ACCESS_KEY_ID": OPERATOR_KEY,
    "FENCE_OPERATOR_SECRET_ACCESS_KEY": "operator-secret",
    "FENCE_WORKLOAD_ACCESS_KEY_ID": WORKLOAD_KEY,
    "FENCE_WORKLOAD_SECRET_ACCESS_KEY": "workload-secret",
    "FENCE_FOREIGN_ACCESS_KEY_ID": FOREIGN_KEY,
    "FENCE_FOREIGN_SECRET_ACCESS_KEY": "foreign-secret",
}

ENDPOINT_HOST = "hel1.your-objectstorage.com"
ENDPOINT = f"https://{ENDPOINT_HOST}"

# Every `observed:` fixture below was captured against the live endpoint with
# NO CREDENTIAL -- unsigned, or signed with a deliberately invalid key id -- so
# none of them required, or could have exposed, a real key. `RequestId` and
# `HostId` are replaced with the `N/A` this endpoint itself returns on the
# gateway paths: they name one request on Hetzner's side and carry nothing a
# fixture needs.
UNSIGNED = "observed: unsigned request to " + ENDPOINT_HOST
INVALID_KEY_REQUEST = "observed: request to " + ENDPOINT_HOST + " signed with an invalid key id"


class Response:
    """One HTTP response, with where it came from attached.

    `source` opens with `observed:` or `constructed:` and nothing else. A
    fixture observed on the wire constrains the code; one written here
    constrains only what its author expected, which is how the object-read
    probes once shipped unable to reach a verdict.

    Every instance registers itself. `TestFixtureProvenance` used to walk
    module globals, which silently skipped every fixture built inside a test
    method -- so the guard that is supposed to refuse an unlabelled fixture
    would not have refused the next one written inline.
    """

    every: list["Response"] = []

    def __init__(self, source: str, status: int, body: bytes = b""):
        self.source = source
        self.status = status
        self.body = body
        Response.every.append(self)


# THE DOCUMENT THIS WHOLE PROGRAMME TURNS ON. Empty `<Message></Message>`, which
# is what `aws s3api` v2 exits 255 rather than render -- for every operation,
# which is why moving one command onto a signed transport was not the fix.
# Captured from an unsigned `GET /branchleft-db-backups?list-type=2`.
ACCESS_DENIED = Response(
    UNSIGNED + " (list-objects-v2 on a bucket that exists)",
    403,
    b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message></Message>'
    b"<BucketName>branchleft-db-backups</BucketName><RequestId>N/A</RequestId>"
    b"<HostId>N/A</HostId></Error>",
)

# The same refusal for an object read, captured separately rather than assumed
# to be the same document.
ACCESS_DENIED_OBJECT = Response(
    UNSIGNED + " (get-object)",
    403,
    b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message></Message>'
    b"<BucketName>branchleft-db-backups</BucketName><RequestId>N/A</RequestId>"
    b"<HostId>N/A</HostId></Error>",
)

# And for the two bucket sub-resources the denial probes use. Captured because
# a sub-resource request signs its query string, and a refusal that arrived in
# some other shape from `?policy` than from a plain GET would be a hole.
ACCESS_DENIED_POLICY = Response(
    UNSIGNED + " (get-bucket-policy, ?policy=)",
    403,
    b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message></Message>'
    b"<BucketName>branchleft-db-backups</BucketName><RequestId>N/A</RequestId>"
    b"<HostId>N/A</HostId></Error>",
)

ACCESS_DENIED_VERSIONS = Response(
    UNSIGNED + " (list-object-versions, ?versions=)",
    403,
    b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message></Message>'
    b"<BucketName>branchleft-db-backups</BucketName><RequestId>N/A</RequestId>"
    b"<HostId>N/A</HostId></Error>",
)

# A write refusal. The document is the one captured above, byte for byte apart
# from the identifiers -- this endpoint returned it unchanged for five
# different read operations -- but it is labelled constructed because no write
# refusal was captured: sending an unsigned PUT at a live production bucket to
# find out is not a thing this work is permitted to do, and guessing that it
# would be denied is the assumption a probe is supposed to test rather than
# make.
ACCESS_DENIED_WRITE = Response(
    "constructed: the AccessDenied document captured from five read operations against "
    f"{ENDPOINT_HOST}, reused for a write. No unsigned write was sent at a live bucket",
    403,
    ACCESS_DENIED.body,
)

# The pair that makes an HTTP status useless on its own: the same 403, from a
# credential that does not exist.
INVALID_ACCESS_KEY = Response(
    INVALID_KEY_REQUEST + " (get-object)",
    403,
    b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code>'
    b"<Message></Message><RequestId>N/A</RequestId><HostId>N/A</HostId></Error>",
)

# What renders through any client, and why the defect looked at first like one
# broken command: the gateway's own error, with a real message, pretty-printed
# and with a different element set from the engine's.
NO_SUCH_BUCKET = Response(
    UNSIGNED + " (list-objects-v2 on a bucket that does not exist)",
    404,
    b'<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n    <Code>NoSuchBucket</Code>\n'
    b"    <Message>The specified bucket does not exist.</Message>\n"
    b"    <RequestId>N/A</RequestId>\n    <HostId>N/A</HostId>\n</Error>",
)

# THE TRAP UNDER `account_of`. This endpoint answers an UNSIGNED ListAllMyBuckets
# with HTTP 200 and an owner id of `anonymous` rather than refusing, so a
# request that lost its signature resolves an "account" that a policy principal
# could then be built from -- naming a principal that cannot exist, which is
# the unrecoverable mistake pre-flight exists to catch.
ANONYMOUS_OWNER = Response(
    UNSIGNED + " (ListAllMyBuckets)",
    200,
    b'<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult '
    b'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>anonymous</ID>'
    b"<DisplayName></DisplayName></Owner><Buckets></Buckets></ListAllMyBucketsResult>",
)

OWNER = Response(
    "constructed: the ListAllMyBuckets shape captured above, with a real account id in "
    "place of `anonymous`. Only a credentialed request returns one",
    200,
    b'<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult '
    b'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>' + ACCOUNT.encode() + b"</ID>"
    b"<DisplayName>" + ACCOUNT.encode() + b"</DisplayName></Owner><Buckets>"
    b"<Bucket><Name>branchleft-db-backups</Name>"
    b"<CreationDate>2026-08-01T00:00:00.000Z</CreationDate></Bucket>"
    b"</Buckets></ListAllMyBucketsResult>",
)

OTHER_OWNER = Response(
    "constructed: the same shape under a different account id",
    200,
    ANONYMOUS_OWNER.body.replace(b"anonymous", b"p99999999"),
)

EMPTY_LISTING = Response(
    "constructed: a successful listing needs a credential that reaches the bucket",
    200,
    b'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult '
    b'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>branchleft-db-backups</Name>'
    b"<IsTruncated>false</IsTruncated></ListBucketResult>",
)

EMPTY_VERSIONS = Response(
    "constructed: an empty ?versions listing, which needs a credential",
    200,
    b'<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult '
    b'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>branchleft-db-backups</Name>'
    b"<IsTruncated>false</IsTruncated></ListVersionsResult>",
)

OK_EMPTY = Response(
    "constructed: a 2xx with no body, as a PUT or DELETE returns",
    200,
)

NO_CONTENT = Response("constructed: the 204 a DELETE returns", 204)

OBJECT_BYTES = Response(
    "constructed: a successful object read. Only the status is load-bearing -- a 2xx is "
    "`allowed` and the body is never read on success",
    200,
    b"probe\n",
)

FORBIDDEN_NO_DOCUMENT = Response(
    "constructed: a refusal carrying no error document. The fail-safe case, which nothing "
    "observed can be relied on to keep producing",
    403,
)

BAD_GATEWAY_HTML = Response(
    "constructed: an HTML error page from something sitting in front of the endpoint",
    502,
    b"<html><head><title>502 Bad Gateway</title></head></html>",
)

NO_SUCH_KEY = Response(
    "constructed: a missing object. A read that finds nothing proves nothing about a fence",
    404,
    b"<Error><Code>NoSuchKey</Code><BucketName>" + FENCED.encode() + b"</BucketName></Error>",
)

NO_SUCH_BUCKET_POLICY = Response(
    "constructed: what a bucket with no policy returns to get-bucket-policy",
    404,
    b"<Error><Code>NoSuchBucketPolicy</Code></Error>",
)

# Case 4 in RUNBOOK-bucket-fencing.md's list of ways this engine can differ
# from its documentation: it rejects the NotPrincipal document outright. An
# anticipated outcome, and the one that used to end with the probe deleting a
# policy it had never displaced.
REJECTED_POLICY = Response(
    "constructed: an engine refusing a NotPrincipal document. Whether this endpoint accepts "
    "one is the open question the probe exists to settle, so a refusal cannot be captured "
    "without applying a policy to a live bucket",
    400,
    b"<Error><Code>MalformedPolicy</Code></Error>",
)


class Unreachable(Exception):
    """Stands in for a transport that never got a response."""


def _operation(method: str, bucket: str | None, key: str | None, query: dict) -> str:
    if not bucket:
        return "list-buckets"
    if "policy" in query:
        return {"GET": "get-bucket-policy", "PUT": "put-bucket-policy", "DELETE": "delete-bucket-policy"}[method]
    if "versioning" in query:
        return {"GET": "get-bucket-versioning", "PUT": "put-bucket-versioning"}[method]
    if "versions" in query:
        return "list-object-versions"
    if key is None:
        return "list-objects-v2"
    return {"GET": "get-object", "PUT": "put-object", "DELETE": "delete-object"}[method]


def _role(headers: dict) -> str:
    authorization = headers.get("Authorization")
    if not authorization:
        return "anonymous"
    match = re.search(r"Credential=([^/]+)/", authorization)
    return ROLE_OF_KEY.get(match.group(1), "unrecognised-key") if match else "unsigned-authorization"


class Sent:
    def __init__(self, role, operation, bucket, key, url, headers, payload, method):
        self.role = role
        self.operation = operation
        self.bucket = bucket
        self.key = key
        self.url = url
        self.headers = headers
        self.payload = payload
        self.method = method


class Transport:
    """Answers each request by `(role, operation, bucket)`, recording every one.

    The role is read out of the `Authorization` header rather than taken from
    the caller, so a test says which credential a request was SIGNED with, not
    which one the code meant to use. A probe that lost its signature comes back
    as `anonymous` here, and a mis-keyed one as `unrecognised-key`; neither has
    an answer configured, so neither can quietly pass.
    """

    def __init__(self, answers: dict, default: Response | None = None):
        self.answers = answers
        self.default = default or OK_EMPTY
        self.calls: list[tuple] = []
        self.sent: list[Sent] = []

    def __call__(self, url, headers, payload, method):
        parts = urllib.parse.urlsplit(url)
        path = parts.path.lstrip("/")
        bucket = path.split("/", 1)[0] or None
        key = path.split("/", 1)[1] if "/" in path else None
        query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
        operation = _operation(method, bucket, key, query)
        role = _role(headers)
        self.calls.append((role, operation, bucket))
        self.sent.append(Sent(role, operation, bucket, key, url, headers, payload, method))
        response = self.answers.get((role, operation, bucket), self.default)
        if isinstance(response, Exception):
            raise response
        return response.status, response.body


def a_fully_working_fence() -> dict:
    """Every probe answering the way a correct, live fence answers."""
    return {
        ("operator", "list-buckets", None): OWNER,
        ("workload", "list-buckets", None): OWNER,
        ("foreign", "list-buckets", None): OWNER,
        ("operator", "get-bucket-policy", FENCED): Response(
            "constructed: GetBucketPolicy returns the stored document itself",
            200,
            POLICY_DOCUMENT,
        ),
        ("operator", "put-bucket-policy", FENCED): OK_EMPTY,
        ("operator", "list-object-versions", FENCED): EMPTY_VERSIONS,
        ("workload", "list-objects-v2", FENCED): EMPTY_LISTING,
        ("workload", "put-object", FENCED): OK_EMPTY,
        ("workload", "get-object", FENCED): OBJECT_BYTES,
        ("workload", "delete-object", FENCED): NO_CONTENT,
        ("workload", "get-bucket-policy", FENCED): ACCESS_DENIED_POLICY,
        ("workload", "put-bucket-policy", FENCED): ACCESS_DENIED_WRITE,
        ("workload", "put-bucket-versioning", FENCED): ACCESS_DENIED_WRITE,
        ("foreign", "list-objects-v2", CONTROL): EMPTY_LISTING,
        ("foreign", "list-objects-v2", FENCED): ACCESS_DENIED,
        ("foreign", "get-object", FENCED): ACCESS_DENIED_OBJECT,
        ("foreign", "put-object", FENCED): ACCESS_DENIED_WRITE,
        ("anonymous", "list-objects-v2", FENCED): ACCESS_DENIED,
    }


def run(answers, environment=None, extra_args=(), transport=None):
    transport = transport or Transport(answers)
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
            transport=transport,
            environ=dict(environment or ENVIRONMENT),
        )
    return code, out.getvalue(), transport


def checks(**kwargs):
    return verify.build_checks(
        bucket=FENCED,
        foreign_control_bucket=CONTROL,
        policy_document=POLICY_DOCUMENT,
        probe_key=f"{verify.PROBE_PREFIX}x.txt",
        **kwargs,
    )


class TestClassification(unittest.TestCase):
    def test_a_2xx_is_allowed(self):
        self.assertEqual(verify.classify(200, b"")[0], "allowed")

    def test_the_real_access_denied_document_is_a_denial(self):
        outcome, reason = verify.classify(ACCESS_DENIED.status, ACCESS_DENIED.body)
        self.assertEqual(outcome, "denied")
        self.assertEqual(reason, "AccessDenied")

    def test_a_dead_credential_is_an_error_despite_arriving_as_the_same_403(self):
        # This is the whole point: a key that reaches nothing fails with the
        # same status a fenced key does.
        self.assertEqual(ACCESS_DENIED.status, INVALID_ACCESS_KEY.status)
        outcome, reason = verify.classify(INVALID_ACCESS_KEY.status, INVALID_ACCESS_KEY.body)
        self.assertEqual(outcome, "error")
        self.assertIn("says nothing about the fence", reason)

    def test_an_unrecognised_service_error_is_an_error(self):
        outcome, reason = verify.classify(NO_SUCH_BUCKET.status, NO_SUCH_BUCKET.body)
        self.assertEqual(outcome, "error")
        self.assertIn("NoSuchBucket", reason)

    def test_a_missing_object_is_an_error_and_never_a_denial(self):
        self.assertEqual(verify.classify(NO_SUCH_KEY.status, NO_SUCH_KEY.body)[0], "error")

    def test_a_refusal_with_no_error_document_is_an_error(self):
        outcome, reason = verify.classify(
            FORBIDDEN_NO_DOCUMENT.status, FORBIDDEN_NO_DOCUMENT.body
        )
        self.assertEqual(outcome, "error")
        self.assertIn("no S3 error document", reason)

    def test_a_body_that_is_not_an_error_document_yields_no_verdict(self):
        self.assertEqual(verify.classify(BAD_GATEWAY_HTML.status, BAD_GATEWAY_HTML.body)[0], "error")

    def test_a_pretty_printed_document_is_read_the_same_as_a_flat_one(self):
        # This endpoint emits both. A verdict that depended on the whitespace
        # would hold until the day the other renderer answered.
        self.assertIn(b"\n    <Code>", NO_SUCH_BUCKET.body)
        self.assertIn(b"<Error><Code>", ACCESS_DENIED.body)
        self.assertEqual(verify.s3_error_code(NO_SUCH_BUCKET.body), "NoSuchBucket")
        self.assertEqual(verify.s3_error_code(ACCESS_DENIED.body), "AccessDenied")

    def test_a_request_that_never_reached_the_endpoint_is_an_error(self):
        outcome, reason = verify.classify(None, b"", "connection refused")
        self.assertEqual(outcome, "error")
        self.assertIn("did not complete", reason)

    def test_an_object_whose_own_contents_look_like_a_denial_is_still_allowed(self):
        # The body is not consulted on success, and a 2xx is a successful read
        # whatever it returned.
        self.assertEqual(
            verify.classify(200, b"<Error><Code>AccessDenied</Code></Error>")[0], "allowed"
        )

    def test_a_code_element_that_is_not_a_code_yields_no_verdict(self):
        # `report()` prints a reason as a line of its own, so text of arbitrary
        # length or containing newlines would forge report lines.
        for text in (
            "Nope\nPASS          foreign key cannot read an object",
            "A" * 65,
            "Access Denied",
            "Access-Denied",
            "<b>AccessDenied</b>",
        ):
            with self.subTest(text=text[:30]):
                body = f"<Error><Code>{text}</Code></Error>".encode()
                outcome, reason = verify.classify(403, body)
                self.assertEqual(outcome, "error")
                self.assertNotIn("\n", reason)

    def test_a_code_element_outside_an_error_document_yields_no_verdict(self):
        # A `<Code>AccessDenied</Code>` can appear inside any XML this endpoint
        # -- or anything in front of it -- returns. Only a document whose root
        # is `Error` is an S3 error, and without that guard a 403 carrying some
        # other envelope becomes a `denied` verdict, which is a fence proven by
        # a response that was not a refusal.
        for body in (
            b"<ListBucketResult><Code>AccessDenied</Code></ListBucketResult>",
            b"<Response><Error><Code>AccessDenied</Code></Error></Response>",
            b'<html><body><Code>AccessDenied</Code></body></html>',
        ):
            with self.subTest(body=body[:30]):
                self.assertIsNone(verify.s3_error_code(body))
                self.assertEqual(verify.classify(403, body)[0], "error")
        # The same code inside a real error document still is one, so the guard
        # is not simply refusing everything.
        self.assertEqual(verify.classify(403, b"<Error><Code>AccessDenied</Code></Error>")[0], "denied")

    def test_an_expensive_document_cannot_produce_an_expensive_reason(self):
        # ElementTree expands internal entities, so a small body can become a
        # very large string. The body is capped before parsing and the code is
        # capped after it.
        entity = '<!DOCTYPE r [<!ENTITY a "' + "A" * 5000 + '">]>'
        body = (entity + "<Error><Code>" + "&a;" * 2000 + "</Code></Error>").encode()
        outcome, reason = verify.classify(403, body)
        self.assertEqual(outcome, "error")
        self.assertLess(len(reason), 500)

    def test_a_non_utf8_body_does_not_raise(self):
        # An object read returns the object's own bytes. An exception escaping
        # the classifier skips `cleanup()` and leaves probe objects in a
        # production bucket.
        outcome, _ = verify.classify(403, b"\xff\xfe not utf-8")
        self.assertEqual(outcome, "error")

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
                body = (
                    f"<Error><Code>{code}</Code></Error>" if code else "<Error></Error>"
                ).encode()
                outcome, _ = verify.classify(status, body)
                with self.subTest(status=status, code=code):
                    if 200 <= status < 300:
                        self.assertEqual(outcome, "allowed")
                    elif code in verify.DENIAL_CODES:
                        self.assertEqual(outcome, "denied")
                    else:
                        self.assertEqual(outcome, "error")


class TestEveryDenialProbeReachesAVerdict(unittest.TestCase):
    """Replaces `test_the_cli_denial_probes_cannot_yet_reach_a_verdict_on_this_endpoint`.

    That test asserted the limitation this work removes: every denial probe
    running through `aws s3api` came back INCONCLUSIVE against a correctly
    fenced bucket, because the CLI exits 255 rather than render this backend's
    error documents. It was written so that the change moving those probes onto
    a signed transport would have to come back here and say so. This is that
    statement, in the same place, asserting the opposite.
    """

    def test_every_denial_probe_reaches_a_verdict_on_this_endpoints_error_documents(self):
        # Every denial is answered with the document this endpoint actually
        # returns -- empty `<Message></Message>`, the shape no CLI could read.
        answers = a_fully_working_fence()
        code, output, transport = run(answers, extra_args=["--versioning-already-enabled"])
        self.assertEqual(code, 0, output)
        self.assertNotIn(verify.INCONCLUSIVE, output)
        self.assertNotIn(verify.FAIL, output)

        denials = [check for check in checks(versioning_already_enabled=True) if check.expect == "deny"]
        self.assertGreaterEqual(len(denials), 6)
        for check in denials:
            with self.subTest(check=check.name):
                self.assertIn(f"{verify.PASS}          {check.name}", output)

    def test_the_document_every_denial_probe_is_answered_with_is_the_captured_one(self):
        # The assertion above is only worth anything if the fixtures behind it
        # are the endpoint's own error documents rather than a shape that
        # happens to classify. Each carries an empty Message, which is the
        # element the CLI could not render.
        for response in (
            ACCESS_DENIED,
            ACCESS_DENIED_OBJECT,
            ACCESS_DENIED_POLICY,
            ACCESS_DENIED_VERSIONS,
            ACCESS_DENIED_WRITE,
        ):
            with self.subTest(source=response.source[:40]):
                self.assertIn(b"<Message></Message>", response.body)
                self.assertEqual(verify.classify(response.status, response.body)[0], "denied")


class TestNoExternalClient(unittest.TestCase):
    def test_a_whole_verification_runs_without_starting_a_process(self):
        # `aws` cannot render this backend's denials and `curl --aws-sigv4`
        # needed a credential file and a version check. Neither is reachable
        # from here any more, and this is asserted on behaviour rather than on
        # the import list: a subprocess started anywhere under `main` fails the
        # test.
        with mock.patch.object(
            subprocess, "run", side_effect=AssertionError("a subprocess was started")
        ), mock.patch.object(
            subprocess, "Popen", side_effect=AssertionError("a subprocess was started")
        ):
            code, output, _ = run(a_fully_working_fence())
        self.assertEqual(code, 0, output)

    def test_the_module_does_not_import_subprocess(self):
        self.assertNotIn("subprocess", vars(verify))
        self.assertNotIn("tempfile", vars(verify))

    def test_the_signing_is_the_one_the_backup_pipeline_uses(self):
        # Not a second copy. `db/provision/objectstorage.py` signs db1's dumps
        # and binlog shipments against this same endpoint; a divergent copy
        # here would keep passing its own tests while drifting from the
        # implementation that is actually proven in production.
        source = verify.storage.SOURCE
        self.assertEqual(source.name, "objectstorage.py")
        self.assertEqual(source.parent.name, "provision")
        self.assertTrue(source.is_file())


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
        answers[("foreign", "list-objects-v2", FENCED)] = EMPTY_LISTING
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("FAIL", output)
        self.assertIn("foreign key cannot list the bucket", output)

    def test_a_fence_that_denies_the_workload_fails_rather_than_passing(self):
        # A policy that denies everybody is an outage, not a boundary, and on
        # the backup bucket it is silent until the next restore.
        answers = a_fully_working_fence()
        answers[("workload", "put-object", FENCED)] = ACCESS_DENIED_WRITE
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("the key that must keep working is denied", output)

    def test_a_workload_that_can_write_but_not_read_fails(self):
        # The object Allow and the object Deny are separate statements. A write
        # that succeeds says nothing about the read, and a backup nobody can
        # read back is not a backup.
        answers = a_fully_working_fence()
        answers[("workload", "get-object", FENCED)] = ACCESS_DENIED_OBJECT
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("workload can read an object back", output)
        self.assertIn(verify.FAIL, output)

    def test_the_workload_read_probe_is_always_in_the_check_set(self):
        reads = [
            check
            for check in checks()
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
        answers[("operator", "get-bucket-policy", FENCED)] = Response(
            "constructed: a stored policy missing one statement", 200, json.dumps(trimmed).encode()
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
        answers[("operator", "get-bucket-policy", FENCED)] = Response(
            "constructed: the same policy with its statements reordered",
            200,
            json.dumps(reordered).encode(),
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 0, output)

    def test_a_policy_that_cannot_be_read_back_is_inconclusive(self):
        answers = a_fully_working_fence()
        answers[("operator", "get-bucket-policy", FENCED)] = NO_SUCH_BUCKET_POLICY
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("could not read the stored policy", output)

    def test_a_stored_policy_under_a_different_version_is_a_mismatch(self):
        # `Version` selects the grammar the whole document is evaluated under.
        # An engine that stored the statements and rewrote that would be
        # enforcing something other than what was sent, and every probe would
        # still pass because they measure the fence that is there.
        answers = a_fully_working_fence()
        rewritten = {"Version": "2008-10-17", "Statement": POLICY["Statement"]}
        answers[("operator", "get-bucket-policy", FENCED)] = Response(
            "constructed: the same statements stored under a different policy Version",
            200,
            json.dumps(rewritten).encode(),
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("the stored policy is not the document that was sent", output)


class TestPreflight(unittest.TestCase):
    def test_a_policy_rendered_against_the_wrong_account_is_caught_before_the_put(self):
        # One mistyped digit in --project-id. The generator's own check passes,
        # because it compares a fabricated ARN against itself. Live, the
        # NotPrincipal names a principal that does not exist, so the operator's
        # exemption exempts nobody and the bucket becomes unrecoverable.
        answers = a_fully_working_fence()
        for role in ("operator", "workload", "foreign"):
            answers[(role, "list-buckets", None)] = OTHER_OWNER
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn("DO NOT APPLY THIS POLICY", output)
        self.assertIn("the policy exempts THIS operator credential", output)

    def test_a_correctly_rendered_policy_passes_preflight(self):
        code, output, _ = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertEqual(code, 0, output)
        self.assertIn("safe to apply", output)

    def test_preflight_writes_nothing(self):
        _, _, transport = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertEqual([sent for sent in transport.sent if sent.method != "GET"], [])

    def test_preflight_exercises_the_transport_every_probe_uses(self):
        # The gap this closes: the object reads used to go through an external
        # `curl` that pre-flight never invoked, so a workstation missing it, or
        # carrying one too old for `--aws-sigv4`, found out in the middle of
        # --probe-notprincipal -- after a probe policy had been applied to and
        # removed from a production bucket. Pre-flight now signs and sends a
        # real request on each of the three credentials.
        _, output, transport = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertIn("the signed transport reaches the endpoint", output)
        signed = {sent.role for sent in transport.sent}
        self.assertEqual(signed, {"operator", "workload", "foreign"})
        for sent in transport.sent:
            self.assertIn("Authorization", sent.headers)

    def test_an_endpoint_that_answers_nothing_says_so_once_rather_than_three_times(self):
        def unreachable(url, headers, payload, method):
            raise verify.storage.ObjectStorageError(f"{method} {url} failed to complete: refused")

        code, output, _ = run({}, extra_args=["--preflight"], transport=unreachable)
        self.assertEqual(code, 1)
        self.assertIn("no request reached the endpoint at all", output)
        self.assertIn("Nothing has been written", output)

    def test_a_foreign_key_in_another_account_fails_preflight(self):
        # Its denials would be the account boundary, which is precisely the
        # substitution that made a project boundary look like a fence.
        answers = a_fully_working_fence()
        answers[("foreign", "list-buckets", None)] = OTHER_OWNER
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn("all three credentials are in one account", output)

    def test_a_credential_that_cannot_resolve_its_account_is_inconclusive(self):
        answers = a_fully_working_fence()
        answers[("operator", "list-buckets", None)] = INVALID_ACCESS_KEY
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)

    def test_a_second_deny_that_locks_a_credential_out_is_not_masked_by_the_first(self):
        # A policy is a set of statements that all apply, so one statement
        # naming a credential says nothing about what the next one withholds
        # from it. A check that stopped at the first exemption would report the
        # credential as safe while a second statement locked it out -- and
        # `--apply` gates on these rows, so it would then write the policy.
        #
        # The route in is `RUNBOOK-bucket-fencing.md`'s own re-fencing case:
        # re-rendering with several `--workload-access-key` values when
        # per-tenant state credentials land. One typo in that list and every
        # deploy on the mistyped key stops at an unwritable checkpoint.
        for role, arn, extra in (
            (
                "operator",
                OPERATOR_ARN,
                {
                    "Sid": "SecondBucketDeny",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [WORKLOAD_ARN]},
                    "Action": "s3:DeleteBucket",
                    "Resource": f"arn:aws:s3:::{FENCED}",
                },
            ),
            (
                "workload",
                WORKLOAD_ARN,
                {
                    "Sid": "SecondObjectDeny",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                    "Action": "s3:PutObject",
                    "Resource": f"arn:aws:s3:::{FENCED}/*",
                },
            ),
        ):
            with self.subTest(role=role):
                masked = {"Version": POLICY["Version"], "Statement": POLICY["Statement"] + [extra]}
                rows = verify.preflight(
                    verify.Verifier(
                        endpoint=ENDPOINT,
                        region="hel1",
                        credentials={
                            "operator": (OPERATOR_KEY, "s"),
                            "workload": (WORKLOAD_KEY, "s"),
                            "foreign": (FOREIGN_KEY, "s"),
                        },
                        transport=Transport(a_fully_working_fence()),
                    ),
                    bucket=FENCED,
                    policy_document=json.dumps(masked).encode(),
                )
                exemption = [
                    row for row in rows if row[0] == f"the policy exempts THIS {role} credential"
                ][0]
                self.assertEqual(exemption[1], verify.FAIL, exemption)
                self.assertIn(arn, exemption[2])

    def test_the_correctly_rendered_policy_still_passes_both_exemption_checks(self):
        # The other direction of the test above: a policy whose Denys all
        # exempt the credential must not be reported as locking it out.
        rows = verify.preflight(
            verify.Verifier(
                endpoint=ENDPOINT,
                region="hel1",
                credentials={
                    "operator": (OPERATOR_KEY, "s"),
                    "workload": (WORKLOAD_KEY, "s"),
                    "foreign": (FOREIGN_KEY, "s"),
                },
                transport=Transport(a_fully_working_fence()),
            ),
            bucket=FENCED,
            policy_document=POLICY_DOCUMENT,
        )
        for role in ("operator", "workload"):
            with self.subTest(role=role):
                exemption = [
                    row for row in rows if row[0] == f"the policy exempts THIS {role} credential"
                ][0]
                self.assertEqual(exemption[1], verify.PASS, exemption)

    def test_a_policy_with_no_deny_of_that_shape_is_not_an_exemption(self):
        # `None` rather than `True`: a policy that never denies at the object
        # level has not exempted the workload, it has said nothing about it.
        allow_only = {
            "Version": "2012-10-17",
            "Statement": [
                {"Sid": "A", "Effect": "Allow", "Principal": "*", "Action": "s3:*",
                 "Resource": f"arn:aws:s3:::{FENCED}/*"}
            ],
        }
        rows = verify.preflight(
            verify.Verifier(
                endpoint=ENDPOINT,
                region="hel1",
                credentials={
                    "operator": (OPERATOR_KEY, "s"),
                    "workload": (WORKLOAD_KEY, "s"),
                    "foreign": (FOREIGN_KEY, "s"),
                },
                transport=Transport(a_fully_working_fence()),
            ),
            bucket=FENCED,
            policy_document=json.dumps(allow_only).encode(),
        )
        for role in ("operator", "workload"):
            with self.subTest(role=role):
                exemption = [
                    row for row in rows if row[0] == f"the policy exempts THIS {role} credential"
                ][0]
                self.assertEqual(exemption[1], verify.FAIL, exemption)

    def test_an_owner_of_anonymous_is_refused_rather_than_named_in_a_principal(self):
        # This endpoint answers an unsigned ListAllMyBuckets with 200 and
        # `anonymous`. Accepting it would build a policy principal naming an
        # account that cannot exist -- the exact unrecoverable mistake this
        # pre-flight exists to catch, arriving through the check meant to catch
        # it.
        answers = a_fully_working_fence()
        answers[("operator", "list-buckets", None)] = ANONYMOUS_OWNER
        code, output, _ = run(answers, extra_args=["--preflight"])
        self.assertEqual(code, 1)
        self.assertIn("saw this request as unsigned", output)
        self.assertNotIn("anonymous:", output)


class TestShowAccount(unittest.TestCase):
    """The value `--project-id` is rendered from, read from the credential."""

    def test_it_prints_each_credentials_account_and_writes_nothing(self):
        transport = Transport(a_fully_working_fence())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verify.main(
                ["--bucket", FENCED, "--foreign-control-bucket", CONTROL, "--show-account"],
                transport=transport,
                environ=dict(ENVIRONMENT),
            )
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn(ACCOUNT, out.getvalue())
        self.assertEqual([sent for sent in transport.sent if sent.method != "GET"], [])

    def test_only_this_mode_may_omit_the_bucket_and_the_policy(self):
        # Every other mode reaches a verdict about a fence, and a verdict about
        # a fence is a statement about which credentials it separates.
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            verify.main([], transport=Transport({}), environ=dict(ENVIRONMENT))
        for flag in ("--bucket", "--foreign-control-bucket", "--policy-file"):
            self.assertIn(flag, err.getvalue())

    def test_one_credential_is_enough_for_this_mode_and_for_no_other(self):
        # The project id has to be confirmed before a policy is rendered, which
        # is before the runbook has exported the other two credentials.
        environment = {
            "FENCE_OPERATOR_ACCESS_KEY_ID": OPERATOR_KEY,
            "FENCE_OPERATOR_SECRET_ACCESS_KEY": "operator-secret",
        }
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verify.main(
                ["--show-account"],
                transport=Transport(a_fully_working_fence()),
                environ=environment,
            )
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("operator credential resolves its account", out.getvalue())
        self.assertIn(ACCOUNT, out.getvalue())
        self.assertNotIn("workload", out.getvalue())

        with self.assertRaises(verify.VerifierError):
            verify.read_credentials(environment)

    def test_a_clean_run_does_not_claim_a_policy_is_safe_to_apply(self):
        # It read no policy. `report`'s pre-flight wording here would be a
        # verdict about a document nobody passed it.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            verify.main(
                ["--show-account"],
                transport=Transport(a_fully_working_fence()),
                environ=dict(ENVIRONMENT),
            )
        self.assertNotIn("safe to apply", out.getvalue())
        self.assertIn("--project-id", out.getvalue())

    def test_it_does_not_shout_about_a_policy_nobody_is_applying(self):
        # `report` raises the lockout banner for a critical row. Nothing in
        # this mode is a decision about a policy, so no row here is critical.
        answers = a_fully_working_fence()
        answers[("operator", "list-buckets", None)] = INVALID_ACCESS_KEY
        transport = Transport(answers)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verify.main(
                ["--bucket", FENCED, "--foreign-control-bucket", CONTROL, "--show-account"],
                transport=transport,
                environ=dict(ENVIRONMENT),
            )
        self.assertEqual(code, 1)
        self.assertNotIn("DO NOT APPLY", out.getvalue())


class TestControlsMakeDenialsMeanSomething(unittest.TestCase):
    def test_a_denial_from_a_credential_that_reaches_nothing_is_inconclusive(self):
        # The exact historical mistake: an AccessDenied recorded as proof, from
        # a key whose entitlement was never established.
        answers = a_fully_working_fence()
        answers[("foreign", "list-objects-v2", CONTROL)] = ACCESS_DENIED
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)
        self.assertIn("is not evidence about the fence", output)

    def test_a_denial_from_a_mistyped_key_is_inconclusive(self):
        answers = a_fully_working_fence()
        answers[("foreign", "list-objects-v2", CONTROL)] = INVALID_ACCESS_KEY
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn(verify.INCONCLUSIVE, output)

    def test_an_inconclusive_run_never_exits_zero(self):
        answers = a_fully_working_fence()
        answers[("workload", "get-bucket-policy", FENCED)] = NO_SUCH_BUCKET_POLICY
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("An inconclusive check is not a pass", output)

    def test_the_anonymous_check_declares_that_it_has_no_control(self):
        anonymous = [check for check in checks() if check.probe.role == "anonymous"]
        self.assertEqual(len(anonymous), 1)
        self.assertIsNone(anonymous[0].control)
        self.assertIn("no control exists", anonymous[0].note)

    def test_every_other_denial_check_carries_a_control_on_its_own_credential(self):
        for check in checks(versioning_already_enabled=True):
            if check.expect != "deny" or check.probe.role == "anonymous":
                continue
            with self.subTest(check=check.name):
                self.assertIsNotNone(check.control)
                self.assertEqual(check.control.role, check.probe.role)

    def test_every_control_travels_the_same_transport_as_the_probe_it_licenses(self):
        # The gap this closes: `foreign key cannot read an object` was a signed
        # `curl` read while its control was still `aws s3api`, so the control
        # established that the CLI worked for that credential and said nothing
        # about the transport the probe used. A control on a different
        # transport licenses nothing.
        for check in checks(versioning_already_enabled=True):
            if check.control is None:
                continue
            with self.subTest(check=check.name):
                self.assertIs(type(check.control), type(check.probe))

    def test_a_control_and_the_probe_it_licenses_are_signed_the_same_way(self):
        # Asserted on what went out, not on the check set: both requests carry
        # an Authorization header naming the same access key.
        _, _, transport = run(a_fully_working_fence())
        by_role = {}
        for sent in transport.sent:
            if sent.role == "anonymous":
                continue
            by_role.setdefault(sent.role, set()).add(sent.headers["Authorization"].split("/")[0])
        for role, credentials in by_role.items():
            with self.subTest(role=role):
                self.assertEqual(len(credentials), 1)


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
            ("operator", "list-buckets", None): OWNER,
            ("operator", "get-bucket-policy", FENCED): NO_SUCH_BUCKET_POLICY,
            ("operator", "put-object", FENCED): OK_EMPTY,
            ("operator", "put-bucket-policy", FENCED): OK_EMPTY,
            ("operator", "delete-bucket-policy", FENCED): NO_CONTENT,
            ("operator", "get-object", FENCED): operator_read,
            ("foreign", "get-object", FENCED): foreign_read,
            ("operator", "list-object-versions", FENCED): EMPTY_VERSIONS,
        }

    def _run(self, operator_read, foreign_read, extra=()):
        return run(
            self._answers(operator_read, foreign_read),
            extra_args=["--probe-notprincipal", *extra],
        )

    def test_an_engine_that_exempts_the_named_key_passes(self):
        code, output, _ = self._run(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        self.assertEqual(code, 0, output)

    def test_an_engine_that_denies_the_named_key_fails_loudly(self):
        # The finding that would otherwise arrive as a locked bucket.
        code, output, _ = self._run(ACCESS_DENIED_OBJECT, ACCESS_DENIED_OBJECT)
        self.assertEqual(code, 1)
        self.assertIn("WOULD HAVE LOCKED THE BUCKET", output)
        self.assertIn("DO NOT APPLY", output)

    def test_an_engine_that_ignores_the_statement_fails(self):
        # Stored and not enforced: a fence that fences nothing, while every
        # other signal says it worked.
        code, output, _ = self._run(OBJECT_BYTES, OBJECT_BYTES)
        self.assertEqual(code, 1)
        self.assertIn("NotPrincipal DENIES everyone else", output)

    def test_the_two_reads_that_decide_it_are_signed_as_different_roles(self):
        _, _, transport = self._run(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        reads = [call for call in transport.calls if call[1] == "get-object"]
        self.assertEqual(
            reads, [("operator", "get-object", FENCED), ("foreign", "get-object", FENCED)]
        )

    def test_a_read_the_transport_cannot_interpret_is_inconclusive_not_a_denial(self):
        # A refusal carrying no error document. The operator row must not read
        # as "denied", which is the verdict that stops the whole programme with
        # `WOULD HAVE LOCKED THE BUCKET`, and the foreign row must not read as
        # "denied" either, which would be a pass bought with an unreadable
        # response.
        code, output, _ = self._run(FORBIDDEN_NO_DOCUMENT, FORBIDDEN_NO_DOCUMENT)
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
        _, _, transport = self._run(FORBIDDEN_NO_DOCUMENT, FORBIDDEN_NO_DOCUMENT)
        self.assertIn(("operator", "delete-bucket-policy", FENCED), transport.calls)

    def test_a_probe_policy_left_behind_is_shouted_about_with_the_fix(self):
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "delete-bucket-policy", FENCED)] = ACCESS_DENIED_WRITE
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("THE PROBE POLICY IS REMOVED", output)
        self.assertIn("delete-bucket-policy", output)

    def _leftover_probe(self):
        return Response(
            "constructed: the probe policy this file writes, left behind by an interrupted run",
            200,
            json.dumps(verify.probe_policy(FENCED, OPERATOR_ARN)).encode(),
        )

    def _real_fence(self):
        return Response(
            "constructed: a bucket already carrying its real fence", 200, POLICY_DOCUMENT
        )

    def test_it_refuses_a_bucket_that_already_carries_a_policy(self):
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "get-bucket-policy", FENCED)] = self._real_fence()
        code, output, transport = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("already carries a policy", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), transport.calls)

    def test_replace_existing_policy_does_not_authorise_displacing_a_real_fence(self):
        # NOTHING HERE RESTORES A DISPLACED DOCUMENT. The probe is applied and
        # then deleted, so a fence it replaced is gone for good and the bucket
        # is unfenced from that moment on. The flag therefore covers exactly
        # one case -- a probe policy this file wrote itself -- and a real
        # document is refused with the flag exactly as it is without it.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "get-bucket-policy", FENCED)] = self._real_fence()
        code, output, transport = run(
            answers, extra_args=["--probe-notprincipal", "--replace-existing-policy"]
        )
        self.assertEqual(code, 1)
        self.assertIn("did not write", output)
        self.assertIn("does not cover this", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), transport.calls)
        self.assertNotIn(("operator", "delete-bucket-policy", FENCED), transport.calls)

    def test_a_real_fence_and_a_leftover_probe_get_different_advice(self):
        # Both are "this bucket already has a policy", and the right next step
        # is opposite in each case. The document is already in hand, so the
        # message says which one this is rather than leaving both to be weighed.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "get-bucket-policy", FENCED)] = self._leftover_probe()
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("left its own probe policy", output)
        self.assertIn("--replace-existing-policy", output)
        self.assertNotIn("did not write", output)

    def test_replace_existing_policy_lets_the_probe_run_over_a_leftover_probe(self):
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "get-bucket-policy", FENCED)] = self._leftover_probe()
        code, output, transport = run(
            answers, extra_args=["--probe-notprincipal", "--replace-existing-policy"]
        )
        self.assertEqual(code, 0, output)
        self.assertIn(("operator", "delete-bucket-policy", FENCED), transport.calls)

    def test_an_engine_that_rejects_the_document_is_inconclusive_not_a_pass(self):
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "put-bucket-policy", FENCED)] = REJECTED_POLICY
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertIn("the probe policy is accepted", output)

    def test_a_refused_put_does_not_delete_the_policy_that_is_already_there(self):
        # `DeleteBucketPolicy` removes whatever is on the bucket, not the
        # document this block meant to put there. Deleting after a refused PUT
        # therefore removes a policy this run never displaced -- and the engine
        # rejecting a NotPrincipal document outright is case 4 in the runbook's
        # own list of ways this engine can differ from its documentation, not
        # an exotic outcome.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "get-bucket-policy", FENCED)] = self._leftover_probe()
        answers[("operator", "put-bucket-policy", FENCED)] = REJECTED_POLICY
        code, output, transport = run(
            answers, extra_args=["--probe-notprincipal", "--replace-existing-policy"]
        )
        self.assertEqual(code, 1)
        self.assertNotIn(("operator", "delete-bucket-policy", FENCED), transport.calls)

    def test_a_refused_put_yields_no_engine_verdict_from_the_reads(self):
        # The reads would answer about whatever policy IS on the bucket, or
        # about none. `PASS NotPrincipal EXEMPTS the named key` drawn from a
        # document the engine never saw is the runbook's gate passing on
        # evidence that does not exist.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        answers[("operator", "put-bucket-policy", FENCED)] = REJECTED_POLICY
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertNotIn(verify.PASS, output)
        self.assertIn("says nothing about how this engine evaluates NotPrincipal", " ".join(output.split()))

    def test_the_banner_does_not_claim_a_policy_is_waiting_to_be_re_rendered(self):
        # This mode writes no fence, so neither "the bucket may be locked" nor
        # "re-render it against the account id" is a true sentence about what
        # happened here.
        answers = self._answers(ACCESS_DENIED_OBJECT, ACCESS_DENIED_OBJECT)
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 1)
        self.assertNotIn("Re-render it", output)
        self.assertNotIn("THE BUCKET MAY BE LOCKED", output)
        self.assertIn("DO NOT APPLY THE REAL FENCE", output)


class TestApplyMode(unittest.TestCase):
    """Pre-flight and the double PUT in one process, so neither can be skipped."""

    def _answers(self):
        return {
            ("operator", "list-buckets", None): OWNER,
            ("workload", "list-buckets", None): OWNER,
            ("foreign", "list-buckets", None): OWNER,
            ("operator", "put-bucket-policy", FENCED): OK_EMPTY,
            ("operator", "get-bucket-policy", FENCED): Response(
                "constructed: GetBucketPolicy returns the stored document itself",
                200,
                POLICY_DOCUMENT,
            ),
        }

    def test_a_clean_apply_puts_the_policy_twice(self):
        code, output, transport = run(self._answers(), extra_args=["--apply"])
        self.assertEqual(code, 0, output)
        puts = [c for c in transport.calls if c == ("operator", "put-bucket-policy", FENCED)]
        self.assertEqual(len(puts), 2)

    def test_a_failed_preflight_makes_the_put_unreachable(self):
        # The whole reason this is one process rather than two commands.
        answers = self._answers()
        for role in ("operator", "workload", "foreign"):
            answers[(role, "list-buckets", None)] = OTHER_OWNER
        code, output, transport = run(answers, extra_args=["--apply"])
        self.assertEqual(code, 1)
        self.assertIn("DO NOT APPLY THIS POLICY", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), transport.calls)

    def test_a_second_put_that_is_denied_reports_a_lockout(self):
        seen = {"n": 0}

        class Sequenced(Transport):
            def __call__(self, url, headers, payload, method):
                if method == "PUT" and "policy" in url:
                    seen["n"] += 1
                    if seen["n"] == 2:
                        self.calls.append(("operator", "put-bucket-policy", FENCED))
                        return ACCESS_DENIED_WRITE.status, ACCESS_DENIED_WRITE.body
                return super().__call__(url, headers, payload, method)

        code, output, _ = run(self._answers(), extra_args=["--apply"], transport=Sequenced(self._answers()))
        self.assertEqual(code, 1)
        self.assertIn("THE BUCKET MAY BE LOCKED", output)


class TestSignedTransport(unittest.TestCase):
    def _verifier(self, transport):
        return verify.Verifier(
            endpoint=ENDPOINT,
            region="hel1",
            credentials={
                "workload": (WORKLOAD_KEY, "workload-secret"),
                "operator": (OPERATOR_KEY, "operator-secret"),
            },
            transport=transport,
        )

    def _send(self, probe):
        captured: dict = {}

        def transport(url, headers, payload, method):
            captured.update(url=url, headers=headers, payload=payload, method=method)
            return OBJECT_BYTES.status, OBJECT_BYTES.body

        self._verifier(transport).request(probe)
        return captured

    def test_an_object_read_is_a_path_style_signed_get(self):
        captured = self._send(verify._read(FENCED, "workload", f"{verify.PROBE_PREFIX}x.txt"))
        self.assertEqual(captured["method"], "GET")
        # Path-style: a dotted bucket name falls outside this endpoint's
        # one-label wildcard certificate, so the bucket never becomes a
        # hostname.
        self.assertEqual(
            captured["url"], f"{ENDPOINT}/{FENCED}/{verify.PROBE_PREFIX}x.txt"
        )
        self.assertTrue(captured["headers"]["Authorization"].startswith("AWS4-HMAC-SHA256 "))
        self.assertIn(f"Credential={WORKLOAD_KEY}/", captured["headers"]["Authorization"])
        self.assertEqual(captured["headers"]["host"], ENDPOINT_HOST)

    def test_the_secret_is_never_sent_anywhere_a_reader_could_take_it(self):
        # It never leaves this process except as an HMAC. There is also no
        # argument vector and no credential file for it to sit in any more:
        # the earlier transport wrote a 0600 `.curlrc` per read, and argv is
        # readable out of the process table by every other process on the
        # workstation.
        captured = self._send(verify._read(FENCED, "workload", "fence-probe/x.txt"))
        rendered = captured["url"] + json.dumps(captured["headers"]) + repr(captured["payload"])
        self.assertNotIn("workload-secret", rendered)

    def test_the_unsigned_probe_carries_no_authorization_at_all(self):
        # The check it backs proves the bucket is not world-readable. Signed by
        # accident, it would prove nothing and pass.
        probe = [check.probe for check in checks() if check.probe.role == "anonymous"][0]
        captured = self._send(probe)
        self.assertEqual(captured["headers"], {})
        self.assertIn("list-type=2", captured["url"])

    def test_a_credential_exported_in_the_environment_cannot_reach_a_probe(self):
        # An operator arrives at this script with a key already exported, from
        # the step immediately before it. Nothing here reads the environment
        # when it sends: the credential comes from the role table and from
        # nowhere else, so an ambient key cannot become the signer.
        ambient = {
            "AWS_ACCESS_KEY_ID": OPERATOR_KEY,
            "AWS_SECRET_ACCESS_KEY": "operator-secret",
            "AWS_PROFILE": "default",
        }
        with mock.patch.dict(os.environ, ambient, clear=False):
            captured = self._send(verify._read(FENCED, "workload", "fence-probe/x.txt"))
        self.assertIn(f"Credential={WORKLOAD_KEY}/", captured["headers"]["Authorization"])

    def test_a_transport_failure_is_an_error_and_never_a_denial(self):
        def refused(url, headers, payload, method):
            raise verify.storage.ObjectStorageError("GET ... failed to complete: refused")

        outcome, reason = self._verifier(refused).run(verify._read(FENCED, "workload", "k"))
        self.assertEqual(outcome, "error")
        self.assertIn("did not complete", reason)

    def test_an_unexpected_exception_is_an_error_rather_than_escaping(self):
        # An exception escaping the request skips `cleanup()`, which leaves
        # probe objects in a production bucket.
        def broken(url, headers, payload, method):
            raise ValueError("unknown url type")

        outcome, reason = self._verifier(broken).run(verify._read(FENCED, "workload", "k"))
        self.assertEqual(outcome, "error")
        self.assertIn("ValueError", reason)

    def test_a_plaintext_endpoint_is_refused_rather_than_signed_for(self):
        # Every request carries a live credential in an Authorization header.
        with self.assertRaises(verify.VerifierError):
            verify.Verifier(
                endpoint="http://hel1.your-objectstorage.com",
                region="hel1",
                credentials={},
            )

    def test_a_bucket_subresource_is_addressed_as_a_query_parameter(self):
        captured = self._send(verify._policy_probe("operator", FENCED, "GET"))
        self.assertEqual(captured["url"], f"{ENDPOINT}/{FENCED}?policy=")

    def test_two_probes_differing_only_in_body_do_not_share_a_cached_verdict(self):
        # `_policy_probe` builds PUTs that are identical except for the
        # document they carry, and the outcome cache is keyed on the probe. A
        # key that ignored the payload would answer the second PUT with the
        # first one's verdict -- so a policy the engine would have refused
        # reports the verdict of one it accepted, from a request never sent.
        one = verify._policy_probe("operator", FENCED, "PUT", b'{"Version":"2012-10-17"}')
        two = verify._policy_probe("operator", FENCED, "PUT", b'{"Version":"2008-10-17"}')
        self.assertNotEqual(one.cache_key(), two.cache_key())

        sent = []

        def transport(url, headers, payload, method):
            sent.append(payload)
            return 200, b""

        verifier = self._verifier(transport)
        verifier.run(one)
        verifier.run(two)
        verifier.run(one)  # the cache is real: this one does not go out again
        self.assertEqual(sent, [one.payload, two.payload])


class TestFixtureProvenance(unittest.TestCase):
    """Run last by name, so `Response.every` holds the inline fixtures too.

    Ordering is a convenience rather than the guarantee: the module-level
    fixtures are registered at import and are checked whatever runs first, and
    an inline fixture that this ordering missed would be caught on the next run
    that reached it. Walking `globals()` missed every inline fixture on every
    run, which is the difference.
    """

    # A Ceph RGW transaction id, which is what this endpoint puts in RequestId
    # and HostId. Matched by shape rather than by the `-hel1-prod1-` substring
    # the earlier check used, so a response captured from another region or
    # cluster is caught too.
    REQUEST_ID = re.compile(rb"tx[0-9a-f]{10,}|-prod\d+-")

    def _fixtures(self):
        module_level = [value for value in globals().values() if isinstance(value, Response)]
        self.assertGreaterEqual(len(module_level), 12)
        # Every fixture ever built in this run, module-level and inline alike.
        self.assertGreater(len(Response.every), len(module_level))
        return Response.every

    @staticmethod
    def _unlabelled(fixtures):
        return [f for f in fixtures if not f.source.startswith(("observed:", "constructed:"))]

    def test_every_fixture_says_whether_it_was_observed_or_written(self):
        # The failure this file is fixing was a fixture nobody had checked
        # against the wire. An unlabelled one is how that happens again.
        for fixture in self._unlabelled(self._fixtures()):
            self.fail(f"unlabelled fixture: {fixture.source[:60]!r}")

    def test_the_guard_would_actually_refuse_an_unlabelled_fixture(self):
        # A guard that has quietly stopped covering anything passes every
        # fixture, so prove it still refuses one before trusting a pass. The
        # fixture is built INSIDE a test on purpose: eleven of the fixtures in
        # this file are, and the earlier guard walked module globals, so every
        # one of them was invisible to it.
        mark = len(Response.every)
        Response("this fixture is deliberately unlabelled", 200)
        try:
            self.assertEqual(len(self._unlabelled(self._fixtures())), 1)
        finally:
            del Response.every[mark:]
        self.assertEqual(self._unlabelled(self._fixtures()), [])

    def test_no_fixture_carries_a_live_request_identifier(self):
        # RequestId and HostId name one request on Hetzner's side. Harmless,
        # and pointless to commit.
        for fixture in self._fixtures():
            with self.subTest(source=fixture.source[:40]):
                self.assertIsNone(self.REQUEST_ID.search(fixture.body))

    def test_the_request_identifier_matcher_still_matches_a_real_one(self):
        # A matcher that has quietly stopped matching passes every fixture.
        # This is the identifier shape captured off the live endpoint, with its
        # digits changed.
        for real in (
            b"<RequestId>tx0000043296e609d7694e1-006a8eb7bf-1a7ba04d-hel1-prod1-ceph4</RequestId>",
            b"<HostId>1a7ba04d-hel1-prod1-ceph4-hel1</HostId>",
        ):
            with self.subTest(real=real[:20]):
                self.assertIsNotNone(self.REQUEST_ID.search(real))
        self.assertIsNone(self.REQUEST_ID.search(b"<RequestId>N/A</RequestId>"))

    def test_no_fixture_carries_a_credential(self):
        for fixture in self._fixtures():
            with self.subTest(source=fixture.source[:40]):
                self.assertNotIn(b"secret", fixture.body.lower())
                self.assertNotIn(b"Signature=", fixture.body)


class TestSigningIsARequirement(unittest.TestCase):
    def test_every_mode_refuses_before_writing_when_the_signing_is_missing(self):
        # The dependency the transport has. It is checked before any mode runs,
        # rather than at the first request -- which is where an operator used
        # to discover a missing `curl`: part-way through --probe-notprincipal,
        # with a probe policy already applied to a production bucket.
        transport = Transport(a_fully_working_fence())
        for extra in ([], ["--preflight"], ["--apply"], ["--probe-notprincipal"], ["--show-account"]):
            with self.subTest(mode=extra or ["(verify)"]):
                with mock.patch.object(verify, "SIGNING_UNAVAILABLE", "objectstorage.py is missing"):
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        code = verify.main(
                            [
                                "--bucket",
                                FENCED,
                                "--foreign-control-bucket",
                                CONTROL,
                                "--policy-file",
                                POLICY_FILE,
                                *extra,
                            ],
                            transport=transport,
                            environ=dict(ENVIRONMENT),
                        )
                self.assertEqual(code, 2)
                self.assertIn("objectstorage.py is missing", err.getvalue())
        self.assertEqual(transport.calls, [])


class TestLockout(unittest.TestCase):
    def test_a_bucket_that_cannot_be_re_administered_is_shouted_about(self):
        answers = a_fully_working_fence()
        answers[("operator", "put-bucket-policy", FENCED)] = ACCESS_DENIED_WRITE
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("THE BUCKET MAY BE LOCKED", output)
        self.assertIn("Hetzner support request", output)

    def test_the_recoverability_check_runs_before_anything_touches_the_bucket(self):
        _, _, transport = run(a_fully_working_fence())
        put_policy = transport.calls.index(("operator", "put-bucket-policy", FENCED))
        put_object = transport.calls.index(("workload", "put-object", FENCED))
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
        return [check.probe for check in checks(**kwargs) if check.expect == "deny"]

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

    def test_the_write_probes_stay_under_the_probe_prefix(self):
        # prune_backups.py reads `dumps/` and `binlogs/`; a probe object under
        # either would enter the retention decision. Asserted on the object the
        # probe names rather than on its arguments, so a probe that changes
        # transport cannot drop out of the check by losing a flag.
        keyed = [check for check in checks() if check.probe.object_key is not None]
        self.assertGreaterEqual(len(keyed), 4)
        for check in keyed:
            with self.subTest(check=check.name):
                self.assertTrue(check.probe.object_key.startswith(verify.PROBE_PREFIX))

    def test_the_re_put_probes_send_the_document_that_is_already_stored(self):
        # A `put-bucket-policy` probe is a no-op only because its payload is
        # the policy the bucket already carries. A probe sending anything else
        # would rewrite a live fence on success.
        for check in checks():
            if check.probe.operation != "put-bucket-policy":
                continue
            with self.subTest(check=check.name):
                self.assertEqual(check.probe.payload, POLICY_DOCUMENT)


class TestCleanup(unittest.TestCase):
    def _versions_page(self, entries, *, truncated=False, markers=True):
        body = [
            b'<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult '
            b'xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        ]
        for tag, key, version in entries:
            body.append(
                f"<{tag}><Key>{key}</Key><VersionId>{version}</VersionId></{tag}>".encode()
            )
        body.append(f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>".encode())
        if truncated and markers:
            body.append(b"<NextKeyMarker>fence-probe/a.txt</NextKeyMarker>")
            body.append(b"<NextVersionIdMarker>v9</NextVersionIdMarker>")
        body.append(b"</ListVersionsResult>")
        return b"".join(body)

    def test_every_probe_object_version_and_delete_marker_is_removed(self):
        # A plain delete on a versioned bucket leaves the prior version
        # readable at ?versionId=, so the workload's delete is a check, not a
        # cleanup.
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = Response(
            "constructed: a ?versions page carrying one version and one delete marker",
            200,
            self._versions_page(
                [("Version", "fence-probe/a.txt", "v1"), ("DeleteMarker", "fence-probe/a.txt", "v2")]
            ),
        )
        _, _, transport = run(answers)
        deletes = [
            sent
            for sent in transport.sent
            if sent.operation == "delete-object" and sent.role == "operator"
        ]
        self.assertEqual(len(deletes), 2)
        self.assertEqual(
            sorted(urllib.parse.urlsplit(sent.url).query for sent in deletes),
            ["versionId=v1", "versionId=v2"],
        )

    def test_a_probe_object_left_behind_fails_the_run(self):
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = ACCESS_DENIED_VERSIONS
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("CLEANUP", output)

    def test_a_truncated_listing_is_paged_rather_than_taken_as_the_whole_bucket(self):
        # `aws s3api` paginated on the caller's behalf and nothing does that
        # here. A first page read as the whole listing leaves probe objects in
        # a production bucket and reports the run clean.
        pages = [
            self._versions_page([("Version", "fence-probe/a.txt", "v1")], truncated=True),
            self._versions_page([("Version", "fence-probe/b.txt", "v2")]),
        ]

        class Paged(Transport):
            def __call__(self, url, headers, payload, method):
                if "versions=" in url:
                    self.calls.append(("operator", "list-object-versions", FENCED))
                    self.sent.append(
                        Sent("operator", "list-object-versions", FENCED, None, url, headers, payload, method)
                    )
                    return 200, pages.pop(0) if pages else self._versions_page([])
                return super().__call__(url, headers, payload, method)

        transport = Paged(a_fully_working_fence())
        code, output, _ = run(a_fully_working_fence(), transport=transport)
        self.assertEqual(code, 0, output)
        listings = [sent for sent in transport.sent if sent.operation == "list-object-versions"]
        self.assertEqual(len(listings), 2)
        self.assertIn("key-marker=fence-probe%2Fa.txt", listings[1].url)
        deletes = [call for call in transport.calls if call[1] == "delete-object" and call[0] == "operator"]
        self.assertEqual(len(deletes), 2)

    def test_a_truncated_listing_with_no_marker_is_reported_rather_than_trusted(self):
        # This backend is recorded accepting a request and silently dropping an
        # element of the response. Read as complete, that page says the bucket
        # is clean when it is not.
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = Response(
            "constructed: a truncated page with no marker to resume from",
            200,
            self._versions_page([], truncated=True, markers=False),
        )
        code, output, _ = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("truncated with no marker", output)

    def test_a_listing_that_never_finishes_stops_rather_than_spinning(self):
        forever = self._versions_page([("Version", "fence-probe/a.txt", "v1")], truncated=True)
        answers = a_fully_working_fence()
        answers[("operator", "list-object-versions", FENCED)] = Response(
            "constructed: a page whose marker never advances", 200, forever
        )
        code, output, transport = run(answers)
        self.assertEqual(code, 1)
        self.assertIn("did not finish within", output)
        listings = [call for call in transport.calls if call[1] == "list-object-versions"]
        self.assertEqual(len(listings), verify._MAX_LIST_PAGES)


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
        transport = Transport({})
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
                transport=transport,
                environ={},
            )
        self.assertEqual(code, 0)
        self.assertEqual(transport.calls, [])
        self.assertIn("workload can read an object back", out.getvalue())

    def test_an_unreadable_policy_file_stops_the_run(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = verify.main(
                [
                    "--bucket",
                    FENCED,
                    "--foreign-control-bucket",
                    CONTROL,
                    "--policy-file",
                    "/nonexistent/policy.json",
                ],
                transport=Transport({}),
                environ=dict(ENVIRONMENT),
            )
        self.assertEqual(code, 2)
        self.assertIn("could not read --policy-file", err.getvalue())


if __name__ == "__main__":
    unittest.main()
