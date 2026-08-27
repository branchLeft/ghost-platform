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

`--probe-foreign-grant` IS THE OTHER HALF OF THE ENGINE QUESTION. Every reader
in the diagnostic above is a key belonging to the bucket's own project, so "no
shape constrains the owner's own keys" and "no policy is evaluated at all" are
one observation from inside that project. They are not one fact. An engine that
evaluates policies for foreign and anonymous callers while bypassing evaluation
for the bucket owner's keys produces exactly that output, and this provider
documents two features only such an engine could provide: cross-project `Allow`
grants, and public bucket visibility implemented as an automatically applied
anonymous-read policy with listing denied.

So this mode reads with a credential from ANOTHER project, and refuses to run at
all if that credential resolves to the bucket's own account -- an owner key as
grantee would re-create the blind spot the mode exists to close. It grants
twice: once with a narrow `Allow s3:GetObject` on the probe prefix, and once
with the provider's documented cross-project shape verbatim, because an
implementation that pattern-matches a published template would honour the second
and ignore the first. That difference decides how every policy in this estate
has to be written, so a run that tested one shape would answer the wrong
question. Every document it sends is `Allow`-only and asserted to deny nobody
before it is sent; an `Allow` cannot lock a bucket, and the assertion makes that
a property of the code rather than of the brief it was written to.

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
    FENCE_GRANTEE_ACCESS_KEY_ID  / FENCE_GRANTEE_SECRET_ACCESS_KEY

The foreign role is any real key in the same project that has no business in
this bucket. It must be a live key with an entitlement somewhere, named by
`--foreign-control-bucket`, or its denials prove nothing.

THE GRANTEE ROLE IS THE OPPOSITE OF THE FOREIGN ROLE. `--probe-foreign-grant`
uses it and nothing else does: it is a key in a DIFFERENT project from the
bucket, and the one thing that makes the grant probe mean anything. The mode
resolves its account from the credential itself and stops if it matches the
bucket's.

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
import time
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

# How long to leave between the two reads that have to agree before an
# observation counts, and between attempts to remove a probe policy.
#
# NOTHING HERE ESTABLISHES THIS ENDPOINT'S CONSISTENCY GUARANTEES, and that is
# the reason the pause exists rather than a reason to skip it. A policy PUT is
# confirmed by reading the document back, which proves it reached the node that
# answered `GetBucketPolicy`; an object read may be served by another. Every
# way that can go wrong biases a read towards `allowed` -- an unenforced-looking
# result -- which is the direction that produces the most consequential
# readings in this file from a timing artefact rather than from the engine.
SETTLE_SECONDS = 2.0

_REMOVAL_ATTEMPTS = 3

# Indirected so the tests can run the whole diagnostic without waiting. Nothing
# else should reach past this.
_sleep = time.sleep

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
    "grantee": ("FENCE_GRANTEE_ACCESS_KEY_ID", "FENCE_GRANTEE_SECRET_ACCESS_KEY"),
}

# Which roles each mode signs as. Stated per mode rather than defaulted to "all
# of them": the grantee belongs to another project, so a fence verification that
# demanded one would be asking an operator to export a credential it never
# sends, and every variable an operator has to find is a chance to paste the
# wrong value into a production run.
FENCE_ROLES = ("operator", "workload", "foreign")
DIAGNOSTIC_ROLES = ("operator", "foreign")
GRANT_ROLES = ("operator", "grantee")

PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"


def _finding_status(shown: bool, unproven: bool) -> str:
    """The status for a headline row asserting a property was or was not shown.

    `PASS` when the property was demonstrated, `FAIL` when its opposite was, and
    `INCONCLUSIVE` when the run settled nothing. A headline that printed `FAIL`
    for an unproven run would assert the negative -- "no, a policy does NOT reach
    a foreign principal" from reads that never classified -- which is the exact
    substitution `_grant_row` and `classify` exist to prevent, made one level up
    in the row a skimmer reads first and pastes onto the tracker.
    """
    if shown:
        return PASS
    return INCONCLUSIVE if unproven else FAIL


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


def probe_family_ids(bucket: str) -> tuple:
    """Every `Id` this file writes a probe policy under.

    One list, because each probe mode has to recognise the documents the OTHERS
    leave behind. A document this repository wrote and documents as safe to
    replace, met by a mode that does not know the Id, is refused as a stranger's
    -- which sends an operator to remove by hand something the tool would have
    cleared, on a bucket they were told not to touch by hand.
    """
    return (probe_policy_id(bucket), diagnostic_policy_id(bucket), foreign_grant_policy_id(bucket))


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


def _leftover_description(bucket: str, stored_id: str | None) -> str:
    """What a probe document this tool wrote is doing while it sits there.

    A leftover `Deny` costs nothing and an operator can finish their coffee. A
    leftover `Allow` is a credential in another project holding access to this
    bucket, which is the one leftover worth interrupting something for -- so the
    two cannot share a sentence, and the Id is what tells them apart.
    """
    if stored_id == foreign_grant_policy_id(bucket):
        return (
            f"IT IS A GRANT, NOT A DENY: it leaves a credential in another project holding "
            f"read access to {bucket} that it is not meant to have. Removing it is the "
            f"urgent half of this, and replacing it costs nothing."
        )
    return (
        f"It denies reads under {PROBE_PREFIX} to every key but the operator and constrains "
        f"nothing else, so replacing it costs nothing."
    )


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
            f"a previous probe run left its own probe policy on {bucket} (Id {stored_id}). "
            f"{_leftover_description(bucket, stored_id)} Re-run this exact command with "
            f"--replace-existing-policy added, and it is removed at the end of the run.",
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
        verifier,
        bucket,
        replace_existing=replace_existing,
        own_ids=probe_family_ids(bucket),
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

    `consequence` is the sentence describing what a document left on the bucket
    would do, and it is an argument rather than a constant because the two probe
    families leave opposite things behind. A stranded `Deny` refuses reads under
    an unused prefix and hurts nothing; a stranded `Allow` leaves a credential
    holding access it is not meant to have. Printing the deny sentence over a
    leftover grant would tell an operator to relax about the one case that is
    actually exposure.
    """

    DENY_CONSEQUENCE = (
        f"It denies s3:GetObject under {PROBE_PREFIX} and nothing else, so no real object "
        f"is affected -- but do not leave it."
    )

    def __init__(
        self,
        verifier: Verifier,
        bucket: str,
        policy: dict,
        rows: list[tuple],
        label: str = "",
        consequence: str = "",
    ):
        self.verifier = verifier
        self.bucket = bucket
        self.consequence = consequence or self.DENY_CONSEQUENCE
        self.document = json.dumps(policy).encode("utf-8")
        # Read off the document rather than rebuilt from the bucket name. Two
        # modes here write probe policies under different Ids, and the row that
        # tells an operator which document is safe to delete is worth nothing if
        # it names the other mode's -- worse than nothing, because
        # `_existing_policy_refusal` reads an Id it does not recognise as a
        # foreign document to leave alone.
        self.policy_id = policy.get("Id", "")
        self.rows = rows
        self.label = label
        self.applied = False
        # Whether the bucket is back to carrying no policy. A run that could not
        # take its own document off must not put another one on top of it: the
        # next window would then be measuring a bucket whose state nobody knows.
        self.removed = False
        # Set only when the PUT got no response: the document may or may not be
        # on the bucket, so the bucket is NOT verified clean even though nothing
        # is `applied`. A caller deciding whether to run a following window has
        # to tell this apart from a PUT that was cleanly refused.
        self.fate_unknown = False

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
            self.fate_unknown = True
            self.rows.append(
                (
                    "THE PROBE POLICY'S FATE IS UNKNOWN" + self.label,
                    INCONCLUSIVE,
                    f"the PUT of the probe policy got no response ({reason}), so it may or "
                    f"may not be on {self.bucket}. Nothing was deleted, because a DELETE "
                    f"here removes whatever is on the bucket rather than only this probe. "
                    f"Check by hand before doing anything else: aws --endpoint-url "
                    f"https://{self.verifier.host} s3api get-bucket-policy --bucket "
                    f"{self.bucket}. A policy with Id {self.policy_id} is this probe. "
                    f"{self.consequence}",
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
        # RETRIED, because the alternative to a retry here is a document left on
        # a production bucket by one transient 503. The delete is idempotent --
        # it removes whatever is on the bucket, and after the first success
        # there is nothing to remove -- so the only cost of an extra attempt is
        # a request.
        for attempt in range(_REMOVAL_ATTEMPTS):
            outcome, reason = classify(
                *self.verifier.request(_policy_probe("operator", self.bucket, "DELETE"))
            )
            self.removed = outcome == "allowed"
            if self.removed:
                return False
            if attempt + 1 < _REMOVAL_ATTEMPTS:
                _sleep(SETTLE_SECONDS)
        self.rows.append(
            (
                "THE PROBE POLICY IS REMOVED" + self.label,
                FAIL,
                f"the probe policy (Id {self.policy_id}) is still on {self.bucket} after "
                f"{_REMOVAL_ATTEMPTS} attempts to remove it ({reason}). {self.consequence} "
                f"Re-run this command with "
                f"--replace-existing-policy: it replaces the leftover probe and removes the "
                f"replacement, and needs nothing but python3. Failing that, delete it "
                f"directly with aws --endpoint-url https://{self.verifier.host} s3api "
                f"delete-bucket-policy --bucket {self.bucket} -- which prints a "
                f"client-internal error rather than the S3 one if it is refused in turn, so "
                f"read its exit code, not its text",
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
#     all of them; what changes between windows is only WHO the statement names.
#     The operator's reads are kept as corroboration, never as the deciding
#     evidence -- an engine that exempts the bucket owner would otherwise answer
#     every window the same way from the operator's side and hide the question.
#   - THE VERDICT IS DRAWN FROM A COMBINATION, NEVER FROM A ROW. A single read
#     is consistent with several worlds, and that holds for EVERY window here,
#     including the wildcard one. No window is a gate that can end the run on
#     its own reading.
#
# The subject key is read under four different names, and the combination of
# what happens to it is the answer:
#
#   Window B -- `Principal: [the subject's own ARN]`. Does naming a key deny it?
#   Window C -- `Principal: [the other real key's ARN]`. Does naming one key
#     deny a DIFFERENT one?
#   Window D -- `Principal: [an ARN in an account that is not ours, naming a key
#     that does not exist]`. Does a name that can resolve to nothing still deny?
#   Window A -- `Principal: "*"`. Does a wildcard deny?
#
#       B denied, C allowed, D allowed -> the name resolves to the exact key.
#       B denied, C denied,  D allowed -> both our keys are ONE principal and a
#                                         stranger is not: the project is one
#                                         RGW user.
#       B denied, C denied,  D denied  -> the name is decoration; a Deny reaches
#                                         every caller whatever it names.
#       B allowed, C denied, D denied  -> the engine matches the complement.
#       B allowed, C allowed, D allowed -> a named ARN matches nobody; window A
#                                         then splits "only `*` matches" from
#                                         "nothing is enforced at all".
#
# WINDOW D IS WHAT SEPARATES THE TWO WORLDS THAT MATTER MOST. Without it, "every
# credential in this project is one RGW user" and "the Principal element is
# ignored" both land on B denied, C denied, and a single verdict covering both
# would be a verdict covering two engines -- the exact defect this file exists
# to remove. The consequences differ: under one, a cross-project principal deny
# still works and per-project isolation is the answer; under the other, no
# principal-based control is possible at all.
#
# WINDOW A RUNS LAST, AND ONLY WHEN THE ANSWER TURNS ON IT. It is the only
# window that denies the operator by construction, and the only one whose
# statement covers every caller whatever the engine's principal semantics turn
# out to be -- so it is the one window with a blast radius that does not depend
# on the open question. B, C and D decide four of the five readings without it.
# It is sent only in the fifth, where a named ARN denied nobody and the
# remaining question is whether a wildcard does any better.
#
# Every probe policy here carries the same safety property as the earlier one
# and goes through the same assertion, BEFORE ANY OBJECT IS WRITTEN: one `Deny`,
# `s3:GetObject` only, confined to the probe prefix, and NO statement on the
# bucket resource -- so `PutBucketPolicy` and `DeleteBucketPolicy` stay
# available to every key throughout and no window can lock a bucket.
# --------------------------------------------------------------------------

WINDOW_A = "A"
WINDOW_B = "B"
WINDOW_C = "C"
WINDOW_D = "D"

# A principal that is definitely not either credential: an account that is not
# this one, naming a key that does not exist in it. The account is all zeroes so
# that it cannot be mistaken for a real one in the evidence block.
ABSENT_PRINCIPAL = "arn:aws:iam:::user/p00000000:NOSUCHKEYNOSUCHKEY00"

# What window A's own two reads say. These are OBSERVATIONS, reported as rows
# and never as a verdict on their own -- see the note above about no window
# being a gate.
WILDCARD_DENIES_BOTH = "wildcard-denies-both"
WILDCARD_SPARES_THE_OWNER = "wildcard-spares-the-owner"
WILDCARD_DENIES_NOBODY = "wildcard-denies-nobody"

# The readings. One per coherent engine.
RESOLVES_PER_KEY = "resolves-per-key"
ONE_PRINCIPAL_PER_PROJECT = "one-principal-per-project"
NAME_IS_DECORATION = "name-is-decoration"
NAME_MATCHES_NOBODY = "name-matches-nobody"
NAME_IS_INVERTED = "name-is-inverted"
NOT_ENFORCED = "not-enforced"

UNEXPLAINED = "unexplained"

# What each reading leaves the estate able to do. Exactly one of them leaves a
# fence buildable, and this mapping is what the report's headline row is drawn
# from -- so a reading added without an entry here fails loudly rather than
# defaulting to "a fence is fine".
FENCE_IS_POSSIBLE = {
    RESOLVES_PER_KEY: True,
    ONE_PRINCIPAL_PER_PROJECT: False,
    NAME_IS_DECORATION: False,
    NAME_MATCHES_NOBODY: False,
    NAME_IS_INVERTED: False,
    NOT_ENFORCED: False,
    UNEXPLAINED: False,
}

VERDICT_TEXT = {
    RESOLVES_PER_KEY: (
        "PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE.\n"
        "A Deny naming one access key denied that key, left the other one able to read, and\n"
        "a Deny naming a principal in another account denied nobody. An explicit\n"
        "`Principal` therefore separates two credentials inside this project.\n\n"
        "A fence is rebuildable -- but NOT the fence this repository renders. That one\n"
        "fences by `NotPrincipal`, which was observed live denying nobody, and this run\n"
        "says nothing to rehabilitate it: it never sent a `NotPrincipal` document. Until\n"
        "the fence is rebuilt out of explicit `Principal` Deny statements, treat every\n"
        "bucket it was applied to as unfenced, and do not apply it anywhere else.\n"
        "Record this output on the issue."
    ),
    ONE_PRINCIPAL_PER_PROJECT: (
        "EVERY CREDENTIAL IN THIS PROJECT IS ONE PRINCIPAL.\n"
        "A Deny naming ONE of this project's access keys denied BOTH of them, and a Deny\n"
        "naming a principal in another account denied neither. The name is being read --\n"
        "it just resolves to the project's single storage user, which every key in the\n"
        "project shares, so an ARN naming any key names all of them.\n\n"
        "No bucket policy can separate two credentials inside one Hetzner project. The\n"
        "fence in this repository protects nothing, and neither does the tenant media\n"
        "policy -- a per-tenant bucket is reachable by every other tenant's key. Do not\n"
        "apply either. A principal deny still discriminates ACROSS projects, so a project\n"
        "per tenant is the mechanism that remains; that is an architecture decision with\n"
        "cap, credential-custody and provisioning consequences, not a fix to make here.\n"
        "Record this output on the issue."
    ),
    NAME_IS_DECORATION: (
        "THE PRINCIPAL ELEMENT IS DECORATION ON THIS ENGINE.\n"
        "A Deny denied the subject key whether it named that key, named a different key, or\n"
        "named a principal in an account that is not ours. The statement applies to every\n"
        "caller whatever principal it carries, so the element is not being read at all.\n\n"
        "Bucket policies cannot fence one credential from another here: a Deny aimed at a\n"
        "stranger takes the workload down with it. Applying a fence would be an outage, not\n"
        "a control. Do not apply one. No principal-based control is possible at any scope,\n"
        "so a project per tenant does not rescue this either -- the remaining boundary is\n"
        "whatever separates buckets without a policy. Record this output on the issue."
    ),
    NAME_MATCHES_NOBODY: (
        "A NAMED PRINCIPAL MATCHES NOBODY ON THIS ENGINE.\n"
        "A Deny naming `*` denied the subject key, so policies ARE enforced -- but a Deny\n"
        "naming any ARN at all denied nobody, including the ARN of the key doing the\n"
        "reading. The ARN form this repository builds is not being resolved.\n\n"
        "Whether that is the form or the mechanism is not settled by this run, and the\n"
        "difference does not change what to do now: no bucket policy this repository can\n"
        "render separates two credentials. The fence protects nothing and neither does the\n"
        "tenant media policy. Do not apply either. Record this output on the issue --\n"
        "the principal SPELLING is worth one more experiment before per-tenant projects\n"
        "are treated as the only option."
    ),
    NAME_IS_INVERTED: (
        "THIS ENGINE MATCHES THE COMPLEMENT OF THE PRINCIPAL IT IS GIVEN.\n"
        "A Deny naming the subject key left THAT key able to read, and a Deny naming anyone\n"
        "else denied it.\n\n"
        "This is not a documented S3 behaviour and nothing here should be built on it.\n"
        "Do not apply any policy to any bucket. Record this output verbatim on the issue:\n"
        "a fence written against this reading would invert the moment the engine is fixed."
    ),
    NOT_ENFORCED: (
        "BUCKET POLICIES ARE NOT ENFORCED AGAINST THIS PROJECT'S OWN KEYS.\n"
        "Every Deny this run stored was stored verbatim and denied nobody -- including one\n"
        "naming `Principal: \"*\"`, which no principal semantics can read as excluding the\n"
        "caller.\n\n"
        "THAT IS THE WHOLE OF WHAT THIS MODE CAN SETTLE, and the wording matters because an\n"
        "earlier version of this verdict claimed the account. Every reader in every window\n"
        "here is a credential belonging to the bucket's own project, so an engine that\n"
        "evaluates policies for foreign and anonymous principals while bypassing evaluation\n"
        "for the owner's keys produces exactly this output. Run --probe-foreign-grant, with\n"
        "a credential from another project, to settle that half; until it has, do not say\n"
        "policies are off account-wide and do not treat native public-bucket visibility --\n"
        "which this provider implements as an automatically applied anonymous-read policy --\n"
        "as broken on the strength of this run.\n\n"
        "No bucket policy separates two credentials INSIDE one project, so the fence in this\n"
        "repository and the tenant media policy both protect nothing against a key in the\n"
        "bucket's own project. Do not apply either, and do not read a successful PUT as a\n"
        "control ever again. The only demonstrated isolation boundary is a separate Hetzner\n"
        "project. Record this output on the issue."
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
    """The windows, in the order they run.

    One definition, so the plan `--dry-run` prints is the plan the run sends.
    The defaults are placeholders for that dry run, which reads no credential.
    Window A is last because it is the only one that denies the operator, and
    the only one whose statement covers every caller under any reading of
    `Principal` -- so it is sent only in the single case whose answer turns on
    it. `needs_wildcard` below is that case.
    """
    return (
        (WINDOW_B, "ProbeDenyTheSubjectKey", {"AWS": [foreign_arn]}),
        (WINDOW_C, "ProbeDenyTheOtherKey", {"AWS": [operator_arn]}),
        (WINDOW_D, "ProbeDenyAnAbsentPrincipal", {"AWS": [ABSENT_PRINCIPAL]}),
        (WINDOW_A, "ProbeDenyEveryPrincipal", {"AWS": "*"}),
    )


def wildcard_observation(foreign: str, operator: str) -> str:
    """What window A's own two reads show. An observation, never a verdict.

    THE FOREIGN READ IS THE SUBJECT, not the operator's. An engine that exempts
    the bucket owner from its own bucket policies answers the operator `allowed`
    whatever the statement says, so reading the operator's row as "enforced or
    not" describes the owner rather than the engine.

    This function names no reading and ends no run. A wildcard that denies
    nobody is consistent with an engine that enforces nothing AND with an engine
    that enforces named principals and does not implement `*` -- worlds that
    differ on whether a fence is buildable at all. `principal_verdict` is what
    separates them, and it needs windows B, C and D to do it.
    """
    if foreign not in ("allowed", "denied") or operator not in ("allowed", "denied"):
        return UNEXPLAINED
    if foreign == "allowed":
        # Denying the operator and not the subject, under one statement naming
        # every principal, is not a behaviour any reading here covers.
        return UNEXPLAINED if operator == "denied" else WILDCARD_DENIES_NOBODY
    return WILDCARD_DENIES_BOTH if operator == "denied" else WILDCARD_SPARES_THE_OWNER


def needs_wildcard(named: str, other: str, absent: str) -> bool:
    """Whether window A has to be sent at all.

    Only one cell of `principal_verdict` depends on it: the one where no ARN
    denied anybody, where the remaining question is whether a wildcard does
    better. Everywhere else the wildcard would be corroboration bought by
    applying the single document that denies the operator by construction.
    """
    return (named, other, absent) == ("allowed", "allowed", "allowed")


def principal_verdict(named: str, other: str, absent: str, wildcard: str = "") -> str:
    """How this engine matches a principal, from the SUBJECT key's own reads.

    All four arguments are the same key reading the same object under four
    statements that differ only in who they name:

      `named`    -- window B, the statement names the subject itself
      `other`    -- window C, it names the other real key in this project
      `absent`   -- window D, it names a key that does not exist, in an account
                    that is not ours
      `wildcard` -- window A, it names every principal. Consulted ONLY in the
                    cell where no ARN denied anybody, and passed empty
                    otherwise, because that is the only cell it changes.

    Window D is the load-bearing one. Without it "an ARN naming any key in this
    project resolves to the one user they all share" and "the Principal element
    is not read at all" are the same observation, and they differ on whether a
    principal deny discriminates across projects -- which is the whole question
    of what replaces the fence.
    """
    reads = (named, other, absent)
    if any(read not in ("allowed", "denied") for read in reads):
        return UNEXPLAINED
    if reads == ("denied", "allowed", "allowed"):
        return RESOLVES_PER_KEY
    if reads == ("denied", "denied", "allowed"):
        return ONE_PRINCIPAL_PER_PROJECT
    if reads == ("denied", "denied", "denied"):
        return NAME_IS_DECORATION
    if reads == ("allowed", "denied", "denied"):
        return NAME_IS_INVERTED
    if reads == ("allowed", "allowed", "allowed"):
        if wildcard == "denied":
            return NAME_MATCHES_NOBODY
        if wildcard == "allowed":
            return NOT_ENFORCED
        return UNEXPLAINED
    # Everything left is a mixture no coherent principal semantics produces --
    # a Deny that reaches a stranger's name but not the reader's own, say.
    # Naming one of the readings above for it would be a guess.
    return UNEXPLAINED


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
    roles: tuple = ("foreign", "operator"),
    assertion=None,
    consequence: str = "",
    state: dict | None = None,
) -> dict[str, Observation]:
    """Apply one probe policy, read the object as both keys, remove it again.

    `roles` is `(subject, corroboration)`: the key whose reads decide the
    reading, and the operator read kept beside it as a control. `assertion` is
    the safety property the document has to satisfy before it is sent -- a
    `Deny` probe and an `Allow` probe are safe for different reasons and each
    has its own, so neither mode can inherit the other's guard by accident.

    Returns the observations, or an empty mapping when the window produced no
    interpretable evidence. That covers three cases and they are one answer
    here: the PUT was refused, what came back off the bucket is not what was
    sent, or the document could not be taken off again. Reads under the first
    two would be the bucket answering about some other document; after the third
    the bucket still carries a policy, so a later window would be measuring a
    state nobody established. Each has already been reported as its own row by
    the time this returns.

    An EMPTY RETURN COLLAPSES THOSE THREE, and a caller that has to run a
    following window needs to know which -- the first two leave the bucket clean,
    the third does not. `state`, when passed, is filled with the
    `_temporary_policy` object so that caller can read `applied`/`removed`/
    `fate_unknown` itself. The diagnostic does not pass it and is unchanged.
    """
    (assertion or assert_probe_policy_is_reversible)(policy, bucket)
    observations: dict[str, Observation] = {}
    label = f" (probe {window})"
    evidence.append(
        f"WINDOW {window} -- sent:   {_masked(json.dumps(policy, sort_keys=True), masks)}"
    )

    with _temporary_policy(verifier, bucket, policy, rows, label, consequence) as applied:
        if applied.applied:
            status, reason, body = read_stored_policy(verifier, bucket)
            if status == PASS:
                # MASKED BEFORE IT IS TRUNCATED, and the order is load-bearing.
                # Truncating first can cut an ARN in half, leaving a fragment
                # `_masked` no longer matches -- so most of an access key id
                # prints verbatim into the block the runbook calls safe to paste
                # anywhere.
                evidence.append(
                    f"WINDOW {window} -- stored: "
                    + _one_line(_masked(_decoded(body), masks), 1200)
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
                observations = _confirmed_reads(
                    verifier, bucket, window=window, probe_key=probe_key,
                    rows=rows, evidence=evidence, roles=roles,
                )
    if state is not None:
        state["applied"] = applied
    return observations if applied.removed else {}


def _confirmed_reads(
    verifier: Verifier,
    bucket: str,
    *,
    window: str,
    probe_key: str,
    rows: list[tuple],
    evidence: list[str],
    roles: tuple = ("foreign", "operator"),
) -> dict[str, Observation]:
    """Both roles' reads, taken twice and required to agree.

    THE READBACK PROVES THE DOCUMENT REACHED THE NODE THAT ANSWERED
    `GetBucketPolicy`. It does not prove the node answering `GetObject` has it.
    Nothing here establishes this endpoint's consistency guarantees, and the
    direction of the risk is why that is not a reason to skip the check: every
    way a just-applied policy can fail to be visible yet biases a read toward
    `allowed`, and `allowed` is what the strongest readings in this file are
    drawn from. A read that has not settled is an observation this run cannot
    use, so a disagreement yields no observations rather than the second answer.
    """
    first = {
        role: _observe(verifier, bucket, f"window {window}", role, probe_key)
        for role in roles
    }
    for observation in first.values():
        evidence.append(observation.line())

    _sleep(SETTLE_SECONDS)

    second = {
        role: _observe(verifier, bucket, f"window {window} again", role, probe_key)
        for role in roles
    }
    for observation in second.values():
        evidence.append(observation.line())

    unsettled = [
        f"{role} read {first[role].outcome} and then {second[role].outcome}"
        for role in first
        if first[role].outcome != second[role].outcome
    ]
    rows.append(
        (
            f"probe {window}: the same read twice, {SETTLE_SECONDS:g}s apart, agrees",
            PASS if not unsettled else INCONCLUSIVE,
            ""
            if not unsettled
            else "the policy was applied and read back, but the object reads under it did "
            "not settle on one answer (" + "; ".join(unsettled) + "). A read that changed "
            "between two attempts says nothing about the policy, and the way it changes is "
            "towards `allowed`, which is the direction that produces the loudest readings "
            "here. No verdict is drawn from this window.",
            "the readback proves the document reached the node that served it, not the one "
            "serving the object",
            bool(unsettled),
        )
    )
    return {} if unsettled else first


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

    if ABSENT_PRINCIPAL in (operator_arn, foreign_arn):
        # It is a synthetic ARN in an all-zeroes account, so this cannot happen
        # -- but window D's whole job is naming a principal that is definitely
        # not us, and a window that silently named one of the two real keys
        # would report `NAME_IS_DECORATION` for an engine that resolves per key.
        raise VerifierError(
            "the absent-principal probe names a credential this run is using, so window D "
            "would not be asking about an absent principal at all"
        )

    # EVERY DOCUMENT IS ASSERTED REVERSIBLE BEFORE ANYTHING IS WRITTEN. Doing it
    # per window would raise after the probe objects exist, and a VerifierError
    # escaping this function skips the cleanup that removes them -- exactly the
    # hazard `Verifier.request`'s docstring exists to name.
    plan = {
        window: diagnostic_policy(bucket, sid, principal)
        for window, sid, principal in _diagnostic_plan(operator_arn, foreign_arn)
    }
    for policy in plan.values():
        assert_probe_policy_is_reversible(policy, bucket)

    free, refusal, leftover = _policy_slot_is_free(
        verifier,
        bucket,
        replace_existing=replace_existing,
        own_ids=probe_family_ids(bucket),
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
        name: f"{PROBE_PREFIX}engine-{name.lower()}-{uuid.uuid4().hex}.txt" for name in plan
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

    # The probe objects exist from here, so nothing below may return without
    # removing them.
    try:
        verdict = _read_the_engine(
            verifier,
            bucket,
            plan=plan,
            keys=keys,
            rows=rows,
            evidence=evidence,
            masks=masks,
        )
    finally:
        rows.extend(_cleanup_rows(verifier, bucket))
    return rows, evidence, VERDICT_TEXT[verdict]


# The subject of every window, and the key every reading is drawn from. Named
# once so the rows below cannot drift from the classifier's arguments.
_SUBJECT = "foreign"


def _read_the_engine(
    verifier: Verifier,
    bucket: str,
    *,
    plan: dict,
    keys: dict,
    rows: list[tuple],
    evidence: list[str],
    masks: dict[str, str],
) -> str:
    """Windows B, C and D, then A only where the answer turns on it.

    NO WINDOW ENDS THIS ON ITS OWN READING. Each contributes one read by the
    subject key; the verdict comes from the combination. That is why window A no
    longer runs first: as a gate it declared `NOT_ENFORCED` -- a claim about the
    whole account, and the claim that sends the estate to per-tenant projects --
    from one document shape, and an engine that resolves named ARNs while
    ignoring `Principal: "*"` is a world where the fence is fully buildable and
    would have been reported as one where no policy works at all.
    """
    observed: dict[str, dict] = {}
    for window in (WINDOW_B, WINDOW_C, WINDOW_D):
        observations = _window(
            verifier,
            bucket,
            window=window,
            policy=plan[window],
            probe_key=keys[window],
            rows=rows,
            evidence=evidence,
            masks=masks,
        )
        if not observations:
            return UNEXPLAINED
        observed[window] = observations
    reads = {window: observations[_SUBJECT].outcome for window, observations in observed.items()}

    rows.append(_window_row(WINDOW_B, reads, "reaches the key it names", "denied"))
    rows.append(_window_row(WINDOW_C, reads, "spares the key it does not name", "allowed"))
    rows.append(
        _window_row(
            WINDOW_D,
            reads,
            "naming an absent principal in another account spares this key",
            "allowed",
            note="the row that separates `every key here is one principal` from `the "
            "Principal element is never read`, which differ on what can replace the fence",
        )
    )

    # WINDOW C DETECTS THE BUCKET OWNER'S EXEMPTION WITHOUT WINDOW A. Its
    # statement names the operator, so on an engine that resolves names -- which
    # window B is what establishes -- the operator must be denied by it. An
    # operator that reads through a Deny naming the operator is one the engine
    # spares. That matters because window A no longer runs in most readings, and
    # this finding would otherwise be visible only in the ones where it does.
    owner_exempt = (
        reads[WINDOW_B] == "denied" and observed[WINDOW_C]["operator"].outcome == "allowed"
    )

    wildcard = ""
    if not needs_wildcard(reads[WINDOW_B], reads[WINDOW_C], reads[WINDOW_D]):
        rows.append(
            (
                "probe A: a Deny naming EVERY principal was not needed",
                PASS,
                "",
                "the only window that denies the operator by construction, so it is sent "
                "only where the reading turns on it -- which the rows above settle",
                False,
            )
        )
    else:
        observations = _window(
            verifier,
            bucket,
            window=WINDOW_A,
            policy=plan[WINDOW_A],
            probe_key=keys[WINDOW_A],
            rows=rows,
            evidence=evidence,
            masks=masks,
        )
        if not observations:
            return UNEXPLAINED
        wildcard = observations[_SUBJECT].outcome
        seen = wildcard_observation(wildcard, observations["operator"].outcome)
        rows.append(
            (
                "probe A: a Deny naming every principal reaches this key",
                PASS if wildcard == "denied" else FAIL,
                ""
                if wildcard == "denied"
                else "no ARN denied anybody and neither did `*`, so nothing this run stored "
                "was enforced against anyone",
                "sent because no named principal denied anything, which is the one reading "
                "that turns on it",
                False,
            )
        )
        # In this cell no ARN resolved, so window C cannot speak to the owner's
        # status and the wildcard is the only statement that reached anybody.
        owner_exempt = owner_exempt or seen == WILDCARD_SPARES_THE_OWNER

    if owner_exempt:
        # A real finding, and the reason the operator's reads are corroboration
        # rather than deciding evidence anywhere in this file.
        rows.append(
            (
                "a Deny that names the operator also reaches the operator",
                FAIL,
                "the operator read an object through a Deny that covers it, so this engine "
                "exempts the bucket owner from its own bucket policies. Every reading here "
                "is drawn from the other key's reads, so the one below stands -- but no "
                "fence could ever constrain the key that owns the bucket",
                "",
                False,
            )
        )

    verdict = principal_verdict(reads[WINDOW_B], reads[WINDOW_C], reads[WINDOW_D], wildcard)
    status = _finding_status(FENCE_IS_POSSIBLE[verdict], verdict == UNEXPLAINED)
    rows.append(
        (
            "A BUCKET POLICY CAN FENCE ONE KEY FROM ANOTHER HERE",
            status,
            ""
            if status == PASS
            else "the observations do not fit any engine this can name -- see the verdict below"
            if status == INCONCLUSIVE
            else "see the verdict below",
            "",
            status != PASS,
        )
    )
    return verdict


def _window_row(window: str, reads: dict, claim: str, expected: str, note: str = "") -> tuple:
    """One window's contribution, stated as what it observed.

    A row here is never a verdict. `expected` is what that window shows on an
    engine where a fence is buildable, so the PASS/FAIL is a comparison against
    that one engine and nothing more -- the reading is `principal_verdict`'s.
    """
    outcome = reads[window]
    return (
        f"probe {window}: a Deny {claim}",
        PASS if outcome == expected else FAIL,
        "" if outcome == expected else f"it was {outcome}",
        note or "one observation; the reading below is drawn from all of them together",
        False,
    )


# --------------------------------------------------------------------------
# THE OTHER HALF: is a bucket policy evaluated for a principal OUTSIDE this
# bucket's project?
#
# The diagnostic above answers what a policy does to the bucket-owning project's
# own keys. Every reader in it is such a key, so its strongest reading -- no
# document reached anybody -- is equally consistent with two engines:
#
#   1. Policies are stored and never evaluated, for anyone.
#   2. Policies ARE evaluated, and the bucket owner's own keys bypass evaluation.
#
# From inside the project those are the same output. They are not the same
# world: under (2) a separate project per tenant plus a cross-project `Allow` is
# a working, documented isolation mechanism, and native public bucket visibility
# is the anonymous-read half of it; under (1) neither exists and this provider's
# own published examples do not function.
#
# THE PROVIDER'S DOCUMENTATION MAKES (2) THE ONE TO TEST. Its S3-credentials FAQ
# documents cross-project grants as a supported approach, with an example whose
# principal ARN carries the CREDENTIAL's project id rather than the bucket's.
# Its buckets FAQ states that a public bucket is implemented by automatically
# applying access policies that grant anonymous read while leaving listing
# denied -- a live policy, evaluated for a principal that is not merely foreign
# but unauthenticated. An engine that ignored policies wholesale could not offer
# either feature.
#
# SO THE SUBJECT HAS TO BE A KEY IN ANOTHER PROJECT, AND THE MODE REFUSES TO RUN
# WITHOUT ONE. A grantee that resolves to the bucket's own account re-creates the
# exact blind spot this exists to close, and would do it silently: every row
# would still print, and the verdict would be about owner keys again.
#
# TWO SHAPES, BECAUSE A SHAPE IS A HYPOTHESIS HERE.
#
#   Window G1 -- `Allow s3:GetObject` to the grantee's ARN, on the probe prefix
#     only. The narrowest grant that could answer the question.
#   Window G2 -- the provider's documented cross-project document verbatim: the
#     principal as a STRING rather than a list, `s3:*` rather than one action,
#     and BOTH the bucket ARN and the object ARN in `Resource`.
#
# An implementation that pattern-matches its own published template honours G2
# and ignores G1, and "the documented shape is the only one that works" is a
# finding that changes how every policy in this estate must be written. A run
# that sent one shape would report `no grant is possible` for that world, which
# is the same class of mistake as the wildcard gate this file already removed.
#
# BOTH ARE `Allow`-ONLY, AND THAT IS ASSERTED, NOT ARGUED.
# `assert_probe_policy_grants_only` refuses any statement whose `Effect` is not
# exactly `Allow` before either document is sent.
#
# WHY AN `Allow` CANNOT LOCK THIS BUCKET IS AN EMPIRICAL CLAIM HERE, NOT AN
# APPEAL TO S3 SEMANTICS. "An Allow grants and never refuses" is how AWS and
# stock Ceph behave, and this engine is neither -- the whole reason this file
# exists is that its principal handling matches no documented implementation, so
# an argument from semantics is worth little on it. What carries the safety case
# is the live run recorded on the predecessor issue: four `Deny` documents were
# applied to THIS bucket, including one naming `Principal: "*"`, each stored
# verbatim and confirmed present, and the operator key kept `PutBucketPolicy`
# and `DeleteBucketPolicy` through all four PUT/DELETE cycles. A document that
# denies nobody is strictly weaker than a `Principal: "*"` Deny that was
# observed constraining nobody. That is the evidence; the `Effect` rule is what
# keeps the documents inside it.
#
# WHAT G2 COSTS, STATED WHERE THE SHAPE IS DEFINED. It grants the grantee `s3:*`
# on the whole bucket for the seconds the window is open. That is acceptable for
# one reason and one only: THE GRANTEE IS OUR OWN KEY. Swap a third party's ARN
# in and the same document hands them full control of the bucket. The guard
# against that is structural -- the principal must equal the ARN this run
# resolved from the grantee credential itself -- and on top of it the operator
# has to acknowledge the grantee explicitly with --grantee-is-ours before
# anything is written.
#
# AND THE REMOVAL IS OBSERVED, NOT ASSUMED. After each window the grantee reads
# again, and must be denied. Without that read, "the grant worked" and "the
# grant was never what allowed it" are indistinguishable, and the next run
# starts from a bucket whose state nobody established.
# --------------------------------------------------------------------------

GRANT_WINDOW_SCOPED = "G1"
GRANT_WINDOW_DOCUMENTED = "G2"

# The only two action spellings a grant probe may carry: the narrow window's
# single read action, and the wildcard the provider's published document uses.
#
# `s3:*` SUBSUMES EVERY DESTRUCTIVE ACTION, so this list does not bound what the
# grantee could do in window G2 -- it bounds what a FUTURE EDIT can write. A
# document naming `s3:DeleteBucket` or `s3:DeleteObject` explicitly is one
# nobody has reasoned about, and it would pass every other rule here; `s3:*` is
# accepted only because it is the published shape verbatim, which is the entire
# point of that window, and because the grantee is our own key for the seconds
# it is live.
GRANT_ACTIONS = frozenset({"s3:GetObject", "s3:*"})

GRANT_SUBJECT = "grantee"

# What a document from this mode does if it is ever left on the bucket. Handed
# to `_temporary_policy` in place of its default, which describes a Deny.
GRANT_CONSEQUENCE = (
    "IT IS A GRANT: it leaves a credential in another project holding access to this "
    "bucket that it is not meant to have, so removing it is urgent rather than tidy."
)

# The readings. One per coherent engine, over the two shapes.
CROSS_PROJECT_ALLOW_GRANTS = "cross-project-allow-grants"
ONLY_THE_DOCUMENTED_SHAPE_GRANTS = "only-the-documented-shape-grants"
ONLY_THE_SCOPED_SHAPE_GRANTS = "only-the-scoped-shape-grants"
NO_CROSS_PROJECT_GRANT = "no-cross-project-grant"
NO_PROJECT_BOUNDARY = "no-project-boundary"
GRANT_UNPROVEN = "grant-unproven"

# Whether this run OBSERVED a bucket policy reaching a principal outside the
# bucket's project. Phrased as what was demonstrated rather than as what is
# true, so the two readings that establish nothing are `False` here for the same
# reason an INCONCLUSIVE check is not a pass -- and a reading added without an
# entry fails loudly rather than defaulting to "yes, it works".
GRANT_DEMONSTRATED = {
    CROSS_PROJECT_ALLOW_GRANTS: True,
    ONLY_THE_DOCUMENTED_SHAPE_GRANTS: True,
    ONLY_THE_SCOPED_SHAPE_GRANTS: True,
    NO_CROSS_PROJECT_GRANT: False,
    NO_PROJECT_BOUNDARY: False,
    GRANT_UNPROVEN: False,
}

GRANT_VERDICT_TEXT = {
    CROSS_PROJECT_ALLOW_GRANTS: (
        "A BUCKET POLICY REACHES A PRINCIPAL OUTSIDE THIS BUCKET'S PROJECT.\n"
        "A key in another project could not read this bucket with no policy on it, could\n"
        "read it under an `Allow` naming its ARN on one object prefix, and could read it\n"
        "again under the provider's documented cross-project shape. Both shapes granted,\n"
        "and each grant was withdrawn when its document came off.\n\n"
        "Bucket policies ARE evaluated here, for principals outside the bucket's project,\n"
        "and the engine is not merely matching one published template. Read this next to\n"
        "the earlier finding rather than instead of it: both hold at once -- evaluation\n"
        "happens, and the bucket owner's own keys bypass it.\n\n"
        "A project per tenant with a cross-project grant is therefore a documented\n"
        "mechanism that works as deployed, and native public-bucket visibility is the\n"
        "anonymous-read half of the same machinery. CHOOSING IT IS AN ARCHITECTURE\n"
        "DECISION FOR THE PLATFORM OWNER, not something to infer from this output. Nothing\n"
        "here rehabilitates fencing two keys inside one project: do not apply that fence.\n"
        "Record this output on the issue."
    ),
    ONLY_THE_DOCUMENTED_SHAPE_GRANTS: (
        "ONLY THE DOCUMENTED GRANT SHAPE REACHES A FOREIGN PRINCIPAL.\n"
        "An `Allow s3:GetObject` naming the grantee's ARN on one object prefix granted\n"
        "nothing. The same grantee then read the same object under the provider's\n"
        "documented cross-project document -- principal as a string, `s3:*`, and both the\n"
        "bucket and object ARNs in `Resource`.\n\n"
        "Policies ARE evaluated for principals outside this project, so the account-wide\n"
        "`not enforced` claim is wrong. But this engine is honouring the published\n"
        "TEMPLATE rather than the semantics behind it, and a document that merely means\n"
        "the same thing is inert.\n\n"
        "EVERY POLICY WRITTEN FOR THIS PROVIDER MUST THEREFORE BE THE DOCUMENTED SHAPE\n"
        "VERBATIM. Which element carries the difference -- the principal form, the action\n"
        "wildcard, or the resource pair -- is not settled by this run, and is worth one\n"
        "more experiment before anything is built on it. Do not apply a fence inside one\n"
        "project. Record this output on the issue."
    ),
    ONLY_THE_SCOPED_SHAPE_GRANTS: (
        "A NARROW GRANT REACHES A FOREIGN PRINCIPAL AND THE DOCUMENTED SHAPE DOES NOT.\n"
        "An `Allow s3:GetObject` naming the grantee's ARN on one object prefix granted the\n"
        "read. The provider's own documented cross-project document, sent to the same\n"
        "grantee on the same bucket in the same run, did not.\n\n"
        "Policies ARE evaluated for principals outside this project, so the account-wide\n"
        "`not enforced` claim is wrong -- and the provider's published example does not\n"
        "work as deployed on this cluster, which is a defect in their documentation or\n"
        "their engine.\n\n"
        "Raise it with the provider carrying this output verbatim: it is a reproduction of\n"
        "their own example failing beside a narrower one that works. Until it is answered,\n"
        "treat the narrow shape as the only one demonstrated and do not build on the\n"
        "documented one. Do not apply a fence inside one project. Record this output on\n"
        "the issue."
    ),
    NO_CROSS_PROJECT_GRANT: (
        "NO CROSS-PROJECT GRANT REACHED THIS BUCKET, IN EITHER SHAPE.\n"
        "A key in another project was denied with no policy on the bucket, denied under an\n"
        "`Allow` naming its ARN on one object prefix, and denied under the provider's own\n"
        "documented cross-project document. Both documents were stored verbatim, confirmed\n"
        "present while live, and removed.\n\n"
        "TWO CAUSES FIT THIS, and this run does not tell them apart. Either the provider's\n"
        "documented cross-project grant does not work as deployed here -- or the grantee\n"
        "ARN this run built did not resolve, because the account id read from the grantee's\n"
        "own `ListAllMyBuckets` is not the Console project id the ARN needs. The tool\n"
        "cannot check the second from inside; §0b of the runbook has you confirm the\n"
        "grantee's project id in the Console before trusting this verdict as the provider's\n"
        "fault. RULE THE ARN OUT FIRST.\n\n"
        "If the ARN is confirmed right, then taken with the earlier finding that no shape\n"
        "constrains the bucket owner's own keys, no bucket policy this estate can write has\n"
        "been observed doing anything at all -- and native public-bucket visibility, which\n"
        "the same documentation says is an automatically applied anonymous-read policy, is\n"
        "now UNPROVEN rather than assumed. Test it directly before any media design depends\n"
        "on it.\n\n"
        "Do not apply any bucket policy anywhere. Record this output VERBATIM on the\n"
        "issue: with the ARN confirmed, it is the reproduction a support request needs, of\n"
        "the provider's own documentation failing on their own cluster."
    ),
    NO_PROJECT_BOUNDARY: (
        "THE PROJECT BOUNDARY THIS PROBE ASSUMES DOES NOT EXIST.\n"
        "With no policy on the bucket at all, a credential resolving to a DIFFERENT\n"
        "storage account read an object in this one. No window was sent: a grant cannot be\n"
        "shown to have granted anything to a principal that already had the access.\n\n"
        "If this holds up it is the most consequential line in this file, because a\n"
        "separate project is the one isolation boundary the estate still believes in.\n"
        "Check first that the grantee credential is the one you meant -- both accounts are\n"
        "printed above, and they differ, so this is not the same-project refusal -- and\n"
        "that the object read was this run's own probe object.\n\n"
        "Do not apply any policy, and do not provision a tenant on the assumption that a\n"
        "project separates anything, until it has been re-run and either reproduced or\n"
        "explained. Record this output on the issue."
    ),
    GRANT_UNPROVEN: (
        "THIS RUN PROVED NOTHING ABOUT A CROSS-PROJECT GRANT.\n"
        "Either the run refused before it sent anything -- an account that would not\n"
        "resolve, a grantee in the bucket's own project, a grantee nobody acknowledged, or\n"
        "a bucket already carrying a policy -- or a window produced no evidence that can be\n"
        "read: the document was refused, what came back off the bucket was not what was\n"
        "sent, two reads of the same object disagreed, or the document could not be taken\n"
        "off again. The rows above say which, and that row is the one to act on.\n\n"
        "AN UNPROVEN RUN IS NOT A NEGATIVE RESULT. Do not record it as one and do not\n"
        "apply any policy on the strength of it. If a probe document is still on the\n"
        "bucket, that row carries the command that removes it and it comes before\n"
        "anything else -- a leftover document from this mode is a GRANT. Record this\n"
        "output on the issue."
    ),
}


def foreign_grant_policy_id(bucket: str) -> str:
    return f"foreign-grant-probe-{bucket}"


def scoped_grant_policy(bucket: str, grantee_arn: str) -> dict:
    """The narrowest grant that could answer the question.

    One action, one object prefix, the principal as a list -- the spelling this
    repository's own generators use everywhere else. If this grants and the
    documented shape does not, the engine is honouring semantics; if the
    reverse, it is matching a template.
    """
    return {
        "Version": "2012-10-17",
        "Id": foreign_grant_policy_id(bucket),
        "Statement": [
            {
                "Sid": "ProbeGrantScopedRead",
                "Effect": "Allow",
                "Principal": {"AWS": [grantee_arn]},
                "Action": "s3:GetObject",
                "Resource": f"arn:aws:s3:::{bucket}/{PROBE_PREFIX}*",
            }
        ],
    }


def documented_grant_policy(bucket: str, grantee_arn: str) -> dict:
    """The provider's documented cross-project grant, verbatim.

    Three things are deliberately NOT narrowed, because narrowing any of them
    would make this a different document from the one the documentation
    publishes and the window would stop answering its question: the principal is
    a bare STRING rather than a list, the action is `s3:*`, and `Resource` names
    the bucket ARN as well as the object ARN.

    THAT MEANS THIS DOCUMENT GRANTS THE GRANTEE FULL CONTROL OF THE BUCKET for
    the seconds it is live -- object writes, object deletes, and the bucket
    policy itself. It is acceptable for exactly one reason: the grantee is our
    own credential, in our own estate, and the run has already refused to
    proceed unless the ARN below is the one it resolved from that credential.
    ANYONE POINTING THIS AT A THIRD PARTY'S ARN IS HANDING THEM THE BUCKET, and
    `assert_probe_policy_grants_only` is what stops it happening by edit rather
    than by intent.
    """
    return {
        "Version": "2012-10-17",
        "Id": foreign_grant_policy_id(bucket),
        "Statement": [
            {
                "Sid": "ProbeGrantDocumentedShape",
                "Effect": "Allow",
                "Principal": {"AWS": grantee_arn},
                "Action": "s3:*",
                "Resource": [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"],
            }
        ],
    }


# What `--dry-run` puts where the ARN would be. It reads no credential, so there
# is no ARN to resolve; named once so the dry run and this module cannot drift
# into printing different placeholders for the same thing.
GRANTEE_ARN_PLACEHOLDER = "<the grantee key's ARN>"


def _grant_plan() -> tuple:
    """The windows and their builders, in the order they run.

    One definition, so the plan `--dry-run` prints is the plan the run sends.
    It takes no ARN: each caller applies its own -- the run the one it resolved
    from the grantee credential, the dry run `GRANTEE_ARN_PLACEHOLDER` -- and a
    parameter here would have been threaded through and then ignored.

    The narrow shape goes first: it is the smaller grant, and if the engine
    honours semantics at all it is the one that answers the question at the
    lower cost.
    """
    return (
        (GRANT_WINDOW_SCOPED, scoped_grant_policy),
        (GRANT_WINDOW_DOCUMENTED, documented_grant_policy),
    )


def assert_probe_policy_grants_only(policy: dict, bucket: str, grantee_arn: str = "") -> None:
    """Refuse a grant probe that could refuse anything, or reach anyone else.

    The parallel of `assert_probe_policy_is_reversible`, and separate from it
    because the two probe families are safe for opposite reasons. A `Deny` probe
    is safe when it names no bucket-resource action; an `Allow` probe is safe
    when it is an `Allow` at all, and dangerous when it names the wrong
    principal. Sharing one function would mean one set of rules that had to be
    weak enough for both, which is how a guard stops guarding.

    Four rules, each closing a way this could stop being harmless:

      1. EVERY STATEMENT'S `Effect` IS EXACTLY `Allow`. An `Allow` cannot refuse
         anything, so no document from this mode can lock a bucket -- and that
         has to be a property of the code rather than of the two documents that
         happen to be defined above. A `Deny` refused here is also the brief's
         "no bucket-resource action in a deny" rule, satisfied by there being no
         deny to check.
      2. NO `NotPrincipal`. On AWS semantics an `Allow` with `NotPrincipal`
         grants to every principal EXCEPT the named one, which includes the
         anonymous caller: it would make the bucket world-readable for the life
         of the window. That is the opposite of a scoped grant and it arrives by
         changing one word.
      3. THE PRINCIPAL NAMES THE GRANTEE UNDER `AWS` AND CARRIES NO OTHER KEY.
         No wildcard, no second ARN, no substitute -- and no second principal
         TYPE beside `AWS`. Both routes here read only `Principal["AWS"]`, so a
         `{"AWS": [grantee], "CanonicalUser": "*"}` or `{"AWS": grantee,
         "Service": "*"}` would satisfy the identity check while granting a
         second principal neither route ever looks at. A `*` under `AWS` is
         anonymous public access, which this probe is explicitly not for; a
         different ARN is a grant to somebody who did not consent to it. Checked
         against the ARN the run resolved from the grantee's own credential, so
         a hand-edited document is refused by the same rule as a typo.
      4. EVERY RESOURCE IS THIS BUCKET OR SOMETHING INSIDE IT, AND NONE USES
         `NotResource`. The blast radius of a `Resource` the engine ignores is
         our own key reading our own bucket; the blast radius of a `Resource`
         naming the WRONG bucket is a grant on a bucket nobody was reasoning
         about. `NotResource` is the third inversion beside `NotPrincipal` and
         `NotAction` -- `decide` ignores it, so on an engine that honours it an
         `s3:*` grant would apply to everything EXCEPT the named resource, i.e.
         to `branchleft-tenant-pulumi-state`.
      5. EVERY ACTION IS ONE OF `GRANT_ACTIONS`, AND NONE USES `NotAction`. The
         inversion `NotPrincipal` performs on the noun, `NotAction` performs on
         the verb. The allow-list bounds what a future edit can write rather
         than what window G2 can do -- `s3:*` already subsumes every destructive
         action, and is accepted only because it is the published shape
         verbatim; see `GRANT_ACTIONS`.
      6. THE DOCUMENT'S `Id` IS THIS MODE'S OWN. A grant document under any
         other Id would not be recognised as a leftover by the next run, which
         reads the Id to tell its own probe from a stranger's fence.

    Then the whole document goes to `_refuse_an_anonymous_grant`, which asks the
    same property as an evaluation question rather than a structural one. Two
    independent routes to one invariant is the intent, not redundancy: rules
    that were never written catch nothing.

    `grantee_arn` is optional only so the shapes can be asserted without a live
    credential in a test or a dry run. Rule 3's identity half is skipped when it
    is empty -- its wildcard half is not -- and the run itself always passes it.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    expected_id = foreign_grant_policy_id(bucket)
    if policy.get("Id") != expected_id:
        raise VerifierError(
            f"grant probe document's Id is {policy.get('Id')!r}, not {expected_id!r}; a "
            f"document under any other Id would not be recognised as this mode's leftover "
            f"by the next run"
        )
    statements = policy.get("Statement", [])
    # THE SHAPE IS CHECKED BEFORE THE CONTENT, because every rule below reads
    # elements off a mapping and a document that is not one would make the guard
    # raise an AttributeError instead of refusing. Both outcomes stop the run
    # before anything is written, but only one of them tells an operator what
    # was wrong -- and a guard that crashes on a one-character change to a
    # bracket is not the property-of-the-code this docstring claims.
    if not isinstance(statements, list) or not statements:
        raise VerifierError(
            f"grant probe policy's Statement is {type(statements).__name__}, not a non-empty "
            f"list; nothing here can reason about that document"
        )
    for statement in statements:
        if not isinstance(statement, dict):
            raise VerifierError(
                f"grant probe statement is {type(statement).__name__}, not a mapping"
            )
        if statement.get("Effect") != "Allow":
            raise VerifierError(
                f"grant probe statement has Effect {statement.get('Effect')!r}; only 'Allow' "
                f"is permitted here, because an Allow cannot refuse anything and that is the "
                f"whole reason this mode is safe to point at a production bucket"
            )
        if "NotPrincipal" in statement:
            raise VerifierError(
                "grant probe statement uses NotPrincipal, which on an Allow grants every "
                "principal EXCEPT the one named -- including the anonymous caller. That "
                "would make the bucket world-readable while the window is open"
            )

        # THE PRINCIPAL IS PARSED BY TYPE, NOT COERCED. `list()` of a mapping
        # yields its KEYS, so `{"AWS": {"<the grantee arn>": 1}}` would satisfy
        # the identity rule below while the document's real principal is a map
        # no engine resolves -- a document that passed the guard and means
        # something nobody checked. `list()` of an int raises instead, which
        # stops the run with a traceback rather than a refusal. Both are shapes
        # this guard has to name, so both are named.
        principal = statement.get("Principal")
        if not isinstance(principal, dict) or set(principal) != {"AWS"}:
            # `set(principal) != {"AWS"}` refuses BOTH a non-`AWS` type and a
            # SECOND type beside it. Both routes read only `Principal["AWS"]`, so
            # a `{"AWS": [grantee], "CanonicalUser": "*"}` would pass the
            # identity check while granting a principal neither route inspects.
            raise VerifierError(
                f"grant probe statement's Principal is {principal!r}; it must be a mapping "
                f"whose only key is 'AWS', or a second principal type would grant someone "
                f"neither guard here ever looks at"
            )
        named = principal["AWS"]
        if isinstance(named, str):
            names = [named]
        elif isinstance(named, list) and all(isinstance(name, str) for name in named):
            names = named
        else:
            raise VerifierError(
                f"grant probe statement's Principal.AWS is {named!r}; it must be an ARN or a "
                f"list of ARNs"
            )
        if not names:
            raise VerifierError("grant probe statement names no Principal")
        if "*" in names:
            raise VerifierError(
                "grant probe statement names Principal '*', which grants anonymous access "
                "to this bucket. Anonymous grants are not what this mode tests and the "
                "exposure is not worth the window"
            )
        if grantee_arn and names != [grantee_arn]:
            raise VerifierError(
                f"grant probe statement names {names!r} rather than the grantee ARN this "
                f"run resolved. A grant reaches whoever it names, so the only principal "
                f"that may appear here is the credential the operator confirmed is ours"
            )

        if "NotResource" in statement:
            raise VerifierError(
                "grant probe statement uses NotResource, the third inversion beside "
                "NotPrincipal and NotAction. `decide` ignores it, so on an engine that "
                "honours it an s3:* grant would apply to every resource EXCEPT the one "
                "named -- branchleft-tenant-pulumi-state included"
            )
        resource = statement.get("Resource")
        if isinstance(resource, str):
            resources = [resource]
        elif isinstance(resource, list) and all(isinstance(entry, str) for entry in resource):
            resources = resource
        else:
            raise VerifierError(
                f"grant probe statement's Resource is {resource!r}; it must be an ARN or a "
                f"list of ARNs"
            )
        if not resources:
            raise VerifierError("grant probe statement names no Resource")
        for entry in resources:
            if entry != bucket_arn and not entry.startswith(f"{bucket_arn}/"):
                raise VerifierError(
                    f"grant probe reaches {entry!r}, which is not {bucket} or an object in "
                    f"it -- a grant on a bucket this run is not reasoning about"
                )

        if "NotAction" in statement:
            raise VerifierError(
                "grant probe statement uses NotAction, which grants every action EXCEPT the "
                "one named -- the same inversion as NotPrincipal, applied to the verb"
            )
        action = statement.get("Action")
        if isinstance(action, str):
            actions = [action]
        elif isinstance(action, list) and all(isinstance(entry, str) for entry in action):
            actions = action
        else:
            raise VerifierError(
                f"grant probe statement's Action is {action!r}; it must be an action or a "
                f"list of them"
            )
        if not actions:
            raise VerifierError("grant probe statement names no Action")
        for entry in actions:
            if entry not in GRANT_ACTIONS:
                raise VerifierError(
                    f"grant probe grants {entry!r}, which is not one of "
                    f"{sorted(GRANT_ACTIONS)}. `s3:*` is permitted only because it is the "
                    f"provider's published document verbatim; a narrower document naming a "
                    f"destructive action explicitly is one nobody has reasoned about, and it "
                    f"would authorise it against the bucket holding the estate's only "
                    f"offsite backups"
                )

    _refuse_an_anonymous_grant(policy, bucket)


# What the anonymous caller must not gain from any document this mode sends.
# Read and list ARE the exposure a public bucket is; the policy actions are the
# only way an exposure could outlive the window it was opened in.
GRANT_EXPOSURE_ACTIONS = ("s3:GetObject", "s3:ListBucket", "s3:PutBucketPolicy")


def _refuse_an_anonymous_grant(policy: dict, bucket: str) -> None:
    """The same property asked as an EVALUATION question, not a structural one.

    The rules above read elements. This asks `decide` -- the repository's model
    of S3 evaluation, and the same function the pre-flight uses to decide
    lockout -- who can actually do what under this document. It reaches the
    refusals above by a different route, which is the point: a structural rule
    that was never written catches nothing, and a shape nobody anticipated then
    has two chances to be stopped rather than one. `Principal: "*"` and an
    `Allow` carrying `NotPrincipal` both grant the anonymous caller, both are
    already refused above, and both are caught again here.

    THE ANONYMOUS CALLER IS THE ONLY PRINCIPAL THIS CAN BE ASKED ABOUT, and the
    reason is in `decide` itself: its default for any `arn:aws:iam:::user/`
    principal is `allow`, because this provider grants every key in a project
    access to every bucket in it. So asking about a stranger's ARN returns
    `allow` for an empty document as readily as for a hostile one, and a check
    built on it would refuse everything. `anonymous` defaults to `deny`, so an
    `allow` here can only have come from a statement in this document.

    THE RESOURCES ASKED ABOUT ARE CONCRETE, and that is not a detail. `decide`
    matches a statement's `Resource` PATTERN against the resource it is given,
    so asking about `arn:aws:s3:::<bucket>/*` asks "does this document cover an
    object literally named `*`" -- which a statement scoped to `fence-probe/*`
    does not, and the check would pass a document that grants the world every
    probe object. One real object inside the probe prefix and one outside it
    are the two places an exposure lands: the prefix this mode writes to, and
    the backups the bucket exists for.

    It is a model rather than the live engine, and it is asked about a document
    that has not been sent -- so it can refuse, and it can never license.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    probed = (
        bucket_arn,
        f"{bucket_arn}/{PROBE_PREFIX}probe.txt",
        f"{bucket_arn}/dumps/a-real-backup.sql.age",
    )
    for resource in probed:
        for action in GRANT_EXPOSURE_ACTIONS:
            if decide(policy, ANONYMOUS_OWNER, action, resource) != "allow":
                continue
            raise VerifierError(
                f"evaluated against this document, the anonymous caller gains {action} on "
                f"{resource}. That is a public {bucket} for as long as the window is open, "
                f"and no probe here is permitted to expose a bucket to anyone. The "
                f"structural rules did not catch it, so treat this as a shape nobody has "
                f"reasoned about rather than a rule to relax"
            )


def grant_verdict(scoped: str, documented: str) -> str:
    """How this engine treats a cross-project grant, per shape.

    Both arguments are the SAME key -- one in another project -- reading the
    same object under two documents that differ only in how the grant is
    spelled. Neither row is a verdict on its own: a single `allowed` says the
    engine evaluated something, and which shapes it evaluated is what decides
    whether a policy written by this estate would work at all.
    """
    reads = (scoped, documented)
    if any(read not in ("allowed", "denied") for read in reads):
        return GRANT_UNPROVEN
    if reads == ("allowed", "allowed"):
        return CROSS_PROJECT_ALLOW_GRANTS
    if reads == ("denied", "allowed"):
        return ONLY_THE_DOCUMENTED_SHAPE_GRANTS
    if reads == ("allowed", "denied"):
        return ONLY_THE_SCOPED_SHAPE_GRANTS
    return NO_CROSS_PROJECT_GRANT


BASELINE_HOLDS = "baseline-holds"
BASELINE_NO_BOUNDARY = "baseline-no-boundary"
BASELINE_UNUSABLE = "baseline-unusable"


def _grant_baseline(
    verifier: Verifier, bucket: str, *, keys: dict, rows: list[tuple], evidence: list[str]
) -> str:
    """With no policy on the bucket: the grantee is denied, the operator is not.

    TWO FACTS, AND THE RUN NEEDS BOTH, on every probe object rather than on one
    of them. The operator's read is the control -- a grantee denial means
    nothing if the object is unreadable to everybody, which is what a mistyped
    key, a missing object and an unreachable endpoint all look like from the
    grantee's side alone. The grantee's denial is the premise: a grant can only
    be shown to have granted something to a principal that did not already have
    it.

    Returns which of the three outcomes this is, rather than a boolean. A
    grantee that reads the bucket with nothing on it is a FINDING and the
    loudest one this mode can print; a control that failed is a broken run.
    Collapsing them into `False` and recovering the difference by reading the
    rows back would make the verdict depend on a row's wording.

    THE GRANTEE'S BASELINE READ IS TAKEN TWICE AND HAS TO AGREE, and it is the
    only read here that is. Every other read in this mode is either a control
    whose failure direction is safe -- the operator's, which produces
    INCONCLUSIVE -- or already paired by `_confirmed_reads`. This one is the
    PREMISE: a spurious `denied` establishes a boundary that is not there, and
    the verdict built on top of it is the loudest wrong answer available. The
    after-removal read would still catch that case, so a false positive needs
    two independent transients rather than one; taking this read twice makes it
    three, for the cost of one request and one pause on a run that happens once.
    """
    evidence.append("BASELINE -- no policy on the bucket")
    unattributable = []
    reachable = []
    first: dict = {}
    for window, key in keys.items():
        operator = _observe(verifier, bucket, f"baseline {window}", "operator", key)
        grantee = _observe(verifier, bucket, f"baseline {window}", GRANT_SUBJECT, key)
        evidence.append(operator.line())
        evidence.append(grantee.line())
        first[window] = grantee.outcome
        if operator.outcome != "allowed":
            unattributable.append(f"operator on the window {window} object ({operator.outcome})")
        if grantee.outcome not in ("allowed", "denied"):
            unattributable.append(f"grantee on the window {window} object ({grantee.outcome})")

    if not unattributable:
        _sleep(SETTLE_SECONDS)
        for window, key in keys.items():
            again = _observe(verifier, bucket, f"baseline {window} again", GRANT_SUBJECT, key)
            evidence.append(again.line())
            if again.outcome != first[window]:
                unattributable.append(
                    f"grantee on the window {window} object read {first[window]} and then "
                    f"{again.outcome}"
                )
            elif again.outcome == "allowed":
                reachable.append(f"window {window}")

    if unattributable:
        rows.append(
            (
                "the baseline reads are attributable",
                INCONCLUSIVE,
                "with nothing on the bucket the operator must read every probe object, and "
                "the grantee's answer must be classifiable and the same twice. These were "
                "not: "
                + "; ".join(unattributable)
                + ". A read under a grant would then be unattributable, so no window below "
                "could mean anything. Nothing further was applied.",
                "",
                True,
            )
        )
        return BASELINE_UNUSABLE

    rows.append(
        (
            "the grantee is denied with NO policy in force",
            PASS if not reachable else FAIL,
            ""
            if not reachable
            else "a credential in another project read this bucket with no policy on it ("
            + ", ".join(reachable)
            + "). The project boundary this whole probe is built on does not hold, so no "
            "grant below could be shown to have granted anything. Nothing further was "
            "applied",
            "the premise: a grant can only be shown to grant what was not already there. "
            "The operator read every one of these objects as the control, and the grantee's "
            f"read was taken twice, {SETTLE_SECONDS:g}s apart",
            bool(reachable),
        )
    )
    return BASELINE_NO_BOUNDARY if reachable else BASELINE_HOLDS


def _grant_window(
    verifier: Verifier,
    bucket: str,
    *,
    window: str,
    policy: dict,
    probe_key: str,
    grantee_arn: str,
    rows: list[tuple],
    evidence: list[str],
    masks: dict[str, str],
) -> tuple[str, bool]:
    """One grant window: `(outcome, clean)`.

    `outcome` is the grantee's read under the live document when the grant's
    withdrawal was verified -- `"allowed"` or `"denied"` -- and `""` otherwise
    (a refused PUT, a stored document that is not the one sent, reads that
    disagreed, or a withdrawal that could not be confirmed). Each of those is
    already a row by the time this returns.

    `clean` is whether the bucket is verified to carry no policy afterwards, and
    it is a SEPARATE axis from `outcome`. A window can be inconclusive and clean
    (G1 rejected outright, bucket untouched) or inconclusive and NOT clean (the
    removal failed). The caller runs the next window on the first and stops on
    the second, so collapsing the two into one falsy return -- as an earlier
    version did -- foreclosed G2 on a clean G1 failure, which is the run where
    G2's answer matters most. Cleanliness is read from the policy-removal state,
    never from the after-removal grant read: a DELETE that succeeded leaves no
    policy on the bucket whatever the grantee then reads.

    THE READ AFTER THE REMOVAL IS NOT BOOKKEEPING. Without it, a grantee allowed
    under the document and a grantee who was going to be allowed anyway are the
    same observation. It is taken through `_observe`, which sends rather than
    reads the outcome cache: the identical read was already made inside the
    window, and a cached answer here would report the grant's own result as
    proof the grant had been withdrawn.
    """
    state: dict = {}
    observations = _window(
        verifier,
        bucket,
        window=window,
        policy=policy,
        probe_key=probe_key,
        rows=rows,
        evidence=evidence,
        masks=masks,
        roles=(GRANT_SUBJECT, "operator"),
        assertion=lambda document, name: assert_probe_policy_grants_only(
            document, name, grantee_arn
        ),
        consequence=GRANT_CONSEQUENCE,
        state=state,
    )
    applied = state["applied"]
    # Clean iff the bucket carries no policy from this window: the PUT was
    # removed, or nothing was ever applied and its fate is known (a refused PUT,
    # not a PUT whose response was lost).
    clean = applied.removed or (not applied.applied and not applied.fate_unknown)
    if not observations:
        return "", clean

    # The document is off the bucket by now -- `_window` returns observations
    # only when it removed the policy. The pause is the same one the paired
    # reads use, and for the same reason: every way a just-removed policy can
    # still be visible biases this read towards `allowed`, which is the
    # direction that would turn a real grant into an unexplained one.
    _sleep(SETTLE_SECONDS)
    after = _observe(verifier, bucket, f"window {window} after removal", GRANT_SUBJECT, probe_key)
    evidence.append(after.line())
    rows.append(
        (
            f"probe {window}: the grant is gone once its document is removed",
            PASS if after.outcome == "denied" else FAIL if after.outcome == "allowed" else INCONCLUSIVE,
            ""
            if after.outcome == "denied"
            else "the grantee still read the object after the document came off, so this "
            "window shows nothing: whatever allowed the read was not the grant. The bucket "
            "carries no policy, and the next window would be measuring a state nobody has "
            "established"
            if after.outcome == "allowed"
            else after.reason,
            "without it, `the grant worked` and `it was never needed` are one observation",
            after.outcome != "denied",
        )
    )
    outcome = observations[GRANT_SUBJECT].outcome if after.outcome == "denied" else ""
    return outcome, clean


def probe_foreign_grant(
    verifier: Verifier, *, bucket: str, replace_existing: bool, grantee_is_ours: bool
) -> tuple[list[tuple], list[str], str]:
    """Settle whether a cross-project `Allow` grants access. Rows, evidence, verdict.

    The order is the safety argument, and every step before the first write is
    one that can refuse without having touched the bucket: resolve both accounts,
    refuse a grantee in the bucket's own project, refuse an unacknowledged
    grantee, assert both documents, then take the policy slot.
    """
    rows: list[tuple] = []
    evidence: list[str] = []

    accounts = {}
    for role in ("operator", GRANT_SUBJECT):
        account, reason = account_of(verifier, role)
        if account is None:
            rows.append((f"{role} credential resolves its account", INCONCLUSIVE, reason, "", True))
            return rows, evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]
        accounts[role] = account

    # THE STRUCTURAL PRECONDITION, AND THE REASON THIS MODE EXISTS. An owner key
    # as grantee re-creates the blind spot the earlier diagnostic could not see
    # past, and it would do it silently: every row below would still print and
    # the verdict would be about owner keys again, under a heading that says
    # otherwise.
    #
    # THE COMPARISON IS OPERATOR-VS-GRANTEE, NOT BUCKET-OWNER-VS-GRANTEE, and it
    # is sound because the operator IS a bucket-project key -- established, not
    # assumed. This whole run rests on the operator being able to PUT and DELETE
    # the bucket's policy, and on Hetzner a key administers a bucket's policy
    # only from within the bucket's own project. So `operator.account` IS the
    # bucket's project, and a grantee resolving to it is a grantee in the
    # bucket's project.
    if accounts["operator"] == accounts[GRANT_SUBJECT]:
        rows.append(
            (
                "the grantee is in a DIFFERENT account from the bucket",
                FAIL,
                f"both credentials resolve to {accounts['operator']}. A grantee inside the "
                f"bucket's own project is the exact blind spot this mode exists to close: "
                f"the earlier diagnostic already settled what a policy does to this "
                f"project's own keys, and repeating it under this heading would answer a "
                f"different question than the one printed. Supply a credential from another "
                f"project. Nothing has been written.",
                "",
                True,
            )
        )
        return rows, evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]
    rows.append(
        (
            "the grantee is in a DIFFERENT account from the bucket",
            PASS,
            "",
            f"bucket {accounts['operator']}, grantee {accounts[GRANT_SUBJECT]}",
            False,
        )
    )

    grantee_key = verifier.credentials[GRANT_SUBJECT][0]
    operator_key = verifier.credentials["operator"][0]
    grantee_arn = f"arn:aws:iam:::user/{accounts[GRANT_SUBJECT]}:{grantee_key}"
    masks = {
        f"arn:aws:iam:::user/{accounts['operator']}:{operator_key}": (
            f"arn:aws:iam:::user/{accounts['operator']}:{_key_label('operator', operator_key)}"
        ),
        grantee_arn: (
            f"arn:aws:iam:::user/{accounts[GRANT_SUBJECT]}:"
            f"{_key_label('grantee', grantee_key)}"
        ),
    }

    # THE ACKNOWLEDGEMENT GATE, and it covers the whole mode rather than the
    # second window alone. Both documents grant a foreign principal access to a
    # production bucket, and if this engine ignores `Resource` scoping -- which
    # is live as a possibility, not theoretical -- the narrow one reaches every
    # object in the bucket too. The ARN is printed first because the thing being
    # acknowledged is WHO, not whether.
    if not grantee_is_ours:
        rows.append(
            (
                "the grantee is acknowledged as ours",
                INCONCLUSIVE,
                f"this run would grant {_masked(grantee_arn, masks)} read access to "
                f"{bucket}, and in window {GRANT_WINDOW_DOCUMENTED} `s3:*` on the whole "
                f"bucket. That is safe only because the credential is ours. Confirm the ARN "
                f"above is a credential in this estate and re-run with --grantee-is-ours. "
                f"Nothing has been written.",
                "",
                True,
            )
        )
        return rows, evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]
    rows.append(
        (
            "the grantee is acknowledged as ours",
            PASS,
            "",
            f"granting to {_masked(grantee_arn, masks)}",
            False,
        )
    )

    # EVERY DOCUMENT IS ASSERTED BEFORE ANYTHING IS WRITTEN, for the same reason
    # the diagnostic does it: a VerifierError raised after the probe objects
    # exist escapes past the cleanup that removes them.
    plan = {window: build(bucket, grantee_arn) for window, build in _grant_plan()}
    for policy in plan.values():
        assert_probe_policy_grants_only(policy, bucket, grantee_arn)

    free, refusal, leftover = _policy_slot_is_free(
        verifier,
        bucket,
        replace_existing=replace_existing,
        own_ids=probe_family_ids(bucket),
    )
    if not free:
        rows.append(refusal)
        return rows, evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]
    if leftover:
        # It has to come off before the baseline, not when the first window
        # replaces it. A baseline read taken while a leftover GRANT is live
        # would show the grantee allowed and report that the project boundary
        # does not exist -- the loudest verdict in this file, from a document
        # this tool wrote.
        outcome, reason = classify(
            *verifier.request(_policy_probe("operator", bucket, "DELETE"))
        )
        rows.append(
            (
                "the leftover GRANT is removed before anything is measured",
                PASS if outcome == "allowed" else INCONCLUSIVE,
                # A leftover here is a grant this mode wrote, so until this
                # DELETE a foreign key held access to the bucket. The neutral
                # "policy removed" wording would hide that.
                "a foreign key held access to this bucket until this removal"
                if outcome == "allowed"
                else reason,
                "",
                outcome != "allowed",
            )
        )
        if outcome != "allowed":
            return rows, evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]

    keys = {
        window: f"{PROBE_PREFIX}grant-{window.lower()}-{uuid.uuid4().hex}.txt" for window in plan
    }
    for window, key in keys.items():
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
            rows.append(
                (f"the probe object for window {window} is written", INCONCLUSIVE, reason, "", True)
            )
            return rows + _cleanup_rows(verifier, bucket), evidence, GRANT_VERDICT_TEXT[GRANT_UNPROVEN]

    try:
        verdict = _read_the_grant(
            verifier,
            bucket,
            plan=plan,
            keys=keys,
            grantee_arn=grantee_arn,
            rows=rows,
            evidence=evidence,
            masks=masks,
        )
    finally:
        rows.extend(_cleanup_rows(verifier, bucket))
    return rows, evidence, GRANT_VERDICT_TEXT[verdict]


def _read_the_grant(
    verifier: Verifier,
    bucket: str,
    *,
    plan: dict,
    keys: dict,
    grantee_arn: str,
    rows: list[tuple],
    evidence: list[str],
    masks: dict[str, str],
) -> str:
    """The baseline, then both windows, then the reading drawn from the pair.

    Both windows run even when the first one grants. The question is not `does
    any grant work` but `which shapes does this engine honour`, and an
    implementation that matches its own published template while ignoring
    everything else is a finding that changes how every document in this estate
    has to be written. Stopping early would answer the easier question.

    AND BOTH RUN EVEN WHEN THE FIRST ONE IS INCONCLUSIVE, as long as the bucket
    is left clean. G1's PUT being rejected outright (`MalformedPolicy`) or its
    stored document not matching what was sent are both outcomes this file's own
    runbook anticipates, and both leave the bucket carrying no policy -- so
    foreclosing G2, which is the provider's documented shape and the one the
    architecture question turns on, would answer nothing on exactly the runs
    that most need G2's answer. Only a window that leaves the bucket NOT verified
    clean -- a removal that failed, a PUT whose fate is unknown -- stops the run,
    because layering G2 onto a bucket that may still carry G1's grant is the one
    thing that is unsafe rather than merely inconclusive.
    """
    baseline = _grant_baseline(verifier, bucket, keys=keys, rows=rows, evidence=evidence)
    if baseline == BASELINE_NO_BOUNDARY:
        return NO_PROJECT_BOUNDARY
    if baseline != BASELINE_HOLDS:
        return GRANT_UNPROVEN

    reads = {}
    for window, policy in plan.items():
        outcome, clean = _grant_window(
            verifier,
            bucket,
            window=window,
            policy=policy,
            probe_key=keys[window],
            grantee_arn=grantee_arn,
            rows=rows,
            evidence=evidence,
            masks=masks,
        )
        reads[window] = outcome
        if not clean:
            # The bucket is not verified clean -- a grant document may still be
            # on it. The dirty row is already recorded (critical), and running
            # another window on top of a possibly-live grant is the unsafe case.
            return GRANT_UNPROVEN

    rows.append(
        _grant_row(
            GRANT_WINDOW_SCOPED,
            reads,
            "an Allow naming the grantee on one object prefix reaches it",
        )
    )
    rows.append(
        _grant_row(
            GRANT_WINDOW_DOCUMENTED,
            reads,
            "the provider's documented cross-project shape reaches it",
            note="the shape a pattern-matching implementation would honour when it ignores "
            "every equivalent one",
        )
    )

    verdict = grant_verdict(reads[GRANT_WINDOW_SCOPED], reads[GRANT_WINDOW_DOCUMENTED])
    status = _finding_status(GRANT_DEMONSTRATED[verdict], verdict == GRANT_UNPROVEN)
    rows.append(
        (
            "A BUCKET POLICY REACHES A PRINCIPAL OUTSIDE THIS BUCKET'S PROJECT",
            status,
            ""
            if status == PASS
            else "no window classified a read either way -- see the verdict below"
            if status == INCONCLUSIVE
            else "see the verdict below",
            "",
            status != PASS,
        )
    )
    return verdict


def _grant_row(window: str, reads: dict, claim: str, note: str = "") -> tuple:
    """One window's contribution, stated as what it observed.

    PASS means the grant reached the grantee. It is not a verdict about the
    estate -- a grant that works is good news for a per-tenant architecture and
    says nothing about the fence -- and the reading below is drawn from both
    rows together.

    THE REASON STATES THE OUTCOME RATHER THAN NAMING A DENIAL, and the status is
    three-valued for the same reason. `allowed` is a grant reaching the grantee;
    `denied` is a shape the engine evaluated and did not honour -- a real FAIL
    against the "a fence is buildable" world. Anything else -- an `error` that
    `_confirmed_reads` returned because two errors agreed, or the empty string a
    window left clean but inconclusive returns -- is neither, and calling it FAIL
    "the grantee was still denied" would print a denial that never happened into
    the block the runbook tells an operator to paste onto the issue. That is the
    substitution `classify`'s docstring says this file exists to prevent.
    """
    outcome = reads[window]
    status = PASS if outcome == "allowed" else FAIL if outcome == "denied" else INCONCLUSIVE
    return (
        f"probe {window}: {claim}",
        status,
        ""
        if status == PASS
        else "the grantee was denied under this document"
        if status == FAIL
        else f"it was {outcome or 'inconclusive'}; this window settled nothing",
        note or "one observation; the reading below is drawn from both together",
        False,
    )


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

    The distinct-key check covers the roles this mode uses and no others. An
    environment left over from a different mode may well carry a role this one
    never signs as, and refusing the run because two credentials it will not
    both send happen to be one key would be a refusal about nothing.
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

    ids = {role: pair[0] for role, pair in credentials.items() if role in wanted}
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
        for role in ROLE_ENV
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
        help="settle what a bucket policy does to THIS PROJECT'S OWN KEYS -- whether one is "
        "enforced against them at all, and whether a named principal separates one from "
        "another; reversible, and needs only --bucket. For principals outside the project, "
        "see --probe-foreign-grant",
    )
    parser.add_argument(
        "--probe-foreign-grant",
        action="store_true",
        help="settle whether a cross-project Allow grants access, per shape; needs a "
        "grantee credential in ANOTHER project and --grantee-is-ours, and needs only "
        "--bucket besides",
    )
    parser.add_argument(
        "--grantee-is-ours",
        action="store_true",
        help="acknowledge that FENCE_GRANTEE_* is a credential in this estate. Required by "
        "--probe-foreign-grant, which grants that ARN access to the bucket",
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
            "policy with --project-id set to the OPERATOR's id WITHOUT its leading `p`; an ARN "
            "under any other account names a principal that does not exist. The grantee role "
            "is the exception and must NOT match: --probe-foreign-grant refuses to run unless "
            "its account differs from the operator's.",
        )

    # `--diagnose-policy-engine` and `--probe-foreign-grant` each ask a question
    # about the ENGINE and read no policy: each writes its own documents and
    # removes each one. Requiring a rendered fence for either would mean
    # rendering the very document the answer decides whether to build, and every
    # argument an operator does not have to type is one they cannot mistype into
    # a production bucket.
    engine_mode = args.diagnose_policy_engine or args.probe_foreign_grant
    # The three probe modes share one bucket-policy slot and take different
    # credentials, so two of them named together is an operator expecting an
    # experiment that is not the one that would run.
    probes = [
        name
        for name, chosen in (
            ("--probe-notprincipal", args.probe_notprincipal),
            ("--diagnose-policy-engine", args.diagnose_policy_engine),
            ("--probe-foreign-grant", args.probe_foreign_grant),
        )
        if chosen
    ]
    if len(probes) > 1:
        parser.error(
            f"{' and '.join(probes)} are separate experiments with different credentials "
            f"and different documents, sharing one bucket policy slot; run one at a time"
        )
    if args.grantee_is_ours and not args.probe_foreign_grant:
        parser.error("--grantee-is-ours means nothing outside --probe-foreign-grant")
    needs = (
        (("--bucket", args.bucket),)
        if engine_mode
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
        if engine_mode
        else build_checks(
            bucket=args.bucket,
            foreign_control_bucket=args.foreign_control_bucket,
            policy_document=policy_document,
            probe_key=probe_key,
            versioning_already_enabled=args.versioning_already_enabled,
        )
    )

    if args.dry_run and args.probe_foreign_grant:
        # Both documents, with the principal shown as the role it is built from.
        # Nothing is sent and no credential is read, so an operator can see the
        # `s3:*` in window G2 before deciding to acknowledge the grantee.
        for window, build in _grant_plan():
            print(
                f"window {window}  "
                + json.dumps(build(args.bucket, GRANTEE_ARN_PLACEHOLDER), sort_keys=True)
            )
        return 0

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

    if args.diagnose_policy_engine:
        needed = DIAGNOSTIC_ROLES
    elif args.probe_foreign_grant:
        needed = GRANT_ROLES
    else:
        needed = FENCE_ROLES
    try:
        verifier = Verifier(
            endpoint=args.endpoint,
            region=args.region,
            credentials=read_credentials(environ, needed=needed),
            transport=transport,
        )
    except VerifierError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.probe_foreign_grant:
        try:
            rows, evidence, verdict = probe_foreign_grant(
                verifier,
                bucket=args.bucket,
                replace_existing=args.replace_existing_policy,
                grantee_is_ours=args.grantee_is_ours,
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        print(
            "RAW EVIDENCE -- record this block verbatim. It carries no secret key, and every "
            "access key id it names is shown by its last four characters.\n"
        )
        for line in evidence:
            print(line)
        print("")
        code = report(
            rows,
            [],
            sys.stdout,
            applied=False,
            clean_message="\nEvery probe answered and every grant came off again.",
            banner="*** NOTHING WAS APPLIED AND NO FENCE WAS WRITTEN. Read the verdict below "
            "-- and if a row above says a probe document is still on the bucket, that "
            "document is a GRANT and removing it comes first.",
            failure_summary="read the verdict below. Nothing was applied and no fence was "
            "written; a FAIL here is a finding about the engine, not a broken run",
        )
        print(f"\n{verdict}")
        return code

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
        print(
            "RAW EVIDENCE -- record this block verbatim. It carries no secret key, and every "
            "access key id it names is shown by its last four characters.\n"
        )
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
