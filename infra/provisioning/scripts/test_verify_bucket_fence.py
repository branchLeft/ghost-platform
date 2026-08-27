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

import ast
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
import unittest
import urllib.parse
from unittest import mock

from bucketpolicy import decide

_MODULE_PATH = pathlib.Path(__file__).with_name("verify-bucket-fence.py")
_spec = importlib.util.spec_from_file_location("verify_bucket_fence", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
verify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify)

FENCED = "branchleft-db-backups"
CONTROL = "branchleft-tenant-pulumi-state"

# The diagnostic pauses between the two reads that have to agree, and between
# attempts to remove a probe policy. Captured before it is overridden, so
# `TestSettleIsRealInProduction` can assert the SHIPPED value is a real pause --
# a suite that patches the wait away and never checks it would pass just as
# happily against a build that had dropped the wait entirely.
PRODUCTION_SETTLE_SECONDS = verify.SETTLE_SECONDS
verify.SETTLE_SECONDS = 0
verify._sleep = lambda _seconds: None

OPERATOR_KEY = "O" * 20
WORKLOAD_KEY = "W" * 20
FOREIGN_KEY = "F" * 20
# Deliberately not all zeroes: `verify.ABSENT_PRINCIPAL` names an all-zeroes
# account precisely because no real project has one, and a fixture that shared
# it would make window D's "a principal that is definitely not us" name this
# suite's own account.
PROJECT_ID = "12345678"
ACCOUNT = f"p{PROJECT_ID}"

OPERATOR_ARN = f"arn:aws:iam:::user/{ACCOUNT}:{OPERATOR_KEY}"
WORKLOAD_ARN = f"arn:aws:iam:::user/{ACCOUNT}:{WORKLOAD_KEY}"
FOREIGN_ARN = f"arn:aws:iam:::user/{ACCOUNT}:{FOREIGN_KEY}"

ROLE_OF_KEY = {OPERATOR_KEY: "operator", WORKLOAD_KEY: "workload", FOREIGN_KEY: "foreign"}

# THE POLICY UNDER TEST IS THE ONE THE TOOL WILL BE POINTED AT. It comes from
# `render-bucket-fence-policy.py`, not from a stub written here, because a
# hand-written policy is a fixture built to the assumptions of whoever wrote
# it: a two-statement stub omits `DenyObjectMutationsExceptOperator`, which is
# the statement that distinguishes "this Deny does not name the workload"
# (correct, by design) from "this policy locks the workload out" (an outage).
# A suite that never evaluates the real document can be entirely green while
# the only input the tool ever receives is refused.
_render_spec = importlib.util.spec_from_file_location(
    "render_bucket_fence_policy", pathlib.Path(__file__).with_name("render-bucket-fence-policy.py")
)
render = importlib.util.module_from_spec(_render_spec)
_render_spec.loader.exec_module(render)

POLICY = render.render_policy(
    bucket=FENCED,
    project_id=PROJECT_ID,
    workload_access_keys=[WORKLOAD_KEY],
    admin_access_key=OPERATOR_KEY,
)
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
    constrains only what its author expected, and a probe covered by a fixture
    nobody checked against the wire can be green and unable to reach a verdict.

    Every instance registers itself, for the body checks in `tearDownModule`
    that need the actual bytes. The label check is static -- see
    `_fixture_labels` for why a registry cannot answer it.
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
# anticipated outcome, and the one where a probe that applied nothing must not
# then delete anything.
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

    def test_an_expensive_document_is_refused_before_it_is_expanded(self):
        # CAPPING THE INPUT DOES NOT CAP THE WORK. ElementTree expands internal
        # entities, so a body well under the input cap becomes a string that is
        # not: this one is 605 KB and expands to a gigabyte. Python 3.13 refuses
        # it; 3.9 is a supported target and does not, so the bound has to be
        # here rather than in the interpreter.
        #
        # The response body is the one input an attacker on the far end of the
        # connection chooses, and it is parsed on the path that decides whether
        # a bucket is fenced.
        entity = '<!DOCTYPE r [<!ENTITY a "' + "A" * 5000 + '">]>'
        body = (entity + "<Error><Code>" + "&a;" * 200000 + "</Code></Error>").encode()
        self.assertGreaterEqual(5000 * 200000, 10**9)
        started = time.monotonic()
        outcome, reason = verify.classify(403, body)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(outcome, "error")
        self.assertLess(len(reason), 500)

    def test_a_doctype_is_never_treated_as_an_error_document(self):
        # Internal entities are the only route from a small body to a large
        # one, and they need a doctype. No S3 error document carries one.
        self.assertIsNone(
            verify.s3_error_code(
                b'<!DOCTYPE Error><Error><Code>AccessDenied</Code></Error>'
            )
        )
        self.assertEqual(
            verify.classify(403, b'<!DOCTYPE Error><Error><Code>AccessDenied</Code></Error>')[0],
            "error",
        )

    def test_the_classifier_never_raises_even_if_the_parser_does(self):
        # `s3_error_code`'s contract is that it never raises, and `classify`
        # being total is what keeps `cleanup()` reachable: `run()` calls
        # `classify(*self.request(probe))`, so the parse of the untrusted body
        # happens outside the guard in `request`, and an exception escaping
        # there strands probe objects in a production bucket. Asserted against
        # the contract rather than against the exceptions this parser happens
        # to raise today.
        for failure in (MemoryError("out of memory"), RecursionError(), ValueError("nope")):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(verify.ET, "fromstring", side_effect=failure):
                    outcome, _ = verify.classify(403, b"<Error><Code>AccessDenied</Code></Error>")
                self.assertEqual(outcome, "error")

    def test_the_classifier_never_raises_whatever_the_body_is(self):
        # `run()` calls `classify(*self.request(probe))`, so the parse of the
        # untrusted body happens outside the guard in `request`. An exception
        # escaping there skips `cleanup()` and strands probe objects in a
        # production bucket.
        for body in (
            b"\xff\xfe\x00 not utf-8 at all",
            b"<Error><Code>" + b"\x00" * 100 + b"</Code></Error>",
            b"<" * 10000,
            b"<Error>" + b"<a>" * 5000,
            b'<?xml version="1.0" encoding="NOT-A-CHARSET"?><Error/>',
        ):
            with self.subTest(body=body[:20]):
                outcome, _ = verify.classify(403, body)
                self.assertEqual(outcome, "error")

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
        # Asserted on behaviour rather than on the import list: a subprocess
        # started anywhere under `main` fails this test. No client this file
        # could shell out to can render this backend's denials, so a probe that
        # reached one could not reach a verdict.
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

    def test_a_missing_signing_source_is_refused_with_the_fix(self):
        # A checkout without `db/provision/` can prove nothing. Both the
        # missing and the corrupt case have to refuse, and they have to refuse
        # differently: the likely cause of a missing file is someone working
        # from the scripts directory alone, and that is a fix an operator can
        # act on. A bare `FileNotFoundError` re-raised from the loader is not.
        import shared_objectstorage

        missing = pathlib.Path("/nonexistent/objectstorage.py")
        with mock.patch.object(shared_objectstorage, "_SOURCE", missing):
            with self.assertRaises(ImportError) as raised:
                shared_objectstorage._load()
        message = str(raised.exception)
        self.assertIn(str(missing), message)
        self.assertIn("Check out the whole of", message)
        self.assertNotIn("could not be executed", message)

    def test_a_corrupt_signing_source_is_refused_rather_than_traced_back(self):
        # SyntaxError is not ImportError, and the caller refuses on ImportError
        # alone. Both mean the same thing to an operator -- the signing is not
        # usable -- and both must produce the one-line refusal.
        import shared_objectstorage

        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
            handle.write("def broken(:\n")
            corrupt = pathlib.Path(handle.name)
        try:
            with mock.patch.object(shared_objectstorage, "_SOURCE", corrupt):
                with self.assertRaises(ImportError) as raised:
                    shared_objectstorage._load()
            self.assertIn("could not be executed", str(raised.exception))
            self.assertIn("SyntaxError", str(raised.exception))
        finally:
            corrupt.unlink()

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
        self.assertIn("THIS operator credential able to replace it", output)
        # The ARN under the wrong account names a principal that does not
        # exist, so the operator loses recovery along with everyone else.
        self.assertIn("s3:PutBucketPolicy", output)

    def test_a_correctly_rendered_policy_passes_preflight(self):
        code, output, _ = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertEqual(code, 0, output)
        self.assertIn("safe to apply", output)

    def test_preflight_writes_nothing(self):
        _, _, transport = run(a_fully_working_fence(), extra_args=["--preflight"])
        self.assertEqual([sent for sent in transport.sent if sent.method != "GET"], [])

    def test_preflight_exercises_the_transport_every_probe_uses(self):
        # A transport that does not work has to surface where nothing has been
        # written yet. The mode that discovers it otherwise is
        # --probe-notprincipal, which applies a policy to a production bucket
        # and removes it again. Pre-flight now signs and sends a
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

    def _preflight_rows(self, policy_document):
        return verify.preflight(
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
            policy_document=policy_document,
        )

    def _row(self, rows, role):
        return [row for row in rows if f"THIS {role} credential" in row[0]][0]

    def test_the_policy_this_repository_renders_passes_and_is_applied(self):
        # THE ONLY DOCUMENT THIS TOOL WILL EVER BE POINTED AT. A fence contains
        # Deny statements that name only the operator -- the version-destroying
        # object actions are withheld from the workload deliberately -- so a
        # check that read `NotPrincipal` lists structurally would condemn the
        # correct policy, `apply_fence` would refuse to write, and the runbook
        # could not terminate: re-rendering against the same account id changes
        # nothing, leaving a hand-run PUT that skips the in-process guard.
        rows = self._preflight_rows(POLICY_DOCUMENT)
        for role in ("operator", "workload"):
            with self.subTest(role=role):
                self.assertEqual(self._row(rows, role)[1], verify.PASS, self._row(rows, role))
        self.assertNotIn(verify.FAIL, [row[1] for row in rows])

        _, wrote = verify.apply_fence(
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
        self.assertTrue(wrote)

    def test_the_workload_keeps_exactly_what_it_needs_and_loses_the_rest(self):
        # The claim the workload row makes, asserted against the evaluator
        # rather than against the row. `DenyObjectMutationsExceptOperator` is
        # the statement a structural check misreads, and it is doing its job.
        arn = lambda key: f"arn:aws:iam:::user/{ACCOUNT}:{key}"
        objects, bucket = f"arn:aws:s3:::{FENCED}/dumps/x.age", f"arn:aws:s3:::{FENCED}"
        for action, resource in (
            ("s3:PutObject", objects), ("s3:GetObject", objects),
            ("s3:DeleteObject", objects), ("s3:ListBucket", bucket),
        ):
            with self.subTest(keeps=action):
                self.assertEqual(decide(POLICY, arn(WORKLOAD_KEY), action, resource), "allow")
        for action in ("s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:BypassGovernanceRetention"):
            with self.subTest(loses=action):
                self.assertEqual(decide(POLICY, arn(WORKLOAD_KEY), action, objects), "deny")
        for action in ("s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:DeleteBucket"):
            with self.subTest(loses=action):
                self.assertEqual(decide(POLICY, arn(WORKLOAD_KEY), action, bucket), "deny")

    def test_a_policy_that_really_does_lock_a_credential_out_fails(self):
        # The other direction. Each of these takes away an action the role
        # cannot do its job without, and `--apply` gates on the rows.
        for role, key, extra in (
            ("operator", OPERATOR_KEY, {
                "Sid": "NoRecovery", "Effect": "Deny",
                "NotPrincipal": {"AWS": [WORKLOAD_ARN]},
                "Action": "s3:PutBucketPolicy", "Resource": f"arn:aws:s3:::{FENCED}"}),
            # Recovery is both actions. A bucket whose policy can be replaced
            # but not removed is one whose fence cannot be taken off.
            ("operator", OPERATOR_KEY, {
                "Sid": "NoDelete", "Effect": "Deny",
                "NotPrincipal": {"AWS": [WORKLOAD_ARN]},
                "Action": "s3:DeleteBucketPolicy", "Resource": f"arn:aws:s3:::{FENCED}"}),
            ("workload", WORKLOAD_KEY, {
                "Sid": "NoWrites", "Effect": "Deny",
                "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                "Action": "s3:PutObject", "Resource": f"arn:aws:s3:::{FENCED}/*"}),
            ("workload", WORKLOAD_KEY, {
                "Sid": "NoList", "Effect": "Deny",
                "NotPrincipal": {"AWS": [OPERATOR_ARN]},
                "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{FENCED}"}),
        ):
            with self.subTest(role=role, sid=extra["Sid"]):
                broken = {"Version": POLICY["Version"], "Statement": POLICY["Statement"] + [extra]}
                row = self._row(self._preflight_rows(json.dumps(broken).encode()), role)
                self.assertEqual(row[1], verify.FAIL, row)
                self.assertIn(extra["Action"], row[2])
                self.assertIn(f"arn:aws:iam:::user/{ACCOUNT}:{key}", row[2])

    def test_a_deny_scoped_to_the_probe_prefix_is_not_a_workload_lockout(self):
        # `--probe-notprincipal` applies exactly this policy: reads under the
        # probe prefix denied to everyone but the operator. Evaluated at a
        # concrete key under that prefix the workload looks locked out of the
        # bucket, which is false -- nothing it does lives there.
        probe_on_bucket = {
            "Version": POLICY["Version"],
            "Statement": POLICY["Statement"]
            + [verify.probe_policy(FENCED, OPERATOR_ARN)["Statement"][0]],
        }
        row = self._row(self._preflight_rows(json.dumps(probe_on_bucket).encode()), "workload")
        self.assertEqual(row[1], verify.PASS, row)

    def test_a_deny_on_every_resource_is_not_invisible(self):
        # `Resource: "*"` reaches this bucket as surely as a named ARN does.
        broken = {
            "Version": POLICY["Version"],
            "Statement": POLICY["Statement"] + [
                {"Sid": "DenyAll", "Effect": "Deny", "NotPrincipal": {"AWS": [WORKLOAD_ARN]},
                 "Action": "s3:*", "Resource": "*"}
            ],
        }
        row = self._row(self._preflight_rows(json.dumps(broken).encode()), "operator")
        self.assertEqual(row[1], verify.FAIL, row)

    def test_a_document_the_evaluator_cannot_walk_is_inconclusive_not_safe(self):
        # `--policy-file` takes any file. A document nothing can reason about
        # is not the same as one that is safe to apply.
        for document in (
            b'{"Statement": [{"Effect": "Deny"}]}',
            b'{"Statement": [{"Effect": "Deny", "Resource": "*"}]}',
            b'{"Statement": "not a list"}',
            b'{"Statement": [null]}',
        ):
            with self.subTest(document=document[:40]):
                rows = self._preflight_rows(document)
                statuses = [row[1] for row in rows]
                self.assertIn(verify.INCONCLUSIVE, statuses)
                self.assertNotIn(verify.PASS, [r[1] for r in rows if "THIS " in r[0]])

    def test_an_owner_of_anonymous_is_refused_whatever_its_case(self):
        # The one unrecoverable path: an account id that cannot exist, named in
        # a policy principal. Nothing guarantees the endpoint keeps spelling it
        # the way it does today.
        for spelling in (b"anonymous", b"Anonymous", b"ANONYMOUS"):
            with self.subTest(spelling=spelling):
                answers = a_fully_working_fence()
                answers[("operator", "list-buckets", None)] = Response(
                    "constructed: the captured anonymous ListAllMyBuckets, recased",
                    200,
                    ANONYMOUS_OWNER.body.replace(b"anonymous", spelling),
                )
                code, output, _ = run(answers, extra_args=["--preflight"])
                self.assertEqual(code, 1)
                self.assertIn("saw this request as unsigned", output)

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
        # A control on a different transport licenses nothing: it establishes
        # that some other client worked for that credential, which is not the
        # question the probe beside it is answering.
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

    def test_the_operator_read_alone_is_never_reported_as_an_exemption(self):
        # THE MISREADING THIS ROW HAS ALREADY PRODUCED ONCE. A live run reported
        # `NotPrincipal EXEMPTS the named key -- PASS` beside a foreign key that
        # was also allowed, and it was recorded as proof the exemption works. It
        # never was: a statement the engine ignores entirely produces exactly
        # that operator read. Only the pair separates the two, so the pair
        # decides this row, and an operator allowed alongside a foreign key that
        # was also allowed is INCONCLUSIVE here rather than a pass.
        code, output, _ = self._run(OBJECT_BYTES, OBJECT_BYTES)
        self.assertEqual(code, 1)
        exempts = [
            line for line in output.splitlines() if "NotPrincipal EXEMPTS" in line
        ]
        self.assertEqual(len(exempts), 1)
        self.assertTrue(exempts[0].startswith(verify.INCONCLUSIVE), exempts[0])
        self.assertIn("the statement reached nobody", output)
        self.assertIn("--diagnose-policy-engine", output)

    def test_the_exemption_only_passes_when_the_foreign_key_was_actually_denied(self):
        # The other half of the same rule: a pass here needs both reads, and the
        # engine that produces them is the only one it can describe.
        code, output, _ = self._run(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        self.assertEqual(code, 0, output)
        exempts = [line for line in output.splitlines() if "NotPrincipal EXEMPTS" in line]
        self.assertTrue(exempts[0].startswith(verify.PASS), exempts[0])

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
        with self.assertRaises(verify.VerifierError) as raised:
            verify.assert_probe_policy_is_reversible(locking, FENCED)
        # The two refusals guard different outcomes and the message has to say
        # which one fired: naming the bucket resource is the unrecoverable
        # case, because `PutBucketPolicy` is a bucket-resource action, so the
        # document could deny its own removal. "Outside the probe prefix" is
        # the broader hygiene rule and does not tell an operator that.
        self.assertIn("names the bucket resource", str(raised.exception))
        self.assertIn("unremovable", str(raised.exception))

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
        with self.assertRaises(verify.VerifierError) as raised:
            verify.assert_probe_policy_is_reversible(broad, FENCED)
        self.assertIn("outside the probe prefix", str(raised.exception))

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

    def test_a_policy_read_that_did_not_succeed_stops_the_probe_before_it_writes(self):
        # THE ONE THAT DESTROYS A FENCE. "There is definitely a policy" is not
        # the only case that must stop this step -- "we could not find out" has
        # to as well. Applying the probe replaces whatever is on the bucket and
        # removing it afterwards leaves nothing, so a transient 503, a reset
        # connection, a truncated body or an AccessDenied on the policy read
        # would each end with a live fence overwritten and then deleted, on the
        # strength of a request that failed.
        for label, answer in (
            ("a transient 503", Response(
                "constructed: a gateway 503 on the policy read",
                503,
                b"<Error><Code>ServiceUnavailable</Code></Error>",
            )),
            ("a refused read", ACCESS_DENIED_POLICY),
            ("a body that is not an error document", BAD_GATEWAY_HTML),
        ):
            with self.subTest(case=label):
                answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
                answers[("operator", "get-bucket-policy", FENCED)] = answer
                code, output, transport = run(answers, extra_args=["--probe-notprincipal"])
                self.assertEqual(code, 1)
                self.assertIn("the bucket's current policy is known", output)
                self.assertIn("Nothing has been written", output)
                self.assertNotIn(("operator", "put-bucket-policy", FENCED), transport.calls)
                self.assertNotIn(("operator", "delete-bucket-policy", FENCED), transport.calls)

    def test_a_connection_that_never_answered_stops_the_probe_too(self):
        # `status is None` reaches the same call site as a 503 and means even
        # less about what is on the bucket.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        reads = {"n": 0}

        class Flaky(Transport):
            def __call__(self, url, headers, payload, method):
                if method == "GET" and "policy=" in url:
                    reads["n"] += 1
                    raise verify.storage.ObjectStorageError("GET ... failed to complete: reset")
                return super().__call__(url, headers, payload, method)

        transport = Flaky(answers)
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"], transport=transport)
        self.assertEqual(code, 1)
        self.assertEqual(reads["n"], 1)
        self.assertIn("the bucket's current policy is known", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), transport.calls)

    def test_only_an_affirmative_no_such_bucket_policy_lets_it_proceed(self):
        # The affirmative answer, and the only one: this bucket has no policy.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)
        self.assertEqual(
            verify.s3_error_code(answers[("operator", "get-bucket-policy", FENCED)].body),
            "NoSuchBucketPolicy",
        )
        code, output, transport = run(answers, extra_args=["--probe-notprincipal"])
        self.assertEqual(code, 0, output)
        self.assertIn(("operator", "put-bucket-policy", FENCED), transport.calls)

    def test_a_put_that_got_no_response_leaves_the_policy_alone_and_says_so(self):
        # The genuine dilemma: the PUT may have reached the engine. Deleting
        # would be a DELETE on a bucket whose state this run cannot establish;
        # not deleting may leave the probe behind. The safer half is taken, and
        # the operator is told which way it went rather than left with a row
        # that reads like a clean refusal.
        answers = self._answers(OBJECT_BYTES, ACCESS_DENIED_OBJECT)

        class Silent(Transport):
            def __call__(self, url, headers, payload, method):
                if method == "PUT" and "policy=" in url:
                    raise verify.storage.ObjectStorageError(
                        "PUT ... failed to complete: timed out"
                    )
                return super().__call__(url, headers, payload, method)

        transport = Silent(answers)
        code, output, _ = run(answers, extra_args=["--probe-notprincipal"], transport=transport)
        self.assertEqual(code, 1)
        self.assertIn("THE PROBE POLICY'S FATE IS UNKNOWN", output)
        self.assertIn(verify.probe_policy_id(FENCED), output)
        self.assertNotIn(("operator", "delete-bucket-policy", FENCED), transport.calls)
        self.assertNotIn(verify.PASS, output)


STORED_POLICY_ECHO = (
    "constructed: GetBucketPolicy returning the document that was PUT, which is what a "
    "bucket holding a policy answers"
)


def _principal_names(statement: dict) -> object:
    """The access key ids one statement's `Principal` names, or `"*"`."""
    principal = statement["Principal"]["AWS"]
    if principal == "*":
        return "*"
    return {arn.rsplit(":", 1)[-1] for arn in principal}


# THE ENGINES. Each is one coherent answer to "what does a bucket policy do
# here", written as the rule that decides a single read. They exist so the
# diagnostic can be run against several of them and its verdicts compared: a
# probe that reports the same thing in two worlds is worth nothing, and asserting
# that these produce different verdicts is the only way to know it does not.
#
# `key` is the access key id the read was signed with; `statement` is the one
# statement the live policy carries, or None when the bucket has no policy.
PROJECT_KEYS = frozenset({OPERATOR_KEY, WORKLOAD_KEY, FOREIGN_KEY})


def engine_per_key(key, statement):
    """Principals resolve per key. What S3 itself does."""
    names = _principal_names(statement)
    return names == "*" or key in names


def engine_wildcard_unimplemented(key, statement):
    """Named ARNs resolve per key; `Principal: "*"` denies nobody.

    A FENCE IS FULLY BUILDABLE HERE. This engine exists because the first shape
    of this diagnostic gated the whole run on a wildcard Deny reaching the
    subject key, and would have reported this world as
    `BUCKET POLICIES ARE NOT ENFORCED` -- sending the estate to per-tenant
    Hetzner projects while the two windows that show the fence works were never
    sent.
    """
    names = _principal_names(statement)
    return names != "*" and key in names


def engine_enforces_nothing(key, statement):
    """Policies are stored and evaluated against nobody."""
    return False


def engine_one_principal_per_project(key, statement):
    """Every credential in the project is one RGW user, and an ARN resolves to it.

    The tracker issue's hypothesis 1, and the reason window D exists. The name
    IS read -- it just resolves to the single storage user every key in the
    project shares, so a Deny naming one of them denies all of them. A principal
    in another account still resolves to something else, which is what tells
    this apart from `engine_ignores_principal` below.
    """
    names = _principal_names(statement)
    return names == "*" or bool(names & PROJECT_KEYS)


def engine_ignores_the_arn_format(key, statement):
    """Only `*` matches: an ARN in this form resolves to nothing at all.

    Distinct from `engine_one_principal_per_project` -- there the ARN resolves
    and names everybody, here it resolves to nobody, and the two differ on
    whether a principal deny discriminates across projects.
    """
    return _principal_names(statement) == "*"


def engine_ignores_principal(key, statement):
    """The Principal element is decoration: the statement matches every caller."""
    return True


def engine_inverts_principal(key, statement):
    """The statement matches everyone EXCEPT the principal it names."""
    names = _principal_names(statement)
    return True if names == "*" else key not in names


def engine_exempts_the_owner(key, statement):
    """Principals resolve, but the bucket owner is never denied by its own policy."""
    return key != OPERATOR_KEY and engine_per_key(key, statement)


def _separates_two_keys(rule) -> bool:
    """Whether this engine can fence one credential from another, asked of IT.

    Derived by running the engine rather than by looking a verdict up, so a test
    comparing this against the report is checking the diagnostic against the
    world it was run in and not against the diagnostic's own table.
    """
    aimed_at_the_subject = {"Principal": {"AWS": [f"arn:aws:iam:::user/{ACCOUNT}:{FOREIGN_KEY}"]}}
    return rule(FOREIGN_KEY, aimed_at_the_subject) and not rule(WORKLOAD_KEY, aimed_at_the_subject)


class Engine(Transport):
    """A stand-in storage engine that holds a policy and answers reads under it.

    The fixed `answers` map every other test uses cannot express this: the whole
    question is what changes about one read when the policy under it changes, so
    the transport has to carry the policy rather than a table of outcomes.
    """

    def __init__(self, rule, *, stores=True, removable=True, accepts=True):
        super().__init__({(role, "list-buckets", None): OWNER for role in ROLE_OF_KEY.values()})
        self.rule = rule
        self.stores = stores
        self.removable = removable
        self.accepts = accepts
        self.policy = None

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

        if operation == "put-bucket-policy":
            if not self.accepts:
                return REJECTED_POLICY.status, REJECTED_POLICY.body
            # `stores=False` is this backend's recorded habit of accepting a
            # configuration and silently dropping part of it.
            self.policy = payload if self.stores else b'{"Version": "2012-10-17", "Statement": []}'
            return OK_EMPTY.status, OK_EMPTY.body
        if operation == "get-bucket-policy":
            if self.policy is None:
                return NO_SUCH_BUCKET_POLICY.status, NO_SUCH_BUCKET_POLICY.body
            return 200, Response(STORED_POLICY_ECHO, 200, self.policy).body
        if operation == "delete-bucket-policy":
            if not self.removable:
                return ACCESS_DENIED_WRITE.status, ACCESS_DENIED_WRITE.body
            self.policy = None
            return NO_CONTENT.status, NO_CONTENT.body
        if operation == "get-object":
            access_key = re.search(r"Credential=([^/]+)/", headers["Authorization"]).group(1)
            statement = json.loads(self.policy)["Statement"][0] if self.policy else None
            if statement is not None and self.rule(access_key, statement):
                return ACCESS_DENIED_OBJECT.status, ACCESS_DENIED_OBJECT.body
            return OBJECT_BYTES.status, OBJECT_BYTES.body
        if operation == "put-object":
            return OK_EMPTY.status, OK_EMPTY.body
        if operation == "delete-object":
            return NO_CONTENT.status, NO_CONTENT.body
        if operation == "list-object-versions":
            return EMPTY_VERSIONS.status, EMPTY_VERSIONS.body
        return super().__call__(url, headers, payload, method)


def diagnose(engine, extra=()):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = verify.main(
            ["--bucket", FENCED, "--diagnose-policy-engine", *extra],
            transport=engine,
            environ=dict(ENVIRONMENT),
        )
    return code, out.getvalue()


class TestPolicyEngineDiagnostic(unittest.TestCase):
    """Which world we are in, and the proof that the probes can tell them apart.

    A live `Deny` carrying `NotPrincipal` was enforced against nobody. An engine
    that enforces no policy, an engine on which every credential in a project is
    one principal, and an engine that does not implement `NotPrincipal` all
    produce that observation, and they have opposite consequences. These tests
    are about the diagnostic returning a DIFFERENT answer in each of those
    worlds -- because a probe that answers the same in two of them is exactly
    what was mistaken for evidence before.
    """

    WORLDS = {
        "per-key principals resolve": engine_per_key,
        "named ARNs resolve and `*` does not": engine_wildcard_unimplemented,
        "policies are not enforced": engine_enforces_nothing,
        "every credential is one RGW user": engine_one_principal_per_project,
        "the ARN form resolves to nobody": engine_ignores_the_arn_format,
        "the principal element is decoration": engine_ignores_principal,
        "the principal match is inverted": engine_inverts_principal,
    }

    def _headline(self, output):
        lines = [line for line in output.splitlines() if line.isupper() and line.endswith(".")]
        self.assertTrue(lines, f"no verdict headline in the output:\n{output}")
        return lines[0]

    def test_an_engine_that_resolves_principals_says_a_fence_is_rebuildable(self):
        code, output = diagnose(Engine(engine_per_key))
        self.assertEqual(code, 0, output)
        self.assertIn("PER-KEY PRINCIPALS RESOLVE", output)
        # Even the good world does not license applying the fence in this
        # repository: that one fences by `NotPrincipal`, which this mode never
        # sends and which was observed live denying nobody.
        self.assertIn("do not apply it anywhere else", output)

    def test_an_engine_that_does_not_implement_the_wildcard_still_reports_a_fence(self):
        # THE WORLD A WILDCARD GATE WOULD HAVE THROWN AWAY. Named ARNs resolve
        # per key here, so a fence is fully buildable -- but `Principal: "*"`
        # denies nobody, and a run that stopped on that would have reported no
        # policy works at all and sent the estate to per-tenant projects.
        engine = Engine(engine_wildcard_unimplemented)
        code, output = diagnose(engine)
        self.assertEqual(code, 0, output)
        self.assertIn("PER-KEY PRINCIPALS RESOLVE", output)
        self.assertNotIn("BUCKET POLICIES ARE NOT ENFORCED", output)

    def test_the_wildcard_window_is_not_sent_when_the_reading_does_not_turn_on_it(self):
        # It is the only document that denies the operator by construction, so
        # it is the one window worth not sending.
        engine = Engine(engine_per_key)
        code, output = diagnose(engine)
        self.assertEqual(code, 0, output)
        sids = [
            json.loads(sent.payload)["Statement"][0]["Sid"]
            for sent in engine.sent
            if sent.operation == "put-bucket-policy"
        ]
        self.assertEqual(sids, ["ProbeDenyTheSubjectKey", "ProbeDenyTheOtherKey", "ProbeDenyAnAbsentPrincipal"])
        self.assertNotIn("ProbeDenyEveryPrincipal", sids)
        self.assertIn("was not needed", output)

    def test_nothing_is_enforced_needs_every_window_to_have_denied_nobody(self):
        # The claim is about the whole account and it sends the estate to
        # per-tenant projects, so it is the last thing that may be drawn from
        # one document shape.
        engine = Engine(engine_enforces_nothing)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("BUCKET POLICIES ARE NOT ENFORCED ON THIS ACCOUNT", output)
        puts = [call for call in engine.calls if call[1] == "put-bucket-policy"]
        self.assertEqual(len(puts), 4)

    def test_hypothesis_one_is_told_apart_from_an_engine_that_ignores_the_principal(self):
        # THE COLLISION WINDOW D EXISTS TO REMOVE. On both engines a Deny naming
        # either real key denies both of them; only a name that can resolve to
        # nothing separates them, and they differ on whether a project per
        # tenant is a mechanism that would work.
        one_user = self._headline(diagnose(Engine(engine_one_principal_per_project))[1])
        decoration = self._headline(diagnose(Engine(engine_ignores_principal))[1])
        self.assertIn("EVERY CREDENTIAL IN THIS PROJECT IS ONE PRINCIPAL", one_user)
        self.assertIn("THE PRINCIPAL ELEMENT IS DECORATION", decoration)
        self.assertNotEqual(one_user, decoration)

    def test_only_the_one_user_reading_offers_a_project_per_tenant_as_a_way_out(self):
        # The two readings differ in exactly the consequence that matters: a
        # principal deny still discriminates across projects under one and not
        # under the other, and that decides the replacement design.
        _, one_user = diagnose(Engine(engine_one_principal_per_project))
        _, decoration = diagnose(Engine(engine_ignores_principal))
        self.assertIn("a project per tenant is the mechanism that remains", " ".join(one_user.split()))
        self.assertIn("does not rescue this either", " ".join(decoration.split()))

    def test_an_engine_that_ignores_the_principal_is_told_apart_from_a_working_one(self):
        # Window B alone cannot: a Deny naming the subject key denies it in both
        # worlds. Window C is what separates them, by naming the OTHER key.
        code, output = diagnose(Engine(engine_ignores_principal))
        self.assertEqual(code, 1)
        self.assertIn("THE PRINCIPAL ELEMENT IS DECORATION", output)

    def test_an_engine_that_inverts_the_match_is_named_rather_than_guessed_at(self):
        code, output = diagnose(Engine(engine_inverts_principal))
        self.assertEqual(code, 1)
        self.assertIn("MATCHES THE COMPLEMENT OF THE PRINCIPAL", output)

    def test_the_report_says_a_fence_is_possible_exactly_when_the_engine_separates_keys(self):
        # THE NON-TAUTOLOGICAL ONE. `_separates_two_keys` asks the simulated
        # engine directly whether a Deny naming one key denies that key and
        # spares another, so this compares the report against the world it ran
        # in rather than against the diagnostic's own verdict table. A
        # classifier that swapped `RESOLVES_PER_KEY` for `NAME_IS_DECORATION`
        # -- telling Rob a fence is possible in exactly the world where a fence
        # is an outage -- passes every mapping test and fails this one.
        for name, rule in self.WORLDS.items():
            with self.subTest(world=name):
                code, output = diagnose(Engine(rule))
                headline = "A BUCKET POLICY CAN FENCE ONE KEY FROM ANOTHER HERE"
                row = [line for line in output.splitlines() if headline in line]
                self.assertEqual(len(row), 1, output)
                self.assertEqual(
                    row[0].startswith(verify.PASS), _separates_two_keys(rule), output
                )
                self.assertEqual(code == 0, _separates_two_keys(rule))

    def test_no_two_worlds_produce_the_same_verdict(self):
        # THE MUTATION CHECK ON THE WHOLE DIAGNOSTIC. A probe set that reported
        # the same thing in two of these worlds would be worthless -- which is
        # precisely what the withdrawn NotPrincipal result was, so this is
        # asserted rather than argued.
        # Compared on the HEADLINE alone. Pairing it with the exit code would
        # let two worlds sharing a verdict pass on differing exit codes, which
        # is a collision the test is supposed to catch rather than tolerate.
        verdicts = {}
        for name, rule in self.WORLDS.items():
            verdicts[name] = self._headline(diagnose(Engine(rule))[1])
        # Two of these seven SHOULD share a reading: an engine that resolves
        # named ARNs reads the same whether or not it implements `*`, because
        # the wildcard changes nothing about whether a fence can be built. Every
        # other pair must differ.
        expected_collisions = 1
        self.assertEqual(
            len(set(verdicts.values())), len(self.WORLDS) - expected_collisions, verdicts
        )
        self.assertEqual(
            verdicts["per-key principals resolve"],
            verdicts["named ARNs resolve and `*` does not"],
        )

    def test_an_engine_that_exempts_the_bucket_owner_is_caught_without_the_wildcard(self):
        # The reason the subject of every window is the OTHER key. This engine
        # answers the operator `allowed` under every statement, so an operator's
        # read is not evidence about the engine anywhere in this file. The
        # exemption is still detected: window C names the operator, and window B
        # has already shown that names resolve, so an operator reading through
        # window C's Deny is one the engine spares -- no wildcard needed.
        engine = Engine(engine_exempts_the_owner)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("exempts the bucket owner", output)
        self.assertIn("PER-KEY PRINCIPALS RESOLVE", output)
        self.assertNotIn("BUCKET POLICIES ARE NOT ENFORCED", output)
        sids = [
            json.loads(sent.payload)["Statement"][0]["Sid"]
            for sent in engine.sent
            if sent.operation == "put-bucket-policy"
        ]
        self.assertNotIn("ProbeDenyEveryPrincipal", sids)

    def test_a_document_the_engine_did_not_store_yields_no_reads_at_all(self):
        # Ruling out "accepted but not stored". A 2xx on the PUT is not evidence
        # a document is in force, and reads taken against a policy that was
        # never stored measure some other fence.
        engine = Engine(engine_per_key, stores=False)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("the bucket stores the document that was sent", output)
        self.assertIn("not the document that was sent", output)
        reads = [call for call in engine.calls if call[1] == "get-object"]
        # The eight baseline reads -- two roles on each of four objects -- and
        # not one taken under a probe policy.
        self.assertEqual(len(reads), 8)

    def test_a_rejected_document_produces_no_verdict(self):
        engine = Engine(engine_per_key, accepts=False)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("NO SINGLE READING EXPLAINS", output)
        self.assertNotIn(("operator", "delete-bucket-policy", FENCED), engine.calls)

    def test_a_probe_policy_that_could_not_be_removed_stops_the_run_there(self):
        engine = Engine(engine_per_key, removable=False)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("THE PROBE POLICY IS REMOVED", output)
        puts = [call for call in engine.calls if call[1] == "put-bucket-policy"]
        self.assertEqual(len(puts), 1)

    def test_the_removal_of_a_probe_policy_is_retried_before_it_is_given_up_on(self):
        # One transient 503 leaving a document on the estate's only offsite
        # backup bucket is not an acceptable failure mode for a probe.
        engine = Engine(engine_per_key, removable=False)
        diagnose(engine)
        deletes = [call for call in engine.calls if call[1] == "delete-bucket-policy"]
        self.assertEqual(len(deletes), verify._REMOVAL_ATTEMPTS)

    def test_a_removal_that_succeeds_on_a_retry_lets_the_run_continue(self):
        class Flaky(Engine):
            refusals = 1

            def __call__(self, url, headers, payload, method):
                if method == "DELETE" and "policy=" in url and self.refusals:
                    self.refusals -= 1
                    self.calls.append(("operator", "delete-bucket-policy", FENCED))
                    return ACCESS_DENIED_WRITE.status, ACCESS_DENIED_WRITE.body
                return super().__call__(url, headers, payload, method)

        engine = Flaky(engine_per_key)
        code, output = diagnose(engine)
        self.assertEqual(code, 0, output)
        self.assertNotIn("THE PROBE POLICY IS REMOVED", output)

    def test_every_window_reads_a_key_of_its_own_rather_than_a_cached_verdict(self):
        # `Verifier.run` caches by probe, and the same read under a different
        # policy is a different fact. A cached answer would report a later
        # window's verdict from an earlier window's policy.
        engine = Engine(engine_per_key)
        diagnose(engine)
        reads = [sent for sent in engine.sent if sent.operation == "get-object"]
        # Eight baseline, then two roles read twice in each of three windows.
        self.assertEqual(len(reads), 8 + 3 * 4)
        self.assertEqual(len({sent.key for sent in reads}), 4)

    def test_the_verdict_is_the_last_thing_printed_and_the_evidence_the_first(self):
        code, output = diagnose(Engine(engine_ignores_the_arn_format))
        self.assertLess(output.index("RAW EVIDENCE"), output.index("A NAMED PRINCIPAL"))
        self.assertIn("BASELINE -- no policy on the bucket", output)
        self.assertIn("WINDOW B -- sent:", output)
        self.assertIn("WINDOW B -- stored:", output)

    def test_a_read_that_changes_between_two_attempts_yields_no_verdict(self):
        # THE CONSISTENCY HAZARD. Reading the policy back proves it reached the
        # node that answered GetBucketPolicy, not the one answering GetObject,
        # and every way that can fail biases a read towards `allowed` -- the
        # direction that produces the loudest readings in this file. A read that
        # did not settle is one no reading may be drawn from.
        class Drifting(Engine):
            seen = 0

            def __call__(self, url, headers, payload, method):
                if verify.PROBE_PREFIX in url and method == "GET" and self.policy:
                    self.seen += 1
                    if self.seen == 1:
                        self.calls.append(("foreign", "get-object", FENCED))
                        return OBJECT_BYTES.status, OBJECT_BYTES.body
                return super().__call__(url, headers, payload, method)

        code, output = diagnose(Drifting(engine_per_key))
        self.assertEqual(code, 1)
        self.assertIn("did not settle on one answer", " ".join(output.split()))
        self.assertIn("NO SINGLE READING EXPLAINS", output)

    def test_the_confirming_read_is_a_second_request_and_not_a_cached_answer(self):
        engine = Engine(engine_per_key)
        diagnose(engine)
        under_policy = [
            sent
            for sent in engine.sent
            if sent.operation == "get-object" and sent.role == "foreign"
        ]
        # One baseline read plus two under the policy, on each of the three
        # objects the run actually opened a window for.
        by_key = {}
        for sent in under_policy:
            by_key.setdefault(sent.key, 0)
            by_key[sent.key] += 1
        self.assertEqual(sorted(by_key.values()), [1, 3, 3, 3])

    def test_the_evidence_block_carries_no_access_key_id(self):
        # This repository is public and the block exists to be pasted into the
        # issue that asked the question. An id nobody can paste does not get
        # recorded, and a recorded id is one this repo published.
        _, output = diagnose(Engine(engine_per_key))
        for key in (OPERATOR_KEY, WORKLOAD_KEY, FOREIGN_KEY):
            with self.subTest(key=key[:4]):
                self.assertNotIn(key, output)
        self.assertIn(f"...{FOREIGN_KEY[-4:]}", output)


class TestPolicyEngineProbesAreSafe(unittest.TestCase):
    """Nothing this diagnostic sends can lock a bucket or strand an object."""

    def _documents(self):
        engine = Engine(engine_per_key)
        diagnose(engine)
        return [
            json.loads(sent.payload)
            for sent in engine.sent
            if sent.operation == "put-bucket-policy"
        ]

    def _every_document(self):
        """All four, whether or not a given run sends them."""
        return [
            verify.diagnostic_policy(FENCED, sid, principal)
            for _, sid, principal in verify._diagnostic_plan(OPERATOR_ARN, FOREIGN_ARN)
        ]

    def test_every_document_it_sends_passes_the_reversibility_assertion(self):
        documents = self._every_document()
        self.assertEqual(len(documents), 4)
        for document in documents:
            with self.subTest(sid=document["Statement"][0]["Sid"]):
                verify.assert_probe_policy_is_reversible(document, FENCED)

    def test_no_document_names_the_bucket_resource_or_any_other_action(self):
        # The bucket resource is what `PutBucketPolicy` and `DeleteBucketPolicy`
        # are asked at, so a statement naming it could deny its own removal.
        # Window A denies the operator by construction, which is exactly why.
        for document in self._documents():
            statement = document["Statement"][0]
            with self.subTest(sid=statement["Sid"]):
                self.assertEqual(statement["Effect"], "Deny")
                self.assertEqual(statement["Action"], "s3:GetObject")
                self.assertEqual(
                    statement["Resource"], f"arn:aws:s3:::{FENCED}/{verify.PROBE_PREFIX}*"
                )

    def test_a_probe_that_denied_the_delete_of_its_own_object_is_refused(self):
        # A guard that has quietly stopped refusing anything passes everything,
        # so prove this one still fires. `s3:DeleteObject` under the probe
        # prefix would refuse the cleanup that removes the probe object.
        for action in ("s3:DeleteObject", "s3:*", ["s3:GetObject", "s3:DeleteObject"]):
            with self.subTest(action=action):
                document = verify.diagnostic_policy(FENCED, "Probe", {"AWS": "*"})
                document["Statement"][0]["Action"] = action
                with self.assertRaises(verify.VerifierError) as raised:
                    verify.assert_probe_policy_is_reversible(document, FENCED)
                self.assertIn("could refuse the delete", str(raised.exception))

    def test_a_statement_naming_no_action_at_all_is_refused(self):
        document = verify.diagnostic_policy(FENCED, "Probe", {"AWS": "*"})
        del document["Statement"][0]["Action"]
        with self.assertRaises(verify.VerifierError):
            verify.assert_probe_policy_is_reversible(document, FENCED)

    def test_the_bucket_is_left_with_no_policy_and_no_probe_object(self):
        engine = Engine(engine_per_key)
        code, output = diagnose(engine)
        self.assertEqual(code, 0, output)
        self.assertIsNone(engine.policy)
        deletes = [call for call in engine.calls if call == ("operator", "delete-bucket-policy", FENCED)]
        self.assertEqual(len(deletes), 3)
        self.assertIn(("operator", "list-object-versions", FENCED), engine.calls)

    def test_every_probe_object_is_written_before_any_policy_exists(self):
        # A write refused by a live Deny would look like an endpoint problem,
        # and a probe object created under one policy and read under another is
        # not the same experiment.
        engine = Engine(engine_per_key)
        diagnose(engine)
        writes = [i for i, call in enumerate(engine.calls) if call[1] == "put-object"]
        first_policy = engine.calls.index(("operator", "put-bucket-policy", FENCED))
        self.assertEqual(len(writes), 4)
        self.assertLess(max(writes), first_policy)

    def test_an_unsendable_document_is_refused_before_a_single_object_is_written(self):
        # `assert_probe_policy_is_reversible` raises, and a VerifierError
        # escaping the diagnostic skips the cleanup that removes probe objects.
        # Asserting every document up front means the raise cannot happen after
        # anything exists to clean up.
        engine = Engine(engine_per_key)
        with mock.patch.object(verify, "PROBE_ACTIONS", frozenset({"s3:NoSuchAction"})):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                code = verify.main(
                    ["--bucket", FENCED, "--diagnose-policy-engine"],
                    transport=engine,
                    environ=dict(ENVIRONMENT),
                )
        self.assertEqual(code, 2)
        self.assertNotIn(("operator", "put-object", FENCED), engine.calls)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), engine.calls)

    def test_the_absent_principal_is_not_one_of_the_credentials_in_use(self):
        # Window D's whole job is naming a principal that is definitely not us.
        # One that happened to name a real key would report the decoration
        # reading for an engine that resolves per key -- "no fence is possible"
        # for a world where one is.
        self.assertNotIn(ACCOUNT, verify.ABSENT_PRINCIPAL)
        for key in (OPERATOR_KEY, WORKLOAD_KEY, FOREIGN_KEY):
            self.assertNotIn(key, verify.ABSENT_PRINCIPAL)

    def test_an_absent_principal_that_named_a_live_credential_stops_the_run(self):
        engine = Engine(engine_per_key)
        with mock.patch.object(
            verify, "ABSENT_PRINCIPAL", f"arn:aws:iam:::user/{ACCOUNT}:{FOREIGN_KEY}"
        ):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                code = verify.main(
                    ["--bucket", FENCED, "--diagnose-policy-engine"],
                    transport=engine,
                    environ=dict(ENVIRONMENT),
                )
        self.assertEqual(code, 2)
        self.assertIn("absent principal", err.getvalue())
        self.assertNotIn(("operator", "put-object", FENCED), engine.calls)

    def test_it_refuses_a_bucket_that_already_carries_a_policy(self):
        engine = Engine(engine_per_key)
        engine.policy = POLICY_DOCUMENT
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("already carries a policy", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), engine.calls)

    def test_a_leftover_diagnostic_policy_is_replaceable_and_named_as_such(self):
        engine = Engine(engine_per_key)
        engine.policy = json.dumps(
            verify.diagnostic_policy(FENCED, "ProbeDenyEveryPrincipal", {"AWS": "*"})
        ).encode()
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("left its own probe policy", output)
        code, output = diagnose(engine, extra=["--replace-existing-policy"])
        self.assertEqual(code, 0, output)

    def test_a_key_that_cannot_read_its_object_with_no_policy_stops_the_run(self):
        # THE CONTROL. Without it a denial in a window could be the key, the
        # object or the endpoint, and a denial whose cause is unknown recorded
        # as a fence is the mistake this whole file exists to prevent.
        class Unreadable(Engine):
            def __call__(self, url, headers, payload, method):
                if verify.PROBE_PREFIX in url and FOREIGN_KEY in headers.get("Authorization", ""):
                    if method == "GET":
                        self.calls.append(("foreign", "get-object", FENCED))
                        return ACCESS_DENIED_OBJECT.status, ACCESS_DENIED_OBJECT.body
                return super().__call__(url, headers, payload, method)

        engine = Unreadable(engine_per_key)
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("with NO policy in force", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), engine.calls)

    def test_two_credentials_in_different_accounts_stop_it_before_it_writes(self):
        engine = Engine(engine_per_key)
        engine.answers[("foreign", "list-buckets", None)] = OTHER_OWNER
        code, output = diagnose(engine)
        self.assertEqual(code, 1)
        self.assertIn("would be that boundary and not the policy", output)
        self.assertNotIn(("operator", "put-bucket-policy", FENCED), engine.calls)

    def test_the_dry_run_prints_every_document_and_sends_nothing(self):
        engine = Engine(engine_per_key)
        code, output = diagnose(engine, extra=["--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(engine.calls, [])
        for sid in (
            "ProbeDenyTheSubjectKey",
            "ProbeDenyTheOtherKey",
            "ProbeDenyAnAbsentPrincipal",
            "ProbeDenyEveryPrincipal",
        ):
            self.assertIn(sid, output)

    def test_the_operator_and_the_foreign_key_may_not_be_the_same_credential(self):
        # Windows B and C would then be the same document with the same name in
        # it, so the pair that decides the whole verdict would be one
        # observation counted twice.
        environment = dict(ENVIRONMENT)
        environment["FENCE_FOREIGN_ACCESS_KEY_ID"] = OPERATOR_KEY
        engine = Engine(engine_per_key)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = verify.main(
                ["--bucket", FENCED, "--diagnose-policy-engine"],
                transport=engine,
                environ=environment,
            )
        self.assertEqual(code, 2)
        self.assertIn("the same access key", err.getvalue())
        self.assertEqual(engine.calls, [])

    def test_the_workload_credential_is_not_required_for_this_mode(self):
        # Every argument or variable an operator does not have to supply is one
        # they cannot supply wrongly, and this mode never signs as the workload.
        environment = {
            name: value
            for name, value in ENVIRONMENT.items()
            if "WORKLOAD" not in name
        }
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verify.main(
                ["--bucket", FENCED, "--diagnose-policy-engine"],
                transport=Engine(engine_per_key),
                environ=environment,
            )
        self.assertEqual(code, 0, out.getvalue())

    def test_this_mode_needs_no_policy_file_and_no_control_bucket(self):
        # Every argument an operator does not have to type is one they cannot
        # mistype into a production bucket -- and rendering a fence to ask
        # whether a fence is possible is backwards.
        code, output = diagnose(Engine(engine_per_key))
        self.assertEqual(code, 0, output)


class TestPolicyEngineVerdicts(unittest.TestCase):
    """The readings, as pure functions, one cell at a time."""

    READS = ("allowed", "denied")

    def _cells(self):
        for named in self.READS:
            for other in self.READS:
                for absent in self.READS:
                    yield named, other, absent

    def test_the_wildcard_window_reports_what_it_saw_and_never_a_reading(self):
        # It names no engine and ends no run. `WILDCARD_DENIES_NOBODY` is
        # deliberately not `NOT_ENFORCED`: the same observation comes from an
        # engine that resolves named ARNs and does not implement `*`, where a
        # fence is fully buildable.
        self.assertEqual(
            verify.wildcard_observation("denied", "denied"), verify.WILDCARD_DENIES_BOTH
        )
        self.assertEqual(
            verify.wildcard_observation("denied", "allowed"), verify.WILDCARD_SPARES_THE_OWNER
        )
        self.assertEqual(
            verify.wildcard_observation("allowed", "allowed"), verify.WILDCARD_DENIES_NOBODY
        )
        self.assertEqual(verify.wildcard_observation("allowed", "denied"), verify.UNEXPLAINED)
        self.assertNotIn(
            verify.WILDCARD_DENIES_NOBODY, verify.FENCE_IS_POSSIBLE,
        )

    def test_an_unreadable_response_never_becomes_an_engine_verdict(self):
        for reads in (
            ("error", "denied", "allowed"),
            ("denied", "error", "allowed"),
            ("denied", "allowed", "error"),
            ("error", "error", "error"),
        ):
            with self.subTest(reads=reads):
                self.assertEqual(verify.principal_verdict(*reads, "denied"), verify.UNEXPLAINED)
        for foreign, operator in (("error", "denied"), ("denied", "error")):
            self.assertEqual(verify.wildcard_observation(foreign, operator), verify.UNEXPLAINED)

    def test_a_fence_is_reported_possible_only_where_a_deny_hit_the_key_it_named_alone(self):
        # THE ASSERTION THAT IS NOT THE MAPPING RESTATED. "A fence is possible"
        # means one thing: naming a key denied that key, and denied nobody else.
        # A classifier that swapped `RESOLVES_PER_KEY` with `NAME_IS_DECORATION`
        # -- reporting a buildable fence in exactly the world where a fence is
        # an outage -- is a bijection and passes every injectivity check, and
        # fails this.
        for named, other, absent in self._cells():
            for wildcard in self.READS:
                with self.subTest(named=named, other=other, absent=absent, wildcard=wildcard):
                    separates = (named, other, absent) == ("denied", "allowed", "allowed")
                    verdict = verify.principal_verdict(named, other, absent, wildcard)
                    self.assertEqual(verify.FENCE_IS_POSSIBLE[verdict], separates)

    def test_a_reading_is_named_only_where_the_reads_are_self_consistent(self):
        # Every cell that IS named must be explained by an engine that could
        # produce all three reads. The mixtures no coherent principal semantics
        # produces get no name at all, because naming one would be a guess.
        coherent = {
            ("denied", "allowed", "allowed"),
            ("denied", "denied", "allowed"),
            ("denied", "denied", "denied"),
            ("allowed", "denied", "denied"),
            ("allowed", "allowed", "allowed"),
        }
        for reads in self._cells():
            with self.subTest(reads=reads):
                verdict = verify.principal_verdict(*reads, "denied")
                self.assertEqual(verdict != verify.UNEXPLAINED, reads in coherent)

    def test_the_absent_principal_read_is_what_separates_two_named_readings(self):
        # Window D, stated as the thing it buys. Without it these two cells are
        # one observation, and they differ on whether a project per tenant is a
        # mechanism that would work.
        one_user = verify.principal_verdict("denied", "denied", "allowed", "denied")
        decoration = verify.principal_verdict("denied", "denied", "denied", "denied")
        self.assertEqual(one_user, verify.ONE_PRINCIPAL_PER_PROJECT)
        self.assertEqual(decoration, verify.NAME_IS_DECORATION)
        self.assertNotEqual(one_user, decoration)

    def test_the_wildcard_read_is_consulted_in_exactly_one_cell(self):
        # It costs the only document that denies the operator, so it is sent
        # only where it changes the answer -- and `needs_wildcard` has to agree
        # with the classifier about which cell that is.
        for reads in self._cells():
            with self.subTest(reads=reads):
                differs = verify.principal_verdict(*reads, "denied") != verify.principal_verdict(
                    *reads, "allowed"
                )
                self.assertEqual(differs, verify.needs_wildcard(*reads))

    def test_a_missing_wildcard_read_in_the_cell_that_needs_one_names_no_reading(self):
        self.assertEqual(
            verify.principal_verdict("allowed", "allowed", "allowed", ""), verify.UNEXPLAINED
        )
        self.assertEqual(
            verify.principal_verdict("allowed", "allowed", "allowed", "denied"),
            verify.NAME_MATCHES_NOBODY,
        )
        self.assertEqual(
            verify.principal_verdict("allowed", "allowed", "allowed", "allowed"),
            verify.NOT_ENFORCED,
        )

    def test_only_one_reading_leaves_a_fence_possible(self):
        possible = [name for name, ok in verify.FENCE_IS_POSSIBLE.items() if ok]
        self.assertEqual(possible, [verify.RESOLVES_PER_KEY])

    def test_every_reading_the_classifier_can_return_has_prose_and_a_consequence(self):
        # A reading added without an entry in either mapping would otherwise
        # reach the report as a KeyError, or worse, default to "a fence is fine".
        returned = {
            verify.principal_verdict(*reads, wildcard)
            for reads in self._cells()
            for wildcard in ("", *self.READS)
        }
        self.assertEqual(returned, set(verify.FENCE_IS_POSSIBLE))
        self.assertEqual(returned, set(verify.VERDICT_TEXT))

    def test_every_reading_has_prose_that_says_what_to_do_next(self):
        # A verdict an operator has to interpret is a verdict that gets
        # interpreted wrongly, which is the whole history here. Every one of
        # them opens with a headline, tells the operator what not to apply, and
        # asks for the output to be recorded.
        for verdict in verify.FENCE_IS_POSSIBLE:
            with self.subTest(verdict=verdict):
                text = " ".join(verify.VERDICT_TEXT[verdict].split())
                self.assertTrue(verify.VERDICT_TEXT[verdict].splitlines()[0].isupper())
                self.assertIn("not apply", text)
                self.assertIn("Record", text)

    def test_the_settle_pause_that_ships_is_a_real_one(self):
        # This suite sets it to zero so the tests do not wait. A suite that
        # patched the wait away and never checked the shipped value would pass
        # against a build that had dropped the wait entirely -- and the wait is
        # what stops a consistency artefact becoming the loudest reading here.
        self.assertGreaterEqual(PRODUCTION_SETTLE_SECONDS, 1)
        self.assertGreaterEqual(verify._REMOVAL_ATTEMPTS, 2)

    def test_the_runbook_documents_every_verdict_this_tool_can_print(self):
        # The runbook is what an operator reads under pressure, and a verdict
        # the tool can print but the runbook does not list is one they meet with
        # nothing to act on. Adding a seventh reading and forgetting the table
        # is the drift this catches.
        runbook = (
            pathlib.Path(__file__).parents[3] / "RUNBOOK-bucket-fencing.md"
        ).read_text(encoding="utf-8")
        for verdict, text in verify.VERDICT_TEXT.items():
            headline = text.splitlines()[0].rstrip(".")
            with self.subTest(verdict=verdict):
                self.assertIn(headline, runbook)

    def test_the_plan_the_dry_run_prints_is_the_plan_the_run_sends(self):
        plan = verify._diagnostic_plan("operator-arn", "foreign-arn")
        # A last: it is the only document that denies the operator, so it is
        # sent only where the reading turns on it.
        self.assertEqual([window for window, _, _ in plan], ["B", "C", "D", "A"])
        principals = [principal for _, _, principal in plan]
        self.assertEqual(principals[0], {"AWS": ["foreign-arn"]})
        self.assertEqual(principals[1], {"AWS": ["operator-arn"]})
        self.assertEqual(principals[2], {"AWS": [verify.ABSENT_PRINCIPAL]})
        self.assertEqual(principals[3], {"AWS": "*"})


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
        # It never leaves this process except as an HMAC. No argument vector
        # carries it either, which matters because argv is readable out of the
        # process table by every other process on the workstation.
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


def _fixture_labels():
    """Every `Response(...)` in this file, read from its source.

    Static rather than runtime, because a runtime registry only ever holds the
    fixtures constructed so far: `unittest` runs classes in alphabetical order,
    so a registry inspected from a test class sees nothing built by the classes
    that sort after it, and `Response.every` starts empty in every process.
    Roughly half the fixtures here are built inside test methods.

    A label has to be resolvable from the source -- a literal, a module
    constant, or a concatenation of those. One computed at run time cannot be
    checked here and is refused on that basis.
    """
    tree = ast.parse(pathlib.Path(__file__).read_text(encoding="utf-8"))
    labels = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Name) and node.func.id == "Response"):
            continue
        argument = node.args[0] if node.args else None
        labels.append((node.lineno, _resolve(argument)))
    return labels


def _resolve(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        value = globals().get(node.id)
        return value if isinstance(value, str) else None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _resolve(node.left), _resolve(node.right)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr) and node.values:
        # An f-string: only the literal head decides the prefix.
        return _resolve(node.values[0])
    return None


class TestFixtureProvenance(unittest.TestCase):
    """Every fixture states whether it was seen on the wire or written here.

    One observed on the wire constrains the code; one written here constrains
    only what its author expected, and a fixture built to an assumption is the
    defect this whole file exists to stop shipping.
    """

    LABELS = ("observed:", "constructed:")

    # A Ceph RGW transaction id, which is what this endpoint puts in RequestId
    # and HostId. Matched by shape rather than by a `-hel1-prod1-` substring,
    # so a response captured from another region or cluster is caught too.
    REQUEST_ID = re.compile(rb"tx[0-9a-f]{10,}|-prod\d+-")

    def test_every_fixture_in_this_file_says_where_it_came_from(self):
        labels = _fixture_labels()
        self.assertGreaterEqual(len(labels), 25)
        for line, label in labels:
            with self.subTest(line=line):
                self.assertIsNotNone(label, f"line {line}: provenance label is not a literal")
                self.assertTrue(
                    label.startswith(self.LABELS), f"line {line}: {label[:60]!r}"
                )

    def test_the_scan_reaches_fixtures_built_inside_test_methods(self):
        # The half a runtime registry inspected from here cannot see. The class
        # definitions all begin after the module-level fixtures, so a scan that
        # found only those would report nothing past that line.
        labels = _fixture_labels()
        first_class = min(
            node.lineno
            for node in ast.walk(ast.parse(pathlib.Path(__file__).read_text(encoding="utf-8")))
            if isinstance(node, ast.ClassDef)
        )
        self.assertGreaterEqual(len([line for line, _ in labels if line > first_class]), 8)

    def test_the_scan_refuses_an_unlabelled_fixture(self):
        # A guard that has quietly stopped covering anything passes every
        # fixture, so prove it still refuses one.
        tree = ast.parse('Response("I AM UNLABELLED", 200)\nResponse(observed_name, 200)\n')
        found = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Response":
                found.append(_resolve(node.args[0] if node.args else None))
        self.assertEqual(len(found), 2)
        self.assertFalse(found[0].startswith(self.LABELS))
        self.assertIsNone(found[1])

    def test_the_request_identifier_matcher_still_matches_a_real_one(self):
        for real in (
            b"<RequestId>tx0000043296e609d7694e1-006a8eb7bf-1a7ba04d-hel1-prod1-ceph4</RequestId>",
            b"<HostId>1a7ba04d-hel1-prod1-ceph4-hel1</HostId>",
        ):
            with self.subTest(real=real[:20]):
                self.assertIsNotNone(self.REQUEST_ID.search(real))
        self.assertIsNone(self.REQUEST_ID.search(b"<RequestId>N/A</RequestId>"))

    def test_the_body_checks_refuse_what_must_not_be_committed(self):
        # `tearDownModule` runs these over every fixture, and a check that has
        # quietly stopped refusing anything passes them all. This repository is
        # public, so each of these lands in git if the check is asleep.
        #
        # Built as stand-ins rather than as `Response`s: a real one would be
        # registered and scanned like any other fixture, and the static label
        # check would refuse the unlabelled case here -- correctly, which is
        # itself the point.
        bad = [
            _Fixture("observed: real shape", b"<RequestId>tx0000043296e609d7694e1-hel1-prod1-ceph4</RequestId>"),
            _Fixture("observed: real shape", b"AWS4-HMAC-SHA256 Signature=deadbeef"),
            _Fixture("observed: real shape", b"aws_secret_access_key=..."),
            _Fixture("no label at all", b""),
        ]
        self.assertEqual(len(fixture_body_problems(bad)), 4)
        self.assertEqual(fixture_body_problems(Response.every), [])

    def test_module_teardown_actually_fails_the_run_on_a_bad_fixture(self):
        # The wiring, not just the helper: `tearDownModule` is the only thing
        # that sees every fixture, so it is the only place a bad body can be
        # refused, and a teardown that collects problems and drops them is
        # indistinguishable from a clean run.
        mark = len(Response.every)
        Response.every.append(
            _Fixture("observed: real shape", b"<HostId>1a7ba04d-hel1-prod1-ceph4-hel1</HostId>")
        )
        try:
            with self.assertRaises(AssertionError) as raised:
                tearDownModule()
            self.assertIn("live request identifier", str(raised.exception))
        finally:
            del Response.every[mark:]
        tearDownModule()


class _Fixture:
    """A `source`/`body` pair for exercising `fixture_body_problems` itself."""

    def __init__(self, source, body):
        self.source = source
        self.body = body


def fixture_body_problems(fixtures):
    """What must not be committed, found in the bytes of a fixture.

    This repository is public, so an unscrubbed `RequestId` or anything
    credential-shaped in a fixture body lands in git.
    """
    problems = []
    for fixture in fixtures:
        source = fixture.source[:50]
        if not fixture.source.startswith(TestFixtureProvenance.LABELS):
            problems.append(f"unlabelled fixture: {source!r}")
        if TestFixtureProvenance.REQUEST_ID.search(fixture.body):
            problems.append(f"live request identifier in {source!r}")
        if b"secret" in fixture.body.lower() or b"Signature=" in fixture.body:
            problems.append(f"credential-shaped bytes in {source!r}")
    return problems


def tearDownModule():
    """The body checks, after every test has run and built its fixtures.

    Module teardown rather than a test method, because these need the actual
    bytes and `Response.every` is only complete once nothing else will add to
    it -- `unittest` runs classes in alphabetical order, so a test method
    cannot see the fixtures built by the classes that sort after it. The label
    check is static and does not need this.
    """
    problems = fixture_body_problems(Response.every)
    if problems:
        raise AssertionError("; ".join(problems))


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
