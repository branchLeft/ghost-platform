#!/usr/bin/env python3
"""Prove a bucket fence works, in both directions, against the live bucket.

WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A LIST OF DENIALS.

A single `AccessDenied` is not evidence that a fence works. It is returned by a
working fence, by a credential that was revoked, by a typo in a key id, by a
region mismatch in the SigV4 scope, and by a bucket that lives in a different
project entirely. Those are different facts with one wire response, and a
denial recorded without distinguishing them has already been mistaken here for
proof of per-bucket key scoping that does not exist on this backend: the bucket
that returned it was in a different project, so the denial was the project
boundary and said nothing about the key's scope.

So every denial check in this file carries a CONTROL: a probe on the *same
credential*, sent over the *same transport*, that must succeed. If the control
does not succeed, the denial is reported as INCONCLUSIVE, never as a pass --
because a key that reaches nothing tells you nothing about the fence, and a
control that travelled some other client licenses nothing about the one the
probe used. The one check with no control available is labelled as such and
proves only that the bucket is not world-readable.

And every fence has a second direction that matters just as much: the key that
is supposed to keep working must still work. A policy that denies everybody is
not a fence, it is an outage -- on the backup bucket, a silent one that surfaces
at the next restore.

THE CHECK THAT MATTERS MOST IS REVERSIBLE, AND RUNS FIRST.
`--diagnose-policy-engine` asks the live engine the questions every other check
assumes the answers to: is a bucket policy enforced here at all, and does naming
one access key in a statement separate that key from another one? A live run
found a `Deny` this file wrote enforced against nobody -- neither the key it
exempted nor the key it should have refused -- and that single observation fits
an engine that enforces no policy, an engine on which every credential in a
project is one principal, and an engine that simply does not implement
`NotPrincipal`. Those have opposite consequences: the last leaves a fence
rebuildable, the first two leave no bucket policy able to separate anything and
put the boundary at a separate Hetzner project. So the mode is built around one
rule -- a probe whose result only ONE of those engines could produce -- and the
long comment above `diagnose_policy_engine` sets out how each window earns it.

`--probe-notprincipal` is the narrower question, kept because it is the one the
fence in this repository is actually built on: does this backend read
`NotPrincipal` as an exemption, or as decoration?

Every other guard here, and both guards outside this file, validate a document
against a MODEL of S3 evaluation. None of them touches Hetzner's implementation,
which is undocumented on this point. If its principal match short-circuits
naively -- "a `Principal` field is present and is not me, so this statement does
not apply" inverted, or simply ignored -- then
`DenyBucketConfigurationExceptOperator` matches EVERY principal including the
operator's. The apply succeeds. The second PUT comes back `AccessDenied`. The
bucket is then unrecoverable from inside the account, with `DeleteBucket` denied
by the same statement, and every offline guard will have passed on the way in.

So this mode applies a policy whose only `Deny` is scoped to an unused object
prefix and names no bucket-resource action at all, then reads an object back as
the operator AND as a foreign key. Denied for the operator means `NotPrincipal`
does not exempt on this engine and the real fence would have locked the bucket.
Allowed for the operator means nothing on its own -- a statement the engine
ignores entirely produces that same read -- so only the pair decides it, and a
foreign key that was also allowed is INCONCLUSIVE here, never a pass. That
misreading has already been made once and recorded as an answer.

The probe policy cannot lock anything, because it contains no statement on the
bucket resource -- so `PutBucketPolicy` and `DeleteBucketPolicy` stay available
to every key throughout, and the probe is removed at the end. That reversibility
is asserted in code before the policy is sent, not assumed.

AND THEN `--preflight`, which resolves each credential's own storage account and
then evaluates the policy against the ARN built from it. Nothing else can:
every principal in a rendered policy comes from one `--project-id` argument, so
the generator's own recoverability check compares a fabricated ARN against
itself and passes for any value at all. Live, an ARN carrying the right access
key under the wrong account names a principal that does not exist --
`NotPrincipal` exempts nobody, the operator loses `PutBucketPolicy` along with
everyone else, and the bucket cannot be recovered from inside the account. One
mistyped digit is enough. `--preflight` writes nothing.

It asks that as an EVALUATION question, through `bucketpolicy.decide`, and not
by reading `NotPrincipal` lists. A working fence contains Deny statements that
name only the operator -- the version-destroying object actions are withheld
from the workload deliberately -- so "this Deny does not name the workload" is
what a correct fence looks like, and a structural reading of it condemns the
policy this repository's own renderer emits.

`--preflight` also exercises the transport every probe uses, on all three
credentials, before anything has been written. A transport that does not work
has to surface where nothing has been written yet, not in the middle of
`--probe-notprincipal`, which applies a policy to a production bucket and
removes it again.

`--apply` then runs the pre-flight and the double PUT in ONE process, so the
guard cannot be skipped by an operator who ran the real `put-bucket-policy` from
a different terminal than the check.

After the policy is applied, the check that cannot wait is `put-bucket-policy`
as the operator, re-PUTting the document just applied: a no-op when it succeeds
and the only warning you will ever get when it does not. Run it before leaving
the terminal, not the next morning.

A PROBE MUST BE SAFE WHEN IT SUCCEEDS. These run against live production
buckets, so every denial check either only reads, or writes back the state the
bucket is already in. That is why the bucket ACL is never set here at all
(`put-bucket-acl` replaces rather than merges, and nothing can assert the
current ACL) and why the versioning probe is behind
`--versioning-already-enabled`: turning versioning on for a bucket that has it
off, with no lifecycle rule, retains every superseded object indefinitely.

WHY NOTHING HERE SHELLS OUT TO A CLIENT. This backend's storage engine returns
its error documents with an empty `<Message></Message>`, and `aws s3api` v2
exits 255 printing a client-internal error in place of the S3 one rather than
render that. It is not specific to an operation: `get-object`,
`list-objects-v2`, `get-bucket-policy`, `put-object` and `list-buckets` all do
it, for `AccessDenied` and `InvalidAccessKeyId` alike. What does render is the
gateway's own `NoSuchBucket`, which carries a real message -- which is why the
failure looked at first like one broken command. `head-object` renders too,
because a HEAD response has no body to fail on, but it reports a refusal as the
code `403`: an HTTP status rather than an S3 error code, matching no denial set
here, so it was not a way out either. A CLI that cannot render a denial cannot
prove a fence: every denial probe on it came back INCONCLUSIVE -- fail-safe,
and useless as evidence.

So every request this file makes is signed and sent by
`db/provision/objectstorage.py`, the same implementation db1's backup pipeline
uses, reached through `shared_objectstorage.py`. There is no second copy of the
signing to rot, no external client to be missing or too old, and no credential
written to a temporary file for one.

THE HTTP STATUS IS NEVER ENOUGH ON ITS OWN. `AccessDenied`,
`InvalidAccessKeyId` and `SignatureDoesNotMatch` all arrive as HTTP 403, so a
status-only reading turns a dead key into a fence -- the substitution the
controls above exist to prevent. A verdict of `denied` comes from the `Code`
inside the returned error document and from nowhere else, so a response this
file cannot interpret is an `error` whatever its status.

Credentials come from the environment, one pair per role, and are never
accepted as arguments:

    FENCE_OPERATOR_ACCESS_KEY_ID / FENCE_OPERATOR_SECRET_ACCESS_KEY
    FENCE_WORKLOAD_ACCESS_KEY_ID / FENCE_WORKLOAD_SECRET_ACCESS_KEY
    FENCE_FOREIGN_ACCESS_KEY_ID  / FENCE_FOREIGN_SECRET_ACCESS_KEY

The foreign role is any real key in the same project that has no business in
this bucket. It must be a live key with an entitlement somewhere, named by
`--foreign-control-bucket`, or its denials prove nothing.

`--diagnose-policy-engine` takes the operator and foreign pairs only. It reaches
no verdict about a fence -- a verdict about a fence is a statement about which
credentials it separates and needs all three -- and it establishes the foreign
key is live by reading an object it just wrote with no policy on the bucket,
which is a stronger control than an entitlement in some other bucket.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import uuid
import xml.etree.ElementTree as ET

from bucketpolicy import (
    RECOVERY_ACTIONS,
    WORKLOAD_BUCKET_ACTIONS,
    WORKLOAD_OBJECT_ACTIONS,
    decide,
)

try:
    import shared_objectstorage as storage
except Exception as _error:  # pragma: no cover - exercised through SIGNING_UNAVAILABLE
    # Broader than ImportError on purpose: a corrupt `objectstorage.py` raises
    # SyntaxError, and an operator needs the same one-line refusal for that as
    # for a missing file, not a traceback.
    storage = None
    SIGNING_UNAVAILABLE = str(_error)
else:
    SIGNING_UNAVAILABLE = ""

PROBE_PREFIX = "fence-probe/"

# The only action any probe policy is allowed to deny. A Deny on anything else
# under the probe prefix could refuse the delete that removes the probe object,
# so if the removal of the policy also failed the object would sit under a Deny
# with nothing left to lift it. One action, and a resource check beside it, keep
# every probe recoverable by construction rather than by argument.
PROBE_ACTIONS = frozenset({"s3:GetObject"})

S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/"

VERSIONING_ENABLED = (
    f'<VersioningConfiguration xmlns="{S3_NS}"><Status>Enabled</Status></VersioningConfiguration>'
).encode()

# An S3 error code is a short identifier. Anything else in that element is not
# one, and passing it through would put attacker-influenced text of arbitrary
# length into a reason the report prints as a line of its own.
S3_ERROR_CODE = re.compile(r"[A-Za-z0-9_]{1,64}")

# Enough for any error document this endpoint returns, and small enough that a
# body built to be expensive to parse is truncated before it is.
_MAX_ERROR_BODY = 64 * 1024

# A listing walks pages until it is complete. This bound exists so that an
# endpoint answering with a marker that never advances cannot spin here
# forever; it is far above any real `fence-probe/` listing.
_MAX_LIST_PAGES = 50

# Denials. `AllAccessDisabled` is what this backend returns when the bucket
# exists but the caller may not learn anything about it.
DENIAL_CODES = frozenset({"AccessDenied", "AllAccessDisabled"})

# Failures that LOOK like denials to a reader skimming output but are not
# statements about the policy at all. Each is a reason a control probe exists.
NOT_A_DENIAL = {
    "InvalidAccessKeyId": "the key id does not exist -- this says nothing about the fence",
    "SignatureDoesNotMatch": "wrong secret, or a region/endpoint mismatch in the SigV4 scope",
    "NoSuchBucket": "the bucket name is wrong, or it is in a different project",
    "ExpiredToken": "the credential has expired",
}

# What this endpoint reports as the owner of an UNSIGNED request: it answers
# `GET /` with HTTP 200 and this id rather than refusing. An account resolved
# to it is not an account, it is the absence of a signature.
ANONYMOUS_OWNER = "anonymous"

ROLE_ENV = {
    "operator": ("FENCE_OPERATOR_ACCESS_KEY_ID", "FENCE_OPERATOR_SECRET_ACCESS_KEY"),
    "workload": ("FENCE_WORKLOAD_ACCESS_KEY_ID", "FENCE_WORKLOAD_SECRET_ACCESS_KEY"),
    "foreign": ("FENCE_FOREIGN_ACCESS_KEY_ID", "FENCE_FOREIGN_SECRET_ACCESS_KEY"),
}

PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"


class VerifierError(Exception):
    """The verification could not be set up, so no verdict is available."""


class Probe:
    """One signed S3 request, as one role.

    The S3 operation is named independently of the HTTP request that carries
    it. The invariants asserted over the check set -- that no probe changes
    bucket state on success, that every write stays under the probe prefix --
    are about what reaches the bucket, and must keep holding however the
    request happens to be spelled.
    """

    def __init__(
        self,
        role: str,
        description: str,
        *,
        operation: str,
        method: str,
        bucket: str,
        key: str | None = None,
        query: dict[str, str] | None = None,
        payload: bytes = b"",
        content_type: str | None = None,
    ):
        self.role = role
        self.description = description
        self.operation = operation
        self.method = method
        self.bucket = bucket
        self.object_key = key
        self.query = query
        self.payload = payload
        self.content_type = content_type

    def cache_key(self) -> tuple:
        query = tuple(sorted((self.query or {}).items()))
        return (self.role, self.method, self.bucket, self.object_key, query, self.payload)


class Check:
    def __init__(
        self,
        name: str,
        probe: Probe,
        expect: str,
        control: Probe | None = None,
        critical: bool = False,
        note: str = "",
    ):
        self.name = name
        self.probe = probe
        self.expect = expect
        self.control = control
        self.critical = critical
        self.note = note


def _one_line(text: str, limit: int = 200) -> str:
    """Flatten external text before it becomes a reason on a report line.

    `report()` prints one row per line, so a response body containing a newline
    would render as extra lines -- and text arriving from the far end of the
    connection is exactly what must not be able to write a line that reads like
    a verdict.
    """
    return " ".join(text.split())[:limit]


def _decoded(body: bytes) -> str:
    return body[:_MAX_ERROR_BODY].decode("utf-8", errors="replace")


def _from_error_code(code: str) -> tuple[str, str]:
    """Turn one S3 error code into a verdict. The only place that happens."""
    if code in DENIAL_CODES:
        return "denied", code
    if code in NOT_A_DENIAL:
        return "error", f"{code}: {NOT_A_DENIAL[code]}"
    return "error", f"{code}: not a denial and not a success"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def s3_error_code(body: bytes) -> str | None:
    """The `Code` of an S3 error document, or None if this is not one.

    Parsed rather than pattern-matched, so that a body which is not an error
    document -- an HTML page from something sitting in front of the endpoint, a
    truncated response, an object whose own contents mention a code -- yields
    nothing to act on rather than a code lifted out of prose.

    THIS FUNCTION NEVER RAISES, and the response body is the one input here
    that an attacker on the far end of the connection chooses. Three bounds,
    because capping the input alone does not cap the work:

      1. A `DOCTYPE` is refused outright. Internal entities are the only way a
         small body becomes a large one, ElementTree expands them, and no S3
         error document has ever carried a doctype -- so 500 bytes cannot
         become a gigabyte of `Code`.
      2. The body is capped before parsing, and the code is held to
         `S3_ERROR_CODE` after it.
      3. Anything else the parser can raise comes back as "not an error
         document". A response that cannot be read is one no verdict can be
         drawn from, which is the same answer by a different route.
    """
    text = _decoded(body).strip()
    if "<!DOCTYPE" in text:
        return None
    try:
        root = ET.fromstring(text)
    except Exception:
        return None
    if _local_name(root.tag) != "Error":
        return None
    for child in root:
        if _local_name(child.tag) != "Code":
            continue
        code = (child.text or "").strip()
        return code if S3_ERROR_CODE.fullmatch(code) else None
    return None


def classify(status: int | None, body: bytes, failure: str = "") -> tuple[str, str]:
    """Map one response onto `allowed` / `denied` / `error`, with a reason.

    THE HTTP STATUS ALONE NEVER PRODUCES A DENIAL. This endpoint answers
    `AccessDenied`, `InvalidAccessKeyId` and `SignatureDoesNotMatch` with the
    same 403 -- a fence, a key that does not exist, and a key signed for the
    wrong region are one status code, and reading that code as a denial is the
    substitution the controls in this file exist to prevent. The verdict comes
    from the `Code` inside the error document and from nothing else, so a
    response with no error document in it is an `error` whatever its status.

    Anything that is not a clean success or a recognised denial is `error`, and
    an error never contributes to a pass. Collapsing an unrecognised failure
    into "denied" is the mistake this whole file exists to prevent.
    """
    if status is None:
        return "error", f"the request did not complete: {_one_line(failure)}"
    if 200 <= status < 300:
        return "allowed", ""
    code = s3_error_code(body)
    if code is None:
        return (
            "error",
            f"HTTP {status} with no S3 error document to read a code from: "
            f"{_one_line(_decoded(body))}",
        )
    return _from_error_code(code)


def _default_transport(url, headers, payload, method):
    if storage is None:  # pragma: no cover - main() refuses before this is reachable
        raise VerifierError(SIGNING_UNAVAILABLE)
    return storage.urllib_request(url, headers, payload, method)


class Verifier:
    def __init__(self, *, endpoint: str, region: str, credentials: dict, transport=None):
        self.host = _endpoint_host(endpoint)
        self.region = region
        self.credentials = credentials
        self.transport = _default_transport if transport is None else transport
        # Whether ANY request got a response. `--preflight` reports this as a
        # row of its own, so a workstation that cannot reach the endpoint at
        # all says so plainly instead of printing three credential failures.
        self.reached_endpoint = False
        self._outcomes: dict[tuple, tuple[str, str]] = {}

    def request(self, probe: Probe) -> tuple[int | None, bytes, str]:
        """Send one probe. A failure to send is an outcome, not an exception.

        An exception escaping here skips `cleanup()`, which leaves probe
        objects in a production bucket. Both a transport failure and an
        unexpected one are returned in the shape `classify` reads as an error,
        so they surface as INCONCLUSIVE and never as a denial.
        """
        try:
            if probe.role == "anonymous":
                # Unsigned, and addressed exactly as a signed request would be,
                # or it is not the same probe.
                url = storage.request_url(
                    endpoint=self.host, bucket=probe.bucket, key=probe.object_key, query=probe.query
                )
                status, body = self.transport(url, {}, probe.payload, probe.method)
            else:
                access_key, secret_key = self.credentials[probe.role]
                status, body = storage.signed_request(
                    method=probe.method,
                    endpoint=self.host,
                    region=self.region,
                    access_key=access_key,
                    secret_key=secret_key,
                    bucket=probe.bucket,
                    key=probe.object_key,
                    query=probe.query,
                    payload=probe.payload,
                    content_type=probe.content_type,
                    transport=self.transport,
                )
        except storage.ObjectStorageError as error:
            return None, b"", str(error)
        except Exception as error:  # noqa: BLE001 - see the docstring above
            return None, b"", f"{type(error).__name__}: {error}"
        self.reached_endpoint = True
        return status, body, ""

    def run(self, probe: Probe) -> tuple[str, str]:
        cached = self._outcomes.get(probe.cache_key())
        if cached is not None:
            return cached
        outcome = classify(*self.request(probe))
        self._outcomes[probe.cache_key()] = outcome
        return outcome

    def check(self, check: Check) -> tuple[str, str]:
        if check.expect == "deny" and check.control is not None:
            control_outcome, control_reason = self.run(check.control)
            if control_outcome != "allowed":
                return (
                    INCONCLUSIVE,
                    f"the control probe on the same credential ({check.control.description}) "
                    f"did not succeed ({control_outcome}: {control_reason}), so a denial here "
                    f"is not evidence about the fence",
                )
        outcome, reason = self.run(check.probe)
        if outcome == "error":
            return INCONCLUSIVE, reason
        if check.expect == "allow":
            return (PASS, "") if outcome == "allowed" else (FAIL, "the key that must keep working is denied")
        return (PASS, "") if outcome == "denied" else (FAIL, "the fence did not deny this")


def _endpoint_host(endpoint: str) -> str:
    """The bare host to sign for, from whatever form the operator passed.

    A non-TLS endpoint is refused rather than normalised: every request here
    carries a live credential in an `Authorization` header, and a probe that
    quietly sent one in the clear would be a disclosure caused by the
    verification.
    """
    if "//" not in endpoint:
        return endpoint.strip("/")
    parts = urllib.parse.urlsplit(endpoint)
    if parts.scheme != "https":
        raise VerifierError(
            f"--endpoint must be https; {endpoint!r} would send a signed credential in the clear"
        )
    if not parts.netloc:
        raise VerifierError(f"--endpoint has no host: {endpoint!r}")
    return parts.netloc


def _list_query(extra: dict[str, str] | None = None) -> dict[str, str]:
    query = {"list-type": "2", "max-keys": "1"}
    query.update(extra or {})
    return query


def build_checks(
    *,
    bucket: str,
    foreign_control_bucket: str,
    policy_document: bytes,
    probe_key: str,
    versioning_already_enabled: bool = False,
) -> list[Check]:
    workload_control = Probe(
        "workload",
        f"list {bucket}",
        operation="list-objects-v2",
        method="GET",
        bucket=bucket,
        query=_list_query(),
    )
    foreign_control = Probe(
        "foreign",
        f"list {foreign_control_bucket}",
        operation="list-objects-v2",
        method="GET",
        bucket=foreign_control_bucket,
        query=_list_query(),
    )

    checks = [
        Check(
            "operator can read the policy",
            Probe(
                "operator",
                "get the policy",
                operation="get-bucket-policy",
                method="GET",
                bucket=bucket,
                query={"policy": ""},
            ),
            "allow",
        ),
        Check(
            "THE BUCKET IS STILL ADMINISTRABLE",
            Probe(
                "operator",
                "re-put the identical policy",
                operation="put-bucket-policy",
                method="PUT",
                bucket=bucket,
                query={"policy": ""},
                payload=policy_document,
            ),
            "allow",
            critical=True,
            note="a no-op when it succeeds; a permanent lockout when it does not",
        ),
        Check("workload can list the bucket", workload_control, "allow"),
        Check(
            "workload can write an object",
            Probe(
                "workload",
                "put the probe object",
                operation="put-object",
                method="PUT",
                bucket=bucket,
                key=probe_key,
            ),
            "allow",
        ),
        Check(
            # Not implied by the write. The object Allow and the object Deny
            # are separate statements, and an engine that handles the pair
            # asymmetrically could leave the workload able to write and unable
            # to read -- which on the backup bucket surfaces at the next
            # restore and nowhere earlier, and on a Pulumi state bucket is a
            # checkpoint written and then unreadable.
            "workload can read an object back",
            Probe(
                "workload",
                "read the probe object",
                operation="get-object",
                method="GET",
                bucket=bucket,
                key=probe_key,
            ),
            "allow",
        ),
        Check(
            "foreign key cannot list the bucket",
            Probe(
                "foreign",
                f"list {bucket}",
                operation="list-objects-v2",
                method="GET",
                bucket=bucket,
                query=_list_query(),
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "foreign key cannot read an object",
            Probe(
                "foreign",
                "read the probe object",
                operation="get-object",
                method="GET",
                bucket=bucket,
                key=probe_key,
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "foreign key cannot write an object",
            Probe(
                "foreign",
                "put a foreign object",
                operation="put-object",
                method="PUT",
                bucket=bucket,
                key=f"{PROBE_PREFIX}foreign.txt",
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "workload cannot read the fence",
            Probe(
                "workload",
                "get the policy",
                operation="get-bucket-policy",
                method="GET",
                bucket=bucket,
                query={"policy": ""},
            ),
            "deny",
            control=workload_control,
        ),
        Check(
            "workload cannot rewrite the fence",
            # The identical document, so that an unexpected success changes
            # nothing about the live bucket while still proving the capability.
            Probe(
                "workload",
                "put the identical policy",
                operation="put-bucket-policy",
                method="PUT",
                bucket=bucket,
                query={"policy": ""},
                payload=policy_document,
            ),
            "deny",
            control=workload_control,
        ),
        Check(
            "the bucket is not world-readable",
            Probe(
                "anonymous",
                f"list {bucket} unsigned",
                operation="list-objects-v2",
                method="GET",
                bucket=bucket,
                query=_list_query(),
            ),
            "deny",
            note="no control exists for an anonymous caller: this proves the bucket is not "
            "public, not that the fence narrows anything",
        ),
        Check(
            "workload can delete its own object",
            Probe(
                "workload",
                "delete the probe object",
                operation="delete-object",
                method="DELETE",
                bucket=bucket,
                key=probe_key,
            ),
            "allow",
        ),
    ]

    if versioning_already_enabled:
        # Only safe where the bucket's versioning is ALREADY `Enabled`, which
        # is why it is opt-in rather than always on. A probe whose success
        # changes the bucket is not a probe: on a bucket with versioning off
        # and no lifecycle rule, a successful `Status=Enabled` starts retaining
        # every superseded object indefinitely, which is storage growth caused
        # by the verification rather than found by it.
        checks.insert(
            -1,
            Check(
                "workload cannot touch versioning",
                Probe(
                    "workload",
                    "re-enable versioning",
                    operation="put-bucket-versioning",
                    method="PUT",
                    bucket=bucket,
                    query={"versioning": ""},
                    payload=VERSIONING_ENABLED,
                ),
                "deny",
                control=workload_control,
            ),
        )
    return checks


def read_stored_policy(verifier: Verifier, bucket: str) -> tuple[str, str, bytes]:
    """`(status, reason, body)` for the document the bucket is actually holding.

    A PUT returning 2xx says the endpoint accepted a request, not that the
    document is in force -- this backend is on record accepting a configuration
    and silently dropping part of it. Every verdict drawn from a policy has to
    be able to confirm its own premise, which is what this reads back.
    """
    status, body, failure = verifier.request(_policy_probe("operator", bucket, "GET"))
    outcome, reason = classify(status, body, failure)
    if outcome != "allowed":
        return INCONCLUSIVE, f"could not read the stored policy: {reason or _one_line(failure)}", b""
    return PASS, "", body


def compare_stored_policy(verifier: Verifier, bucket: str, policy_document: bytes) -> tuple[str, str]:
    """Prove the bucket stores the document that was sent.

    This backend is known to accept a configuration and silently drop an
    element of it, and every other check here would still pass on a bucket
    whose stored policy is not the rendered one -- the probes would simply be
    measuring a different fence. Statements are compared as a sorted set, so an
    engine that reorders them is not reported as a mismatch.
    """
    status, reason, body = read_stored_policy(verifier, bucket)
    if status != PASS:
        return status, reason
    return compare_policy_bytes(body, policy_document)


def compare_policy_bytes(stored_body: bytes, policy_document: bytes) -> tuple[str, str]:
    """The comparison itself, over bytes already in hand.

    Separate from the read so a caller holding the stored document -- the engine
    diagnostic prints it as evidence -- compares the bytes it printed rather
    than fetching the policy a second time and reasoning about a third one.
    """
    try:
        stored = json.loads(stored_body.decode("utf-8"))
        sent = json.loads(policy_document.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        return INCONCLUSIVE, f"could not compare the policies: {error}"

    if _normalised(stored) != _normalised(sent):
        return FAIL, "the stored policy is not the document that was sent"
    return PASS, ""


def _normalised(policy: dict) -> tuple:
    statements = policy.get("Statement", [])
    return (
        policy.get("Version"),
        tuple(sorted(json.dumps(statement, sort_keys=True) for statement in statements)),
    )


def parse_object_versions(body: bytes) -> tuple[list[tuple[str, str]], bool, dict[str, str]]:
    """`(key, version id)` for every version and delete marker on one page.

    Also returns whether the listing is truncated and the query parameters that
    resume it. One response is a page, not the bucket: read as the whole
    listing it reports a bucket clean while probe objects remain in it.
    """
    root = ET.fromstring(body)
    entries: list[tuple[str, str]] = []
    truncated = False
    markers: dict[str, str] = {}
    for child in root:
        name = _local_name(child.tag)
        if name in ("Version", "DeleteMarker"):
            fields = {_local_name(g.tag): (g.text or "") for g in child}
            key, version = fields.get("Key"), fields.get("VersionId")
            if key and version:
                entries.append((key, version))
        elif name == "IsTruncated":
            truncated = (child.text or "").strip().lower() == "true"
        elif name == "NextKeyMarker" and (child.text or "").strip():
            markers["key-marker"] = child.text.strip()
        elif name == "NextVersionIdMarker" and (child.text or "").strip():
            markers["version-id-marker"] = child.text.strip()
    return entries, truncated, markers


def cleanup(verifier: Verifier, bucket: str) -> list[str]:
    """Remove every probe object version, as the operator.

    A plain delete on a versioned bucket writes a delete marker and leaves the
    prior version readable at `?versionId=`, so the workload's delete above is
    a check rather than a cleanup.
    """
    problems: list[str] = []
    markers: dict[str, str] = {}
    for _ in range(_MAX_LIST_PAGES):
        query = {"versions": "", "prefix": PROBE_PREFIX}
        query.update(markers)
        listing = Probe(
            "operator",
            "list probe object versions",
            operation="list-object-versions",
            method="GET",
            bucket=bucket,
            query=query,
        )
        status, body, failure = verifier.request(listing)
        outcome, reason = classify(status, body, failure)
        if outcome != "allowed":
            problems.append(f"could not list probe object versions: {reason or _one_line(failure)}")
            return problems
        try:
            entries, truncated, markers = parse_object_versions(body)
        except ET.ParseError as error:
            problems.append(f"could not parse the probe object listing: {error}")
            return problems

        for key, version in entries:
            delete = Probe(
                "operator",
                f"delete {key}",
                operation="delete-object",
                method="DELETE",
                bucket=bucket,
                key=key,
                query={"versionId": version},
            )
            delete_outcome, _ = classify(*verifier.request(delete))
            if delete_outcome != "allowed":
                problems.append(f"probe object {key} version {version} not removed")

        if not truncated:
            return problems
        if not markers:
            # Truncated with nothing to resume from. Returning here would read
            # as "that was everything" to a caller deciding the bucket is
            # clean, which is the opposite of what this function reports on.
            problems.append(
                "the probe object listing is truncated with no marker to resume from, so "
                f"objects under {PROBE_PREFIX} may remain"
            )
            return problems
    problems.append(
        f"the probe object listing did not finish within {_MAX_LIST_PAGES} pages, so objects "
        f"under {PROBE_PREFIX} may remain"
    )
    return problems


def account_of(verifier: Verifier, role: str) -> tuple[str | None, str]:
    """The storage account a credential belongs to, from ListAllMyBuckets.

    Service-level, so no bucket policy governs it, and it works before a fence
    exists as well as after.
    """
    probe = Probe(
        role,
        "resolve the account",
        operation="list-buckets",
        method="GET",
        bucket="",
    )
    status, body, failure = verifier.request(probe)
    outcome, reason = classify(status, body, failure)
    if outcome != "allowed":
        return None, reason or _one_line(failure)
    account = storage.parse_owner_id(body)
    if account is None:
        return None, "no Owner/ID in the ListAllMyBuckets response"
    if account.casefold() == ANONYMOUS_OWNER:
        # This endpoint answers an unsigned `GET /` with 200 and this owner id.
        # Naming it in a policy principal names one that cannot exist, and that
        # is unrecoverable, so the comparison folds case rather than trusting
        # the endpoint to spell it the way it did last time.
        return None, "the endpoint saw this request as unsigned, so it resolved no account"
    return account, ""


def preflight(verifier: Verifier, *, bucket: str, policy_document: bytes) -> list[tuple]:
    """Everything that must hold BEFORE a policy is applied, not after.

    The check that cannot wait until after the PUT is the account id. Every
    principal in a rendered policy is built from one `--project-id` argument,
    so the generator's own recoverability check compares a fabricated ARN
    against itself and passes for any value at all. Live, an ARN carrying the
    right access key under the wrong account names a principal that does not
    exist -- so `NotPrincipal` exempts nobody, the operator loses
    `PutBucketPolicy` along with everyone else, and the bucket is
    unrecoverable. One mistyped digit in the runbook command is enough.

    Resolving the account from each credential itself is the only way to catch
    it, and it has to happen while the policy is still a file on disk.

    Each resolution is a signed request over the transport every probe uses, so
    a workstation that cannot make one finds out here, with nothing written,
    rather than in the middle of a mode that applies a policy.
    """
    rows: list[tuple] = []
    accounts: dict[str, str] = {}
    for role in ("operator", "workload", "foreign"):
        account, reason = account_of(verifier, role)
        if account is None:
            rows.append((f"{role} credential resolves its account", INCONCLUSIVE, reason, "", True))
            continue
        accounts[role] = account
        rows.append((f"{role} credential resolves its account", PASS, "", account, False))

    rows.insert(
        0,
        ("the signed transport reaches the endpoint", PASS, "", "", False)
        if verifier.reached_endpoint
        else (
            "the signed transport reaches the endpoint",
            INCONCLUSIVE,
            "no request reached the endpoint at all, so nothing below says anything about "
            "the credentials or the policy. Nothing has been written.",
            "",
            True,
        ),
    )

    if len(accounts) == 3 and len(set(accounts.values())) != 1:
        rows.append(
            (
                "all three credentials are in one account",
                FAIL,
                f"accounts differ ({accounts}); a foreign key outside this account is denied "
                f"by the account boundary, so its denials would say nothing about the fence",
                "",
                True,
            )
        )
    elif len(accounts) == 3:
        rows.append(("all three credentials are in one account", PASS, "", "", False))

    if "operator" not in accounts:
        return rows

    account = accounts["operator"]
    operator_arn = f"arn:aws:iam:::user/{account}:{verifier.credentials['operator'][0]}"
    workload_arn = f"arn:aws:iam:::user/{account}:{verifier.credentials['workload'][0]}"
    try:
        policy = json.loads(policy_document.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        rows.append(("the policy file is readable", INCONCLUSIVE, str(error), "", True))
        return rows

    bucket_arn = f"arn:aws:s3:::{bucket}"
    try:
        operator_denied = _denied_actions(policy, operator_arn, bucket_arn, RECOVERY_ACTIONS, [])
        workload_denied = _denied_actions(
            policy, workload_arn, bucket_arn, WORKLOAD_BUCKET_ACTIONS, WORKLOAD_OBJECT_ACTIONS
        )
    except (KeyError, TypeError, AttributeError) as error:
        # `--policy-file` takes any file. A document `decide` cannot walk is one
        # nothing here can reason about, which is not the same as a safe one.
        rows.append(
            (
                "the policy can be evaluated",
                INCONCLUSIVE,
                f"this document is not a policy this tool can evaluate ({error!r}), so "
                f"whether it locks a credential out is unknown",
                "",
                True,
            )
        )
        return rows

    rows.append(
        (
            "the policy leaves THIS operator credential able to replace it",
            PASS if not operator_denied else FAIL,
            ""
            if not operator_denied
            else f"this policy denies {operator_arn} {', '.join(operator_denied)}. Applying it "
            f"would lock the bucket permanently -- most likely the --project-id it was "
            f"rendered with is not {account}.",
            operator_arn,
            True,
        )
    )
    rows.append(
        (
            "the policy leaves THIS workload credential able to use the bucket",
            PASS if not workload_denied else FAIL,
            ""
            if not workload_denied
            else f"this policy denies {workload_arn} {', '.join(workload_denied)}. Applying it "
            f"would break that key's own work -- on the backup bucket, silently until the "
            f"next restore; on the state bucket, at the next tenant deploy.",
            workload_arn,
            False,
        )
    )
    return rows


def _denied_actions(
    policy: dict,
    principal: str,
    bucket_arn: str,
    bucket_actions: list[str],
    object_actions: list[str],
) -> list[str]:
    """Which of the actions this credential needs the policy takes away.

    WHETHER A CREDENTIAL IS LOCKED OUT IS AN EVALUATION QUESTION. `decide` is
    the repository's model of S3 evaluation and the renderer's own
    `assert_recoverable` already asks it this way; asking it here as well is
    two independent checks of one invariant, which is the intent.

    Reading `NotPrincipal` lists structurally cannot answer it. A working fence
    contains Deny statements that name only the operator -- the version-
    destroying actions are withheld from the workload on purpose -- so "this
    Deny does not name the workload" describes the fence doing its job.

    Object actions are asked at the object space the fence governs, not at a
    concrete key. A key would give a different answer for a statement scoped to
    a narrower prefix -- `--probe-notprincipal` applies exactly such a policy,
    denying reads under the probe prefix to everyone but the operator -- and
    reporting the workload locked out because of it would be false.

    This is still a model. `decide` is not Hetzner's engine, a Deny scoped to
    some other prefix is not visible at this resource, and the live probes are
    what turn any of it into evidence.
    """
    denied = []
    for action in bucket_actions:
        if decide(policy, principal, action, bucket_arn) != "allow":
            denied.append(action)
    for action in object_actions:
        if decide(policy, principal, action, f"{bucket_arn}/*") != "allow":
            denied.append(action)
    return denied


def probe_policy_id(bucket: str) -> str:
    return f"notprincipal-probe-{bucket}"


def probe_policy(bucket: str, operator_arn: str) -> dict:
    """A policy that answers the `NotPrincipal` question and cannot lock anything.

    Two properties carry the whole design, and `assert_probe_policy_is_reversible`
    below enforces both before it is sent:

      1. No statement names the BUCKET resource. `PutBucketPolicy` and
         `DeleteBucketPolicy` are bucket-resource actions, so no key loses the
         ability to replace or remove this document -- including the key that
         would remove it if the engine turns out to treat `NotPrincipal` as
         naming everybody. That is what makes asking the question safe.
      2. The `Deny` is confined to an object prefix nothing else writes, so a
         misread in either direction touches no real object.
    """
    return {
        "Version": "2012-10-17",
        "Id": probe_policy_id(bucket),
        "Statement": [
            {
                "Sid": "ProbeNotPrincipal",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [operator_arn]},
                "Action": "s3:GetObject",
                "Resource": f"arn:aws:s3:::{bucket}/{PROBE_PREFIX}*",
            }
        ],
    }


def assert_probe_policy_is_reversible(policy: dict, bucket: str) -> None:
    """Refuse to send a probe that could take `PutBucketPolicy` away.

    The probe exists because the engine's principal semantics are unknown. It
    would be self-defeating to establish that with a document that becomes
    unremovable under the very reading it is testing for, so the check assumes
    the worst case -- the statement matches every principal -- and requires that
    even then, nothing on the bucket resource is denied.

    The action check is the second half of that. `PROBE_ACTIONS` holds one entry
    because a Deny on any other object action could refuse the delete that
    removes the probe object: a run whose policy removal also failed would then
    have left an object under a Deny with nothing able to lift it.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    for statement in policy.get("Statement", []):
        # THE RESOURCE CHECK RUNS FIRST, and the order is load-bearing. Naming
        # the bucket resource is the unrecoverable case, so a document that does
        # both must be refused with the message that says so; the action rule is
        # the narrower one and would otherwise mask it.
        resource = statement.get("Resource", [])
        resources = [resource] if isinstance(resource, str) else list(resource)
        if not resources:
            raise VerifierError("probe policy statement names no Resource")
        for entry in resources:
            if entry == bucket_arn:
                raise VerifierError(
                    "probe policy names the bucket resource, so it could deny "
                    "PutBucketPolicy and become unremovable -- which is the outcome it "
                    "exists to test for"
                )
            if not entry.startswith(f"{bucket_arn}/{PROBE_PREFIX}"):
                raise VerifierError(
                    f"probe policy reaches {entry!r}, outside the probe prefix"
                )

        action = statement.get("Action", [])
        actions = [action] if isinstance(action, str) else list(action)
        if not actions:
            raise VerifierError("probe policy statement names no Action")
        for entry in actions:
            if entry not in PROBE_ACTIONS:
                raise VerifierError(
                    f"probe policy denies {entry!r}, which is not one of "
                    f"{sorted(PROBE_ACTIONS)} -- a Deny on any other object action could "
                    f"refuse the delete that removes the probe object"
                )


def stored_policy_id(body: bytes) -> str | None:
    """The `Id` of a policy document, or None if there is not one to read."""
    try:
        stored = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return stored.get("Id") if isinstance(stored, dict) else None


def _policy_slot_is_free(
    verifier: Verifier, bucket: str, *, replace_existing: bool, own_ids: tuple
) -> tuple[bool, tuple | None, bool]:
    """Whether a probe may write this bucket's policy slot, or the row refusing.

    THE ONLY ANSWER THAT LETS A PROBE PROCEED IS AN AFFIRMATIVE "THERE IS NO
    POLICY". A probe replaces whatever is on the bucket and removes it at the
    end, so a bucket whose policy could not be READ must not be written to: a
    transient 503, a reset connection, a truncated body and `AccessDenied` are
    one outcome here, and treating "unknown" as "empty" destroys a fence on the
    strength of a failed request.

    The third value says a leftover probe policy of this file's own is sitting
    there. It matters to a caller that measures the bucket before writing:
    reading a "with no policy in force" baseline while a leftover Deny is still
    on the bucket measures the leftover.
    """
    status, body, failure = verifier.request(_policy_probe("operator", bucket, "GET"))
    outcome, reason = classify(status, body, failure)
    if outcome == "allowed":
        stored_id = stored_policy_id(body)
        if stored_id in own_ids and replace_existing:
            return True, None, True
        return False, _existing_policy_refusal(bucket, stored_id, replace_existing, own_ids), False
    if s3_error_code(body) == "NoSuchBucketPolicy":
        return True, None, False
    return False, (
        "the bucket's current policy is known",
        INCONCLUSIVE,
        f"could not read whether {bucket} carries a policy ({reason}). This step replaces "
        f"whatever is there and removes it afterwards, so it will not run without an "
        f"affirmative NoSuchBucketPolicy -- an unreadable answer is not an empty bucket. "
        f"Nothing has been written. Re-run once the endpoint answers, and if it keeps "
        f"refusing, that refusal is itself the finding.",
        "",
        True,
    ), False


def _existing_policy_refusal(
    bucket: str, stored_id: str | None, replace_existing: bool, own_ids: tuple
) -> tuple:
    """The row that stops `--probe-notprincipal` on a bucket that has a policy.

    NOTHING HERE RESTORES A DISPLACED DOCUMENT. The probe is applied and then
    deleted, so a policy it replaced is gone -- there is no undo, and on a
    fenced bucket that means the fence is off from that moment on. So
    `--replace-existing-policy` permits exactly one thing: replacing a probe
    policy this file wrote itself, which constrains nothing and is what an
    interrupted run leaves behind. Any other document is refused whether or not
    the flag was passed, because the flag cannot make its removal reversible.

    Which policy it is therefore decides the whole answer, and the document is
    already in hand, so the message says which case this is rather than leaving
    the operator to weigh both.
    """
    if stored_id in own_ids:
        return (
            "the bucket carries no policy to displace",
            INCONCLUSIVE,
            f"a previous --probe-notprincipal run left its own probe policy on {bucket} "
            f"(Id {stored_id}). It denies reads under {PROBE_PREFIX} to every key but the "
            f"operator and constrains nothing else, so replacing it costs nothing: re-run "
            f"this exact command with --replace-existing-policy added, and it is removed at "
            f"the end of the run.",
            "",
            True,
        )
    named = f" (Id {stored_id})" if stored_id else ""
    flagged = (
        " --replace-existing-policy does not cover this: it permits replacing a leftover "
        "probe policy and nothing else, because nothing here can put a displaced document "
        "back."
        if replace_existing
        else ""
    )
    return (
        "the bucket carries no policy to displace",
        INCONCLUSIVE,
        f"{bucket} already carries a policy{named} that this run did not write. Applying the "
        f"probe would replace it, and removing the probe afterwards would leave the bucket "
        f"with no policy at all -- if that document is a fence, the bucket is then unfenced "
        f"and stays that way.{flagged} The engine question this step answers is a property "
        f"of the account, so a bucket that is already fenced does not need it. If you "
        f"genuinely mean to run it here, remove that policy by hand first and keep a copy.",
        "",
        True,
    )


def probe_notprincipal(verifier: Verifier, *, bucket: str, replace_existing: bool) -> list[tuple]:
    """Ask the live engine whether `NotPrincipal` exempts, reversibly.

    Ordering is the whole safety argument: the object is written before the
    probe policy exists, the probe policy is removed before this returns
    whatever the answer was, and the probe policy can never deny the removal.
    """
    rows: list[tuple] = []
    account, reason = account_of(verifier, "operator")
    if account is None:
        return [("operator credential resolves its account", INCONCLUSIVE, reason, "", True)]
    operator_arn = f"arn:aws:iam:::user/{account}:{verifier.credentials['operator'][0]}"

    free, refusal, _ = _policy_slot_is_free(
        verifier, bucket, replace_existing=replace_existing, own_ids=(probe_policy_id(bucket),)
    )
    if not free:
        return [refusal]

    policy = probe_policy(bucket, operator_arn)
    assert_probe_policy_is_reversible(policy, bucket)
    probe_key = f"{PROBE_PREFIX}notprincipal-{uuid.uuid4().hex}.txt"

    write = Probe(
        "operator",
        "write the probe object",
        operation="put-object",
        method="PUT",
        bucket=bucket,
        key=probe_key,
    )
    outcome, reason = classify(*verifier.request(write))
    if outcome != "allowed":
        return [("the probe object is written", INCONCLUSIVE, reason, "", True)]

    with _temporary_policy(verifier, bucket, policy, rows) as probe:
        if probe.applied:
            # Both reads happen inside the block, so the probe policy is
            # removed whatever either of them does.
            operator_outcome, operator_reason = verifier.run(_read(bucket, "operator", probe_key))
            foreign_outcome, foreign_reason = verifier.run(_read(bucket, "foreign", probe_key))
        else:
            # Whatever these reads returned would be the bucket answering about
            # some other policy, or about none. Reporting PASS from them would
            # be an engine verdict drawn from a document the engine never saw.
            operator_outcome = foreign_outcome = "error"
            operator_reason = foreign_reason = (
                "the probe policy was not applied, so a read here says nothing about how "
                "this engine evaluates NotPrincipal"
            )

    # THE ROW THAT WAS MISREAD ONCE, AND THE READING THAT MADE IT POSSIBLE.
    # The operator's read succeeding is not evidence that the exemption works:
    # a statement the engine ignores entirely produces exactly that observation.
    # Only the PAIR of reads separates the two, so the pair decides this row.
    # An operator allowed alongside a foreign key that was also allowed is
    # INCONCLUSIVE here, and never a pass.
    exempts = (
        FAIL
        if operator_outcome == "denied"
        else PASS
        if operator_outcome == "allowed" and foreign_outcome == "denied"
        else INCONCLUSIVE
    )
    rows.append(
        (
            "NotPrincipal EXEMPTS the named key on this engine",
            exempts,
            ""
            if exempts == PASS
            else "the operator was denied by a statement that names it in NotPrincipal. This "
            "engine does not read NotPrincipal as an exemption, and the real fence WOULD "
            "HAVE LOCKED THE BUCKET. Do not apply it."
            if operator_outcome == "denied"
            else "the operator's read succeeded and so did a read by a key this statement "
            "should have denied, so the statement reached nobody. An exemption and an "
            "ignored statement are the same observation from the operator's side alone. "
            "Which one this is decides whether any fence is possible here: run "
            "--diagnose-policy-engine."
            if operator_outcome == "allowed"
            else operator_reason,
            "",
            True,
        )
    )
    rows.append(
        (
            "NotPrincipal DENIES everyone else on this engine",
            PASS if foreign_outcome == "denied" else FAIL if foreign_outcome == "allowed" else INCONCLUSIVE,
            ""
            if foreign_outcome == "denied"
            else "a key not named in NotPrincipal was still allowed, so this statement "
            "denied nobody and a fence built from it would fence nothing. Run "
            "--diagnose-policy-engine before concluding anything further: whether that is "
            "NotPrincipal alone or every principal-based policy on this account is the "
            "difference between a rebuildable fence and none"
            if foreign_outcome == "allowed"
            else foreign_reason,
            "",
            False,
        )
    )
    rows.extend(("probe object removed: " + problem, FAIL, "", "", False) for problem in cleanup(verifier, bucket))
    return rows


def _read(bucket: str, role: str, key: str) -> Probe:
    return Probe(
        role,
        "read the probe object",
        operation="get-object",
        method="GET",
        bucket=bucket,
        key=key,
    )


def _policy_probe(role: str, bucket: str, method: str, payload: bytes = b"") -> Probe:
    return Probe(
        role,
        {"GET": "get the policy", "PUT": "put the policy", "DELETE": "delete the policy"}[method],
        operation={
            "GET": "get-bucket-policy",
            "PUT": "put-bucket-policy",
            "DELETE": "delete-bucket-policy",
        }[method],
        method=method,
        bucket=bucket,
        query={"policy": ""},
        payload=payload,
    )


class _temporary_policy:
    """Applies a policy, and removes it again whatever happens in between.

    `applied` says whether the PUT succeeded, and the removal is conditional on
    it. `DeleteBucketPolicy` removes whatever document is on the bucket, not
    the one this block meant to put there -- so deleting after a refused PUT
    would remove a policy this run never displaced, and on a fenced bucket that
    is the fence. The engine rejecting a `NotPrincipal` document outright is an
    anticipated outcome, not an exotic one: it is case 4 in
    `RUNBOOK-bucket-fencing.md`'s own list of ways this engine can differ from
    its documentation.
    """

    def __init__(
        self, verifier: Verifier, bucket: str, policy: dict, rows: list[tuple], label: str = ""
    ):
        self.verifier = verifier
        self.bucket = bucket
        self.document = json.dumps(policy).encode("utf-8")
        self.rows = rows
        self.label = label
        self.applied = False
        # Whether the bucket is back to carrying no policy. A run that could not
        # take its own document off must not put another one on top of it: the
        # next window would then be measuring a bucket whose state nobody knows.
        self.removed = False

    def __enter__(self):
        status, body, failure = self.verifier.request(
            _policy_probe("operator", self.bucket, "PUT", self.document)
        )
        outcome, reason = classify(status, body, failure)
        self.applied = outcome == "allowed"
        if self.applied:
            return self
        if status is None:
            # The request did not complete, so whether it reached the engine
            # is unknown -- the policy may be on the bucket. Removing it would
            # be a DELETE on a bucket whose state this run cannot establish,
            # which is how a fence gets removed by a probe that never applied
            # one; leaving it is the safer half of a genuine dilemma, and the
            # operator has to be told which way it went.
            self.rows.append(
                (
                    "THE PROBE POLICY'S FATE IS UNKNOWN" + self.label,
                    INCONCLUSIVE,
                    f"the PUT of the probe policy got no response ({reason}), so it may or "
                    f"may not be on {self.bucket}. Nothing was deleted, because a DELETE "
                    f"here removes whatever is on the bucket rather than only this probe. "
                    f"Check by hand before doing anything else: aws --endpoint-url "
                    f"https://{self.verifier.host} s3api get-bucket-policy --bucket "
                    f"{self.bucket}. A policy with Id {probe_policy_id(self.bucket)} is this "
                    f"probe and is safe to delete.",
                    "",
                    True,
                )
            )
            return self
        self.rows.append(
            (
                "the probe policy is accepted" + self.label,
                INCONCLUSIVE,
                f"this engine rejected the probe document outright: {reason}",
                "",
                True,
            )
        )
        return self

    def __exit__(self, *exc):
        if not self.applied:
            return False
        outcome, reason = classify(
            *self.verifier.request(_policy_probe("operator", self.bucket, "DELETE"))
        )
        self.removed = outcome == "allowed"
        if outcome != "allowed":
            self.rows.append(
                (
                    "THE PROBE POLICY IS REMOVED" + self.label,
                    FAIL,
                    f"the probe policy is still on {self.bucket} and denies reads under "
                    f"{PROBE_PREFIX} to every key but the operator ({reason}). Re-run this "
                    f"command with --replace-existing-policy: it replaces the leftover probe "
                    f"and removes the replacement, and needs nothing but python3. Failing "
                    f"that, delete it directly with aws --endpoint-url "
                    f"https://{self.verifier.host} s3api delete-bucket-policy --bucket "
                    f"{self.bucket} -- which prints a client-internal error rather than the "
                    f"S3 one if it is refused in turn, so read its exit code, not its text",
                    "",
                    True,
                )
            )
        return False


# --------------------------------------------------------------------------
# WHICH WORLD ARE WE IN: what a bucket policy on this engine actually does.
#
# A live run applied a policy whose single statement was a `Deny s3:GetObject`
# under the probe prefix, exempting the operator by `NotPrincipal`. The endpoint
# accepted it. The operator then read the object -- and so did a key the
# statement should have denied. The `Deny` reached nobody.
#
# THAT ONE OBSERVATION HAS AT LEAST THREE EXPLANATIONS WITH OPPOSITE
# CONSEQUENCES, so on its own it settles nothing:
#
#   1. This engine stores bucket policies and enforces none of them.
#   2. It enforces them, but every credential in a project is one principal --
#      so a `NotPrincipal` naming any key exempts all of them, and no policy can
#      ever separate two credentials inside a project.
#   3. It enforces them and resolves principals per key, and `NotPrincipal`
#      alone is unimplemented -- in which case a fence is rebuildable out of
#      explicit `Principal` denials.
#
# Under (3) the estate keeps a fence. Under (1) and (2) it has none, and the
# only isolation boundary left is a separate Hetzner project.
#
# A PROBE THAT ONLY ONE WORLD EXPLAINS IS THE ONLY KIND WORTH RUNNING HERE.
# That is the property the earlier probe lacked, and the reason its `PASS` was
# read as an answer when it was not one. Four things give it to these:
#
#   - EVERY WINDOW HAS A BASELINE. Each probe object is read by both keys with
#     NO policy on the bucket first. Without that, a denial later could be the
#     key, the object, the endpoint or the policy, and this file's whole
#     doctrine is that those must not be one verdict.
#   - EVERY WINDOW CONFIRMS ITS OWN PREMISE. The stored document is read back
#     while the policy is live and compared to what was sent. A 2xx on the PUT
#     is not evidence a document is in force, and reads taken against a policy
#     that was never stored measure nothing.
#   - THE SUBJECT IS THE SAME KEY IN EVERY WINDOW. The foreign key is read in
#     all three; what changes between windows is only whether the statement
#     names it, names the other key, or names everyone. The operator's reads are
#     kept as corroboration, never as the deciding evidence -- an engine that
#     exempts the bucket owner would otherwise answer every window the same way
#     from the operator's side and hide the entire question.
#   - THE VERDICT IS DRAWN FROM A PAIR, NOT A ROW. A single read is consistent
#     with several worlds; it is the combination across windows that has one
#     reading.
#
# Window A -- `Principal: "*"`. Is anything enforced at all? If the foreign key
#   still reads the object with a Deny naming everyone stored verbatim on the
#   bucket, no bucket policy constrains anything here and nothing below can
#   mean anything. The run stops.
# Window B -- `Principal: [foreign key]`. Does a Deny naming a key deny THAT key?
# Window C -- `Principal: [operator key]`. Does a Deny naming a key deny the
#   OTHER key? B and C are the same experiment with the name swapped, and their
#   two foreign reads are the whole answer:
#
#       B denied, C allowed -> the name resolves, per key.
#       B denied, C denied  -> the name is decoration; a Deny reaches every key.
#       B allowed, C allowed -> a named key matches nobody; only `*` matches.
#       B allowed, C denied -> the engine matches the complement of the name.
#
# Every probe policy here carries the same safety property as the earlier one
# and goes through the same assertion: one `Deny`, `s3:GetObject` only, confined
# to the probe prefix, and NO statement on the bucket resource -- so
# `PutBucketPolicy` and `DeleteBucketPolicy` stay available to every key
# throughout and no window can lock a bucket. Window A denies the operator by
# construction, and that is exactly why it may not name a bucket-resource
# action: the key that has to remove it is one of the keys it denies.
# --------------------------------------------------------------------------

WINDOW_A = "A"
WINDOW_B = "B"
WINDOW_C = "C"

# Verdicts about whether a policy reaches anybody, from window A.
ENFORCED = "enforced"
ENFORCED_OWNER_EXEMPT = "enforced-owner-exempt"
NOT_ENFORCED = "not-enforced"

# Verdicts about how a named principal matches, from windows B and C.
RESOLVES_PER_KEY = "resolves-per-key"
NAME_IS_DECORATION = "name-is-decoration"
NAME_MATCHES_NOBODY = "name-matches-nobody"
NAME_IS_INVERTED = "name-is-inverted"

UNEXPLAINED = "unexplained"

# What each verdict means, and what it leaves the estate able to do. Written out
# in full because this is the one line an operator reads once, under pressure,
# and acts on -- and because three of these five say the fence in this
# repository protects nothing, which is not a sentence to leave implied.
FENCE_IS_POSSIBLE = {
    RESOLVES_PER_KEY: True,
    NAME_IS_DECORATION: False,
    NAME_MATCHES_NOBODY: False,
    NAME_IS_INVERTED: False,
    NOT_ENFORCED: False,
    UNEXPLAINED: False,
}

VERDICT_TEXT = {
    RESOLVES_PER_KEY: (
        "PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE.\n"
        "A Deny naming one access key denied that key and left the other one able to read,\n"
        "so an explicit `Principal` separates two credentials inside this project.\n\n"
        "A fence is rebuildable -- but NOT the fence this repository renders. That one\n"
        "fences by `NotPrincipal`, which was observed live denying nobody, and this run\n"
        "says nothing to rehabilitate it: it never sent a `NotPrincipal` document. Until\n"
        "the fence is rebuilt out of explicit `Principal` Deny statements, treat every\n"
        "bucket it was applied to as unfenced, and do not apply it anywhere else.\n"
        "Record this output on the issue."
    ),
    NAME_IS_DECORATION: (
        "THE PRINCIPAL ELEMENT IS DECORATION ON THIS ENGINE.\n"
        "A Deny naming one access key denied the key it named AND the key it did not.\n"
        "The statement applies to every caller whatever principal it carries.\n\n"
        "Bucket policies cannot fence one credential from another here: a Deny aimed at a\n"
        "stranger takes the workload down with it. Applying a fence would be an outage,\n"
        "not a control. Do not apply one. The remaining isolation boundary is a separate\n"
        "Hetzner project. Record this output on the issue."
    ),
    NAME_MATCHES_NOBODY: (
        "A NAMED PRINCIPAL MATCHES NOBODY ON THIS ENGINE.\n"
        "A Deny naming `*` denied the foreign key, so policies ARE enforced -- but a Deny\n"
        "naming that same key by ARN denied nothing, in either direction.\n\n"
        "Every credential in this project is one principal as far as this engine is\n"
        "concerned, so no bucket policy can separate two credentials inside a project. The\n"
        "fence in this repository protects nothing, and neither does the tenant media\n"
        "policy. Do not apply either. The remaining isolation boundary is a separate\n"
        "Hetzner project, which is an architecture decision, not a fix to make here.\n"
        "Record this output on the issue."
    ),
    NAME_IS_INVERTED: (
        "THIS ENGINE MATCHES THE COMPLEMENT OF THE PRINCIPAL IT IS GIVEN.\n"
        "A Deny naming a key left THAT key able to read and denied the key it did not name.\n\n"
        "This is not a documented S3 behaviour and nothing here should be built on it.\n"
        "Do not apply any policy to any bucket. Record this output verbatim on the issue:\n"
        "a fence written against this reading would invert the moment the engine is fixed."
    ),
    NOT_ENFORCED: (
        "BUCKET POLICIES ARE NOT ENFORCED ON THIS ACCOUNT.\n"
        "A Deny naming `Principal: \"*\"` was stored on the bucket, verbatim, and the read\n"
        "it denies succeeded anyway.\n\n"
        "No bucket policy constrains anything here, so the fence in this repository and the\n"
        "tenant media policy both protect nothing. Do not apply either, and do not read a\n"
        "successful PUT as a control ever again. The remaining isolation boundary is a\n"
        "separate Hetzner project. Record this output on the issue."
    ),
    UNEXPLAINED: (
        "NO SINGLE READING EXPLAINS WHAT THIS ENGINE DID.\n"
        "The observations below do not fit any of the behaviours this diagnostic can name,\n"
        "so it is not naming one.\n\n"
        "Nothing has been left on the bucket. Do not apply any fence. Record the RAW\n"
        "EVIDENCE block above verbatim on the issue -- an engine answering incoherently is\n"
        "itself the finding, and guessing at which world it is is exactly the mistake this\n"
        "diagnostic exists to stop."
    ),
}


class Observation:
    """One read, kept with the wire facts the verdict was drawn from.

    An engine question settled by a single live run has to be re-readable later
    by someone who was not in the terminal, so the evidence is printed rather
    than only the conclusion -- and the conclusion below is a reading OF this,
    which is the distinction the withdrawn `NotPrincipal` result lost.
    """

    def __init__(self, window: str, role: str, status, code, outcome: str, reason: str):
        self.window = window
        self.role = role
        self.status = status
        self.code = code
        self.outcome = outcome
        self.reason = reason

    def line(self) -> str:
        status = "---" if self.status is None else str(self.status)
        line = (
            f"  {self.window:<10} read as {self.role:<8}  HTTP {status:<4} "
            f"code {self.code or '-':<22} {self.outcome}"
        )
        return line + (f"  -- {_one_line(self.reason, 120)}" if self.reason else "")


def _observe(verifier: Verifier, bucket: str, window: str, role: str, key: str) -> Observation:
    """One signed read of one probe object, as one role.

    Sent through `request` rather than `run` deliberately: `run` caches by
    probe, and the same read under three different policies is three different
    facts. A cached answer here would report a later window's verdict from an
    earlier window's policy.
    """
    status, body, failure = verifier.request(_read(bucket, role, key))
    outcome, reason = classify(status, body, failure)
    return Observation(window, role, status, s3_error_code(body), outcome, reason)


def diagnostic_policy_id(bucket: str) -> str:
    return f"engine-diagnostic-probe-{bucket}"


def diagnostic_policy(bucket: str, sid: str, principal) -> dict:
    """One `Deny s3:GetObject` under the probe prefix, aimed at `principal`.

    `principal` is the only thing that differs between windows, which is what
    makes the comparison between them mean something.
    """
    return {
        "Version": "2012-10-17",
        "Id": diagnostic_policy_id(bucket),
        "Statement": [
            {
                "Sid": sid,
                "Effect": "Deny",
                "Principal": principal,
                "Action": "s3:GetObject",
                "Resource": f"arn:aws:s3:::{bucket}/{PROBE_PREFIX}*",
            }
        ],
    }


def _diagnostic_plan(
    operator_arn: str = "<the operator key's ARN>", foreign_arn: str = "<the foreign key's ARN>"
) -> tuple:
    """The three windows, in the order they run.

    One definition, so the plan `--dry-run` prints is the plan the run sends.
    The defaults are placeholders for that dry run, which reads no credential.
    """
    return (
        (WINDOW_A, "ProbeDenyEveryPrincipal", {"AWS": "*"}),
        (WINDOW_B, "ProbeDenyTheForeignKey", {"AWS": [foreign_arn]}),
        (WINDOW_C, "ProbeDenyTheOperatorKey", {"AWS": [operator_arn]}),
    )


def enforcement_verdict(foreign: str, operator: str) -> str:
    """What window A's two reads say about whether a policy reaches anybody.

    THE FOREIGN READ DECIDES IT, not the operator's. An engine that exempts the
    bucket owner from its own bucket policies would answer the operator
    `allowed` in every window -- and gating on that read alone would call such
    an engine "not enforced" and stop, throwing away the answer. The operator's
    read is kept because whether the owner is exempt is a real finding of its
    own, but it is never the gate.
    """
    if foreign not in ("allowed", "denied") or operator not in ("allowed", "denied"):
        return UNEXPLAINED
    if foreign == "allowed":
        # A Deny naming everyone that denied the operator and not the foreign
        # key is not a behaviour any reading here covers.
        return UNEXPLAINED if operator == "denied" else NOT_ENFORCED
    return ENFORCED if operator == "denied" else ENFORCED_OWNER_EXEMPT


def principal_verdict(named: str, unnamed: str) -> str:
    """How this engine matches a named principal, from the foreign key's two reads.

    `named` is the foreign key's read in window B, where the statement names it.
    `unnamed` is its read in window C, where the statement names the operator
    instead. One key, one object, one action, one difference between the two
    documents -- so the pair has one reading and a single row would have four.
    """
    if named not in ("allowed", "denied") or unnamed not in ("allowed", "denied"):
        return UNEXPLAINED
    if named == "denied":
        return RESOLVES_PER_KEY if unnamed == "allowed" else NAME_IS_DECORATION
    return NAME_MATCHES_NOBODY if unnamed == "allowed" else NAME_IS_INVERTED


def _masked(text: str, masks: dict[str, str]) -> str:
    for value, label in masks.items():
        text = text.replace(value, label)
    return text


def _key_label(role: str, access_key: str) -> str:
    """A principal an operator can recognise without it being an identifier.

    The evidence block exists to be pasted into the issue that asked the
    question, and this repository is public. The last four characters are enough
    to tell the two keys apart and to check either against the Console; the
    whole id is not something to publish for that.
    """
    return f"<{role} key ...{access_key[-4:]}>"


def _window(
    verifier: Verifier,
    bucket: str,
    *,
    window: str,
    policy: dict,
    probe_key: str,
    rows: list[tuple],
    evidence: list[str],
    masks: dict[str, str],
) -> dict[str, Observation]:
    """Apply one probe policy, read the object as both keys, remove it again.

    Returns the observations, or an empty mapping when the window produced no
    interpretable evidence. That covers three cases and they are one answer
    here: the PUT was refused, what came back off the bucket is not what was
    sent, or the document could not be taken off again. Reads under the first
    two would be the bucket answering about some other document; after the third
    the bucket still carries a policy, so a later window would be measuring a
    state nobody established. Each has already been reported as its own row by
    the time this returns.
    """
    assert_probe_policy_is_reversible(policy, bucket)
    observations: dict[str, Observation] = {}
    label = f" (probe {window})"
    evidence.append(
        f"WINDOW {window} -- sent:   {_masked(json.dumps(policy, sort_keys=True), masks)}"
    )

    with _temporary_policy(verifier, bucket, policy, rows, label) as applied:
        if applied.applied:
            status, reason, body = read_stored_policy(verifier, bucket)
            if status == PASS:
                evidence.append(
                    f"WINDOW {window} -- stored: "
                    + _masked(_one_line(_decoded(body), 1200), masks)
                )
                status, reason = compare_policy_bytes(body, applied.document)
            rows.append(
                (
                    f"probe {window}: the bucket stores the document that was sent",
                    status,
                    reason,
                    "a 2xx on the PUT is not evidence the document is in force",
                    status != PASS,
                )
            )
            if status == PASS:
                for role in ("foreign", "operator"):
                    observation = _observe(verifier, bucket, f"window {window}", role, probe_key)
                    evidence.append(observation.line())
                    observations[role] = observation
    return observations if applied.removed else {}


def _cleanup_rows(verifier: Verifier, bucket: str) -> list[tuple]:
    return [
        ("probe object removed: " + problem, FAIL, "", "", False)
        for problem in cleanup(verifier, bucket)
    ]


def diagnose_policy_engine(
    verifier: Verifier, *, bucket: str, replace_existing: bool
) -> tuple[list[tuple], list[str], str]:
    """Settle what a bucket policy does on this engine. Returns rows, evidence, verdict.

    Three reversible windows in one process, in an order chosen so that every
    row below the first is interpretable: window A establishes that a policy
    reaches anybody at all, and B and C then ask what a NAME in one changes.
    Run the other way round, B's `allowed` would be unreadable -- a principal
    that did not match, or an engine that enforces nothing -- and it is exactly
    that kind of one-sided observation that was recorded as an answer before.
    """
    rows: list[tuple] = []
    evidence: list[str] = []

    accounts = {}
    for role in ("operator", "foreign"):
        account, reason = account_of(verifier, role)
        if account is None:
            rows.append((f"{role} credential resolves its account", INCONCLUSIVE, reason, "", True))
            return rows, evidence, VERDICT_TEXT[UNEXPLAINED]
        accounts[role] = account
    if accounts["operator"] != accounts["foreign"]:
        rows.append(
            (
                "both credentials are in one account",
                FAIL,
                f"the operator is in {accounts['operator']} and the foreign key in "
                f"{accounts['foreign']}. A key outside this account is denied by the project "
                f"boundary, so every denial below would be that boundary and not the policy "
                f"-- which is the exact substitution this whole file exists to prevent. "
                f"Nothing has been written.",
                "",
                True,
            )
        )
        return rows, evidence, VERDICT_TEXT[UNEXPLAINED]
    rows.append(("both credentials are in one account", PASS, "", accounts["operator"], False))

    account = accounts["operator"]
    operator_key = verifier.credentials["operator"][0]
    foreign_key = verifier.credentials["foreign"][0]
    operator_arn = f"arn:aws:iam:::user/{account}:{operator_key}"
    foreign_arn = f"arn:aws:iam:::user/{account}:{foreign_key}"
    masks = {
        operator_arn: f"arn:aws:iam:::user/{account}:{_key_label('operator', operator_key)}",
        foreign_arn: f"arn:aws:iam:::user/{account}:{_key_label('foreign', foreign_key)}",
    }

    free, refusal, leftover = _policy_slot_is_free(
        verifier, bucket, replace_existing=replace_existing, own_ids=(diagnostic_policy_id(bucket),)
    )
    if not free:
        rows.append(refusal)
        return rows, evidence, VERDICT_TEXT[UNEXPLAINED]
    if leftover:
        # A leftover probe policy from an interrupted run has to come off BEFORE
        # the baseline below, not when window A replaces it. A baseline read
        # taken while it is still on the bucket measures the leftover, and the
        # control every verdict here rests on would be a reading of the wrong
        # document.
        outcome, reason = classify(
            *verifier.request(_policy_probe("operator", bucket, "DELETE"))
        )
        rows.append(
            (
                "the leftover probe policy is removed before anything is measured",
                PASS if outcome == "allowed" else INCONCLUSIVE,
                "" if outcome == "allowed" else reason,
                "",
                outcome != "allowed",
            )
        )
        if outcome != "allowed":
            return rows, evidence, VERDICT_TEXT[UNEXPLAINED]

    # Every object is written before any policy exists, so no window's Deny can
    # be what refused a write, and the objects are removed after the last policy
    # has been taken off again.
    keys = {
        name: f"{PROBE_PREFIX}engine-{name.lower()}-{uuid.uuid4().hex}.txt"
        for name in (WINDOW_A, WINDOW_B, WINDOW_C)
    }
    for name, key in keys.items():
        write = Probe(
            "operator",
            "write the probe object",
            operation="put-object",
            method="PUT",
            bucket=bucket,
            key=key,
        )
        outcome, reason = classify(*verifier.request(write))
        if outcome != "allowed":
            rows.append((f"the probe object for window {name} is written", INCONCLUSIVE, reason, "", True))
            return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[UNEXPLAINED]

    # THE CONTROL EVERY VERDICT BELOW RESTS ON. With no policy on the bucket,
    # both keys must be able to read every probe object. Without it a denial in
    # a window could be the key, the object or the endpoint, and a denial whose
    # cause is unknown is the substitution that produced this whole programme.
    evidence.append("BASELINE -- no policy on the bucket")
    unattributable = []
    for name, key in keys.items():
        for role in ("foreign", "operator"):
            observation = _observe(verifier, bucket, f"baseline {name}", role, key)
            evidence.append(observation.line())
            if observation.outcome != "allowed":
                unattributable.append(f"{role} on the window {name} object ({observation.outcome})")
    if unattributable:
        rows.append(
            (
                "both keys read the probe objects with NO policy in force",
                INCONCLUSIVE,
                "with nothing on the bucket every read must succeed, and these did not: "
                + "; ".join(unattributable)
                + ". A denial under a policy would then be unattributable, so no window "
                "below could mean anything. Nothing further was applied.",
                "",
                True,
            )
        )
        return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[UNEXPLAINED]
    rows.append(
        (
            "both keys read the probe objects with NO policy in force",
            PASS,
            "",
            "the control every verdict below rests on",
            False,
        )
    )

    plan = {window: (sid, principal) for window, sid, principal in _diagnostic_plan(operator_arn, foreign_arn)}

    window_a = _window(
        verifier,
        bucket,
        window=WINDOW_A,
        policy=diagnostic_policy(bucket, *plan[WINDOW_A]),
        probe_key=keys[WINDOW_A],
        rows=rows,
        evidence=evidence,
        masks=masks,
    )
    if not window_a:
        return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[UNEXPLAINED]

    enforcement = enforcement_verdict(window_a["foreign"].outcome, window_a["operator"].outcome)
    rows.append(
        (
            "probe A: a Deny naming every principal reaches the foreign key",
            PASS if enforcement in (ENFORCED, ENFORCED_OWNER_EXEMPT) else FAIL,
            ""
            if enforcement in (ENFORCED, ENFORCED_OWNER_EXEMPT)
            else "the foreign key read an object a stored Deny on `Principal: \"*\"` covers, "
            "so no bucket policy on this account constrains anything"
            if enforcement == NOT_ENFORCED
            else "the operator was denied and the foreign key was not, by one statement "
            "naming every principal. No reading here explains that",
            "",
            enforcement not in (ENFORCED, ENFORCED_OWNER_EXEMPT),
        )
    )
    if enforcement == ENFORCED_OWNER_EXEMPT:
        # A real finding, and the reason the operator's reads are corroboration
        # rather than evidence: an engine that spares the bucket owner answers
        # the operator `allowed` in every window, which would look identical in
        # B and C whatever the principal did.
        rows.append(
            (
                "probe A: the same Deny also reaches the operator",
                FAIL,
                "the operator read an object a Deny naming every principal covers, so this "
                "engine exempts the bucket owner from its own bucket policies. Nothing below "
                "rests on the operator's reads, so the run continues -- but no fence can ever "
                "constrain the key that owns the bucket",
                "",
                False,
            )
        )
    if enforcement not in (ENFORCED, ENFORCED_OWNER_EXEMPT):
        return (
            rows + _cleanup_rows(verifier, bucket),
            evidence,
            VERDICT_TEXT[NOT_ENFORCED if enforcement == NOT_ENFORCED else UNEXPLAINED],
        )

    window_b = _window(
        verifier,
        bucket,
        window=WINDOW_B,
        policy=diagnostic_policy(bucket, *plan[WINDOW_B]),
        probe_key=keys[WINDOW_B],
        rows=rows,
        evidence=evidence,
        masks=masks,
    )
    if not window_b:
        return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[UNEXPLAINED]
    rows.append(
        (
            "probe B: a Deny naming the foreign key reaches that key",
            PASS if window_b["foreign"].outcome == "denied" else FAIL,
            "" if window_b["foreign"].outcome == "denied" else "it was allowed",
            "",
            False,
        )
    )

    window_c = _window(
        verifier,
        bucket,
        window=WINDOW_C,
        policy=diagnostic_policy(bucket, *plan[WINDOW_C]),
        probe_key=keys[WINDOW_C],
        rows=rows,
        evidence=evidence,
        masks=masks,
    )
    if not window_c:
        return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[UNEXPLAINED]
    rows.append(
        (
            "probe C: a Deny naming the OPERATOR key spares the foreign key",
            PASS if window_c["foreign"].outcome == "allowed" else FAIL,
            "" if window_c["foreign"].outcome == "allowed" else "it was denied",
            "with probe B above, this pair is the whole answer; either row alone fits two "
            "engines that differ on whether any fence is possible",
            False,
        )
    )

    verdict = principal_verdict(window_b["foreign"].outcome, window_c["foreign"].outcome)
    rows.append(
        (
            "A BUCKET POLICY CAN FENCE ONE KEY FROM ANOTHER HERE",
            PASS if FENCE_IS_POSSIBLE[verdict] else FAIL,
            "" if FENCE_IS_POSSIBLE[verdict] else "see the verdict below",
            "",
            not FENCE_IS_POSSIBLE[verdict],
        )
    )
    return rows + _cleanup_rows(verifier, bucket), evidence, VERDICT_TEXT[verdict]


def read_credentials(
    environ: dict[str, str], *, require_all: bool = True, needed: tuple | None = None
) -> dict[str, tuple[str, str]]:
    """The credentials for each role, from the environment and nowhere else.

    `require_all` is relaxed only by `--show-account`, which answers a question
    about one credential at a time and writes nothing. `needed` narrows which
    roles a mode insists on: a verdict about a FENCE is a statement about which
    credentials it separates and needs all three, while the engine diagnostic
    reaches no verdict about a fence and asks its question with two. Demanding a
    credential a mode never sends is an argument an operator has to find, and
    every one of those is a chance to paste the wrong value.
    """
    credentials = {}
    missing = []
    wanted = tuple(ROLE_ENV) if needed is None else needed
    for role, (key_name, secret_name) in ROLE_ENV.items():
        access_key = environ.get(key_name)
        secret_key = environ.get(secret_name)
        if not access_key or not secret_key:
            if role in wanted:
                missing.append(f"{key_name}/{secret_name}")
            continue
        credentials[role] = (access_key, secret_key)
    if missing and require_all:
        raise VerifierError("missing credentials in the environment: " + ", ".join(missing))
    if not credentials:
        raise VerifierError("no credentials in the environment: " + ", ".join(missing))

    ids = {role: pair[0] for role, pair in credentials.items()}
    for left in ids:
        for right in ids:
            if left < right and ids[left] == ids[right]:
                raise VerifierError(
                    f"the {left} and {right} roles are the same access key. Every check that "
                    f"distinguishes them would be meaningless, and the run would report a "
                    f"fence it never tested."
                )
    return credentials


def apply_fence(verifier: Verifier, *, bucket: str, policy_document: bytes) -> tuple[list[tuple], bool]:
    """Pre-flight and the double PUT, in one process.

    Split across two commands these are two decisions an operator makes
    separately, with scroll-back and two credential blocks in between, and the
    riskier bucket was the one whose apply had no in-process guard at all --
    `configure_backup_bucket.py` covers the backup bucket and nothing covered
    the state bucket. Here the PUT is unreachable unless the pre-flight passed.
    """
    rows = preflight(verifier, bucket=bucket, policy_document=policy_document)
    if any(status in (FAIL, INCONCLUSIVE) for _, status, _, _, _ in rows):
        rows.append(
            (
                "the policy is applied",
                INCONCLUSIVE,
                "not attempted: the pre-flight above did not pass, and applying a policy "
                "this credential is not exempt from is unrecoverable",
                "",
                False,
            )
        )
        # Nothing was written, so the caller must not print the lockout banner.
        # Telling an operator the bucket may be locked when it was never
        # touched sends them to open a support request against a healthy
        # bucket -- the same misread the region handling exists to avoid.
        return rows, False

    put = _policy_probe("operator", bucket, "PUT", policy_document)
    first_outcome, first_reason = classify(*verifier.request(put))
    rows.append(
        (
            "the policy is applied",
            PASS if first_outcome == "allowed" else FAIL,
            "" if first_outcome == "allowed" else first_reason,
            "",
            False,
        )
    )
    if first_outcome != "allowed":
        return rows, True

    # The identical document again. A no-op when it succeeds, and the only
    # signal available if the engine has just denied the operator the ability
    # to edit the statement doing the denying.
    second_outcome, second_reason = classify(*verifier.request(put))
    rows.append(
        (
            "THE BUCKET IS STILL ADMINISTRABLE",
            PASS if second_outcome == "allowed" else FAIL,
            "" if second_outcome == "allowed" else second_reason,
            "a no-op when it succeeds; a permanent lockout when it does not",
            True,
        )
    )
    rows.append(
        ("the stored policy is the one that was sent", *compare_stored_policy(verifier, bucket, policy_document), "", False)
    )
    return rows, True


def show_accounts(verifier: Verifier) -> list[tuple]:
    """Each credential's own storage account, over the transport the probes use.

    The value `--project-id` has to be rendered from, read from the credential
    rather than from a document. It is a separate mode because it is the first
    thing an operator needs and the only one that needs no policy file -- and
    because `aws s3api list-buckets`, the obvious way to ask, is one of the
    commands this backend's error documents crash.
    """
    return [
        (f"{role} credential resolves its account", *_account_row(verifier, role))
        for role in ("operator", "workload", "foreign")
        if role in verifier.credentials
    ]


def _account_row(verifier: Verifier, role: str) -> tuple:
    # Never critical: this mode writes nothing and has no policy in hand, so
    # the lockout banner `report()` raises for a critical row would be about a
    # decision nobody is making yet.
    account, reason = account_of(verifier, role)
    if account is None:
        return (INCONCLUSIVE, reason, "", False)
    return (PASS, "", account, False)


def report(
    rows: list[tuple],
    problems: list[str],
    stream,
    *,
    applied: bool,
    clean_message: str = "",
    banner: str = "",
    failure_summary: str = "the fence is not doing what it must",
) -> int:
    """`rows` are `(name, status, reason, note, critical)`.

    `clean_message` replaces the closing line for a mode whose clean run is not
    a statement about a policy. Without it, `--show-account` would end by
    saying the policy is safe to apply, having read no policy at all.

    `banner` replaces the shout raised by a failed critical row, for the same
    reason: `--probe-notprincipal` writes no fence, so neither "the bucket may
    be locked" nor "re-render it against the account id printed above" is a
    true sentence about what just happened there.
    """
    width = max(len(name) for name, _, _, _, _ in rows)
    for name, status, reason, note, _ in rows:
        line = f"{status:<13} {name:<{width}}"
        if reason:
            line += f"  -- {reason}"
        elif note:
            line += f"  ({note})"
        print(line, file=stream)

    for problem in problems:
        print(f"CLEANUP       {problem}", file=stream)

    failed = [row for row in rows if row[1] == FAIL]
    inconclusive = [row for row in rows if row[1] == INCONCLUSIVE]

    if any(row[4] for row in failed + inconclusive):
        if banner:
            print(f"\n{banner}", file=stream)
        elif applied:
            print(
                "\n*** THE BUCKET MAY BE LOCKED. The operator key could not replace the policy. "
                "No other key in the project can either. Do not leave this terminal: raise a "
                "Hetzner support request to remove the bucket policy, and see "
                "RUNBOOK-bucket-fencing.md.",
                file=stream,
            )
        else:
            print(
                "\n*** DO NOT APPLY THIS POLICY. Nothing has been written yet, and applying it "
                "in this state would lock the bucket with no recovery inside the account. "
                "Re-render it against the account id this pre-flight resolved; if no account "
                "was resolved above, fix that credential first -- nothing can be decided "
                "without it.",
                file=stream,
            )
    if failed:
        print(f"\n{len(failed)} check(s) FAILED: {failure_summary}.", file=stream)
    if inconclusive:
        print(
            f"\n{len(inconclusive)} check(s) INCONCLUSIVE. An inconclusive check is not a pass "
            f"-- it means the probe proved nothing, which is how an open bucket was previously "
            f"recorded as fenced.",
            file=stream,
        )
    if not failed and not inconclusive and not problems:
        message = clean_message or (
            "\nEvery check passed, in both directions."
            if applied
            else "\nPre-flight clean. The policy is safe to apply to this bucket, with this "
            "operator credential."
        )
        print(message, file=stream)
    return 0 if not failed and not inconclusive and not problems else 1


def main(argv: list[str] | None = None, transport=None, environ=None) -> int:
    environ = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", help="the fenced bucket")
    parser.add_argument(
        "--foreign-control-bucket",
        help="a bucket the foreign key IS entitled to, proving that key is live",
    )
    parser.add_argument(
        "--policy-file",
        help="the policy document just applied; re-PUT as the recoverability check",
    )
    parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    parser.add_argument("--region", default="hel1")
    parser.add_argument(
        "--show-account",
        action="store_true",
        help="print the storage account each credential belongs to; writes nothing and "
        "needs no policy file",
    )
    parser.add_argument(
        "--probe-notprincipal",
        action="store_true",
        help="ask the live engine whether NotPrincipal exempts, reversibly; run this first",
    )
    parser.add_argument(
        "--diagnose-policy-engine",
        action="store_true",
        help="settle what a bucket policy does on this engine -- whether it is enforced at "
        "all, and whether a named principal separates one key from another; reversible, "
        "and needs only --bucket",
    )
    parser.add_argument(
        "--replace-existing-policy",
        action="store_true",
        help="allow a probe mode on a bucket that already carries that probe's own policy",
    )
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="check the policy against the live credentials BEFORE applying it; writes nothing",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="pre-flight, then apply the policy and prove it is replaceable, in one process",
    )
    parser.add_argument(
        "--versioning-already-enabled",
        action="store_true",
        help="add the versioning-write denial probe; only safe where versioning is already on",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the probe matrix and run nothing"
    )
    args = parser.parse_args(argv)

    # Before any mode runs, and therefore before any mode writes. The transport
    # every probe uses is this repository's own signing implementation; a
    # checkout that does not carry it can prove nothing, and finding that out
    # part-way through --probe-notprincipal is how an operator ends up removing
    # a probe policy from a production bucket by hand.
    if SIGNING_UNAVAILABLE:
        print(f"error: {SIGNING_UNAVAILABLE}", file=sys.stderr)
        return 2

    # `--show-account` answers "which account is this credential in", which is
    # the value `--project-id` gets rendered from and therefore the first thing
    # an operator needs -- before there is a bucket decision, a policy file or
    # a second credential to name. Every other mode reaches a verdict about a
    # fence and needs all of them.
    if args.show_account:
        try:
            verifier = Verifier(
                endpoint=args.endpoint,
                region=args.region,
                credentials=read_credentials(environ, require_all=False),
                transport=transport,
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        return report(
            show_accounts(verifier),
            [],
            sys.stdout,
            applied=False,
            clean_message="\nEach credential is in the account printed beside it. Render every "
            "policy with --project-id set to that id WITHOUT its leading `p`; an ARN under any "
            "other account names a principal that does not exist.",
        )

    # `--diagnose-policy-engine` asks a question about the ENGINE and reads no
    # policy: it writes its own three documents and removes each one. Requiring
    # a rendered fence for it would mean rendering the very document the answer
    # decides whether to build, and every argument an operator does not have to
    # type is one they cannot mistype into a production bucket.
    needs = (
        (("--bucket", args.bucket),)
        if args.diagnose_policy_engine
        else (
            ("--bucket", args.bucket),
            ("--foreign-control-bucket", args.foreign_control_bucket),
            ("--policy-file", args.policy_file),
        )
    )
    required = [name for name, value in needs if not value]
    if required:
        parser.error(f"{', '.join(required)} required for this mode")

    policy_document = b""
    if args.policy_file:
        try:
            with open(args.policy_file, "rb") as handle:
                policy_document = handle.read()
        except OSError as error:
            print(f"error: could not read --policy-file: {error}", file=sys.stderr)
            return 2

    probe_key = f"{PROBE_PREFIX}{uuid.uuid4().hex}.txt"
    checks = (
        []
        if args.diagnose_policy_engine
        else build_checks(
            bucket=args.bucket,
            foreign_control_bucket=args.foreign_control_bucket,
            policy_document=policy_document,
            probe_key=probe_key,
            versioning_already_enabled=args.versioning_already_enabled,
        )
    )

    if args.dry_run and args.diagnose_policy_engine:
        # The three documents, with the principals shown as the roles they are
        # built from. Nothing is sent, no credential is read, and an operator
        # can read exactly what would reach the bucket before it does.
        for window, sid, principal in _diagnostic_plan():
            print(
                f"window {window}  "
                + json.dumps(diagnostic_policy(args.bucket, sid, principal), sort_keys=True)
            )
        return 0

    if args.dry_run:
        for check in checks:
            control = (
                f", control: {check.control.role} {check.control.description}"
                if check.control
                else ""
            )
            print(f"{check.expect:<5} {check.probe.role:<9} {check.name}{control}")
        return 0

    try:
        verifier = Verifier(
            endpoint=args.endpoint,
            region=args.region,
            credentials=read_credentials(
                environ,
                needed=("operator", "foreign") if args.diagnose_policy_engine else None,
            ),
            transport=transport,
        )
    except VerifierError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.diagnose_policy_engine:
        try:
            rows, evidence, verdict = diagnose_policy_engine(
                verifier, bucket=args.bucket, replace_existing=args.replace_existing_policy
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        # The evidence goes above the rows so the verdict is the last thing on
        # the screen, and the evidence is a chronological log of what happened
        # rather than a footnote to a conclusion drawn from it. Access key ids
        # are shown by their last four characters, so the whole block is safe to
        # paste into an issue -- which is the only way it gets recorded at all.
        print("RAW EVIDENCE -- record this block verbatim; it names no secret\n")
        for line in evidence:
            print(line)
        print("")
        # THE VERDICT IS PRINTED WHATEVER THE ROWS SAY, and printed last.
        # `report`'s own closing lines are conditional -- the clean message on
        # nothing having failed, the banner on a CRITICAL row having failed --
        # and a run can end outside both: an engine that exempts the bucket
        # owner produces a FAIL row that is a side finding, and the answer to
        # the question the operator ran this to settle would have gone unprinted.
        code = report(
            rows,
            [],
            sys.stdout,
            applied=False,
            clean_message="\nEvery probe answered and every probe policy came off again.",
            banner="*** NOTHING WAS APPLIED AND NO FENCE WAS WRITTEN. Read the verdict below.",
            failure_summary="read the verdict below. Nothing was applied and no fence was "
            "written; a FAIL here is a finding about the engine, not a broken run",
        )
        print(f"\n{verdict}")
        return code

    if args.probe_notprincipal:
        try:
            rows = probe_notprincipal(
                verifier, bucket=args.bucket, replace_existing=args.replace_existing_policy
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        return report(
            rows,
            [],
            sys.stdout,
            applied=False,
            banner="*** DO NOT APPLY THE REAL FENCE. This step is the gate for "
            "everything after it, and a critical row above did not pass. No fence was "
            "written here; if `THE PROBE POLICY IS REMOVED` reads FAIL, the probe policy "
            "is still on the bucket and that row carries the fix.",
        )

    if args.preflight:
        return report(
            preflight(verifier, bucket=args.bucket, policy_document=policy_document),
            [],
            sys.stdout,
            applied=False,
        )

    if args.apply:
        rows, wrote = apply_fence(verifier, bucket=args.bucket, policy_document=policy_document)
        return report(rows, [], sys.stdout, applied=wrote)

    rows = [
        (check.name, *verifier.check(check), check.note, check.critical) for check in checks
    ]
    rows.append(
        (
            "the stored policy is the one that was sent",
            *compare_stored_policy(verifier, args.bucket, policy_document),
            "",
            False,
        )
    )
    problems = cleanup(verifier, args.bucket)
    return report(rows, problems, sys.stdout, applied=True)


if __name__ == "__main__":
    raise SystemExit(main())
