#!/usr/bin/env python3
"""Prove a bucket fence works, in both directions, against the live bucket.

Every denial is checked against a same-credential, same-transport control
before it counts as proof, because a bare `AccessDenied` cannot distinguish
a working fence from a revoked key, a typo, or a bucket in the wrong project.
See verify-bucket-fence.md#module-overview.
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

# DWELL_SECONDS: how long a read matching the pre-change state must be held
# before it counts, since a stale read path is biased toward that state.
# 120s is twice the longest apply lag observed; removal lags less and does
# not set this value. See verify-bucket-fence.md#dwell-timing.
DWELL_SECONDS = 120.0
DWELL_POLL_SECONDS = 10.0

_REMOVAL_ATTEMPTS = 3

# The backoff between attempts to remove a probe policy a prior DELETE did not
# clear. This retries a failed write; it is not waiting out a stale read, so it
# has no reason to survive the read-path cache above.
_REMOVAL_RETRY_SECONDS = 2.0

# Indirected so the tests can run the whole diagnostic without waiting. Nothing
# else should reach past this.
_sleep = time.sleep


def _narrate(message: str) -> None:
    """Reassure an operator watching a dwell that it is waiting, not hung.

    Gated on an interactive stderr rather than printed unconditionally: a
    dwell held for its full duration polls a dozen times, and printing on
    every one of them would turn a CI log or a test run into noise nobody
    reads without ever reaching the human this exists for. The permanent
    record of what was waited lives in `evidence` regardless of this check.
    """
    if sys.stderr.isatty():
        print(message, file=sys.stderr)


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

    Never raises on attacker-controlled input; bounds a DOCTYPE
    entity-expansion attack and caps the body before parsing.
    See verify-bucket-fence.md#s3-error-code.
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

    The HTTP status alone never decides a denial -- this endpoint returns 403
    for AccessDenied, a nonexistent key and a SigV4 mismatch alike -- so the
    verdict comes only from the error document's `Code`.
    See verify-bucket-fence.md#classify.
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

    Resolves each credential's own account first: a rendered policy's
    principal comes from one `--project-id` argument, so a mistyped digit
    only surfaces here, before anything is written, not after the bucket
    is locked. See verify-bucket-fence.md#preflight.
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

    # BEFORE any evaluation. `decide` skips a `NotAction` statement outright --
    # this engine stores that keyword and does not enforce it, so modelling its
    # complement would describe a boundary that is not there. The consequence
    # for THIS function is that every answer below becomes more permissive than
    # the document reads: a lockout expressed in a `NotAction` deny would be
    # skipped and reported as "the operator can still replace this policy".
    # That is the one direction this check exists to prevent, so the rows are
    # refused rather than qualified.
    notaction = [
        statement.get("Sid", "<unnamed>")
        for statement in policy.get("Statement", [])
        if isinstance(statement, dict) and "NotAction" in statement
    ]
    if notaction:
        rows.append(
            (
                "the policy can be evaluated",
                INCONCLUSIVE,
                f"statement(s) {', '.join(notaction)} use NotAction, which this engine "
                f"stores and does not enforce. Nothing here can say whether this document "
                f"locks a credential out, because the statements that might do so are the "
                f"ones that cannot be modelled. Re-render it with a generator that emits "
                f"enumerated Action lists.",
                "",
                True,
            )
        )
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

    Asked of `decide` as a model of S3 evaluation, not by reading
    `NotPrincipal` lists structurally, and at the object space the fence
    governs rather than a concrete key.
    See verify-bucket-fence.md#_denied_actions.
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
    """A policy that answers the `NotPrincipal` question and cannot lock
    anything.

    No statement names the bucket resource, and the `Deny` is confined to
    an object prefix nothing else writes, so a misread in either direction
    touches nothing real. See verify-bucket-fence.md#probe_policy.
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

    Assumes the worst case -- the statement matches every principal -- and
    requires that even then nothing on the bucket resource is denied.
    See verify-bucket-fence.md#assert_probe_policy_is_reversible.
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
    """Whether a probe may write this bucket's policy slot, or the row
    refusing.

    Only an affirmative "there is no policy" lets a probe proceed: a policy
    that could not be READ must not be written to, since treating "unknown"
    as "empty" can destroy a fence on a failed request.
    See verify-bucket-fence.md#_policy_slot_is_free.
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
    """The row that stops `--probe-notprincipal` on a bucket that has a
    policy.

    Nothing here restores a displaced document, so `--replace-existing-policy`
    permits replacing only a probe policy this file wrote itself -- never
    any other document. See verify-bucket-fence.md#_existing_policy_refusal.
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


def probe_notprincipal(
    verifier: Verifier,
    *,
    bucket: str,
    replace_existing: bool,
    dwell_seconds: float = DWELL_SECONDS,
) -> tuple[list[tuple], list[str]]:
    """Ask the live engine whether `NotPrincipal` exempts, reversibly.
    Returns rows, evidence.

    Ordering is the whole safety argument: the object is written before the
    probe policy exists, and the probe policy is removed before this
    returns, so it can never deny its own removal.
    See verify-bucket-fence.md#probe_notprincipal.
    """
    rows: list[tuple] = []
    evidence: list[str] = []
    account, reason = account_of(verifier, "operator")
    if account is None:
        return [("operator credential resolves its account", INCONCLUSIVE, reason, "", True)], evidence
    operator_arn = f"arn:aws:iam:::user/{account}:{verifier.credentials['operator'][0]}"

    free, refusal, _ = _policy_slot_is_free(
        verifier,
        bucket,
        replace_existing=replace_existing,
        own_ids=probe_family_ids(bucket),
    )
    if not free:
        return [refusal], evidence

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
        return [("the probe object is written", INCONCLUSIVE, reason, "", True)], evidence

    with _temporary_policy(verifier, bucket, policy, rows) as probe:
        if probe.applied:
            # `allowed` is both the pre-change answer and the hoped-for
            # post-change one for the operator, so a single read cannot
            # tell them apart -- the operator's reading is held across the
            # dwell before it counts, same as the foreign key's.
            # See verify-bucket-fence.md#probe_notprincipal-read-order.
            operator_observation = _dwell(
                lambda: _observe(verifier, bucket, "notprincipal", "operator", probe_key),
                pre_change="allowed",
                evidence=evidence,
                dwell_seconds=dwell_seconds,
            )
            foreign_observation = _dwell(
                lambda: _observe(verifier, bucket, "notprincipal", "foreign", probe_key),
                pre_change="allowed",
                evidence=evidence,
                dwell_seconds=dwell_seconds,
            )
            operator_outcome, operator_reason = operator_observation.outcome, operator_observation.reason
            foreign_outcome, foreign_reason = foreign_observation.outcome, foreign_observation.reason
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
    return rows, evidence


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

    Removal is conditional on the PUT having succeeded: `DeleteBucketPolicy`
    removes whatever is on the bucket, not necessarily what this block put
    there. See verify-bucket-fence.md#_temporary_policy.
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
                _sleep(_REMOVAL_RETRY_SECONDS)
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
# WHICH WORLD ARE WE IN: reads the subject key under four Principal shapes
# (itself, another real key, a nonexistent one, and a wildcard); only the
# combination across all four tells "unenforced", "one principal per
# project" and "NotPrincipal works as documented" apart.
# See verify-bucket-fence.md#which-world-are-we-in.
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
        "A fence is rebuildable -- but this run says nothing about the fence this\n"
        "repository renders, which fences by `NotPrincipal`. It never sent a\n"
        "`NotPrincipal` document, so that construct is UNPROVEN here -- not disproven.\n"
        "The earlier run that appeared to show it denying nobody read inside this\n"
        "engine's policy cache and established neither answer.\n\n"
        "So there are two ways forward and this run does not choose between them: prove\n"
        "`NotPrincipal` with --probe-notprincipal, or rebuild the fence out of the\n"
        "explicit `Principal` Deny statements the rows above just demonstrated. Until one\n"
        "of those happens, treat any bucket carrying a `NotPrincipal` fence as unfenced,\n"
        "and do not apply one anywhere else.\n"
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

    The foreign read is the subject, not the operator's, since an engine
    that exempts the bucket owner would always answer the operator
    `allowed` regardless of the policy.
    See verify-bucket-fence.md#wildcard_observation.
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
    """How this engine matches a principal, from the SUBJECT key's own
    reads.

    Window D (an absent key in a foreign account) is load-bearing: without
    it, "every key in this project is one principal" and "Principal is not
    read at all" are the same observation.
    See verify-bucket-fence.md#principal_verdict.
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


def _dwell(
    read,
    *,
    pre_change: str,
    evidence: list[str],
    dwell_seconds: float = DWELL_SECONDS,
    poll_seconds: float = DWELL_POLL_SECONDS,
) -> Observation:
    """One read, held until it cannot be explained by a stale read path.

    Staleness always biases a reading toward `pre_change`, so a reading
    that matches it is retaken until it differs or `dwell_seconds` elapses;
    a reading that already differs counts immediately.
    See verify-bucket-fence.md#_dwell.
    """
    observation = read()
    evidence.append(observation.line())
    elapsed = 0.0
    if observation.outcome == pre_change and elapsed < dwell_seconds:
        _narrate(
            f"verify-bucket-fence: {observation.window} read as {observation.role} is "
            f"`{pre_change}`, which cannot be trusted yet -- holding for up to "
            f"{dwell_seconds:g}s. This is not a hang."
        )
    while observation.outcome == pre_change and elapsed < dwell_seconds:
        step = min(poll_seconds, dwell_seconds - elapsed)
        _sleep(step)
        elapsed += step
        observation = read()
        evidence.append(observation.line())
        _narrate(
            f"verify-bucket-fence:   {elapsed:g}s of {dwell_seconds:g}s elapsed, still "
            f"{observation.outcome}"
        )
    if elapsed:
        evidence.append(
            f"  held {observation.window} read as {observation.role} for {elapsed:g}s "
            f"before it counted"
        )
    return observation


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
    pre_change: dict[str, str] | None = None,
    dwell_seconds: float = DWELL_SECONDS,
    assertion=None,
    consequence: str = "",
    state: dict | None = None,
) -> dict[str, Observation]:
    """Apply one probe policy, read the object as both keys, remove it
    again.

    Returns no evidence when the window's PUT, readback or removal is
    inconclusive, rather than distinguishing those cases -- a caller
    chaining windows needs to know only whether the bucket was left clean.
    See verify-bucket-fence.md#_window.
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
                    evidence=evidence, roles=roles,
                    pre_change=pre_change, dwell_seconds=dwell_seconds,
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
    evidence: list[str],
    roles: tuple = ("foreign", "operator"),
    pre_change: dict[str, str] | None = None,
    dwell_seconds: float = DWELL_SECONDS,
) -> dict[str, Observation]:
    """Both roles' reads, each held until it cannot be a stale answer.

    Each role has its own pre-change answer, and the `allowed` default
    below is only correct for a window following the clean baseline -- a
    caller chaining windows must pass the prior window's own reading
    instead. See verify-bucket-fence.md#_confirmed_reads.
    """
    pre_change = pre_change or {role: "allowed" for role in roles}
    # There is no disagreement case to report here any more: a role's reading
    # either differed from its own pre-change answer, or survived the full
    # dwell. Both are usable, so nothing here is a pass/fail gate on what
    # `_window` returns -- `_dwell` already wrote the per-read and per-hold
    # detail into `evidence`, and a row that can only ever read PASS would add
    # nothing but an inflated count to a report where PASS is read as evidence.
    return {
        role: _dwell(
            lambda role=role: _observe(verifier, bucket, f"window {window}", role, probe_key),
            pre_change=pre_change[role],
            evidence=evidence,
            dwell_seconds=dwell_seconds,
        )
        for role in roles
    }


def _cleanup_rows(verifier: Verifier, bucket: str) -> list[tuple]:
    return [
        ("probe object removed: " + problem, FAIL, "", "", False)
        for problem in cleanup(verifier, bucket)
    ]


def diagnose_policy_engine(
    verifier: Verifier,
    *,
    bucket: str,
    replace_existing: bool,
    dwell_seconds: float = DWELL_SECONDS,
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

    # THE CONTROL EVERY VERDICT BELOW RESTS ON: with no policy on the bucket,
    # both keys must read every probe object, or a later denial cannot be
    # attributed to the policy rather than the key or endpoint. Held against
    # `pre_change="denied"` because a stale cache can still echo a just-
    # removed leftover Deny.
    # See verify-bucket-fence.md#diagnose_policy_engine-baseline-control.
    evidence.append("BASELINE -- no policy on the bucket")
    unattributable = []
    for name, key in keys.items():
        for role in ("foreign", "operator"):
            observation = _dwell(
                lambda name=name, role=role, key=key: _observe(
                    verifier, bucket, f"baseline {name}", role, key
                ),
                pre_change="denied",
                evidence=evidence,
                dwell_seconds=dwell_seconds,
            )
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
            dwell_seconds=dwell_seconds,
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
    dwell_seconds: float = DWELL_SECONDS,
) -> str:
    """Windows B, C and D, then A only where the answer turns on it.

    No window ends this on its own reading -- the verdict is the
    combination -- and each window's `pre_change` is the PRIOR window's own
    settled reading, not a hardcoded "allowed".
    See verify-bucket-fence.md#_read_the_engine.
    """
    observed: dict[str, dict] = {}
    pre_change: dict[str, str] | None = None
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
            pre_change=pre_change,
            dwell_seconds=dwell_seconds,
        )
        if not observations:
            return UNEXPLAINED
        observed[window] = observations
        pre_change = {role: observation.outcome for role, observation in observations.items()}
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
            pre_change=pre_change,
            dwell_seconds=dwell_seconds,
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
# THE OTHER HALF: is a bucket policy evaluated for a principal outside this
# bucket's project? Sends two Allow-only grant shapes to a key in a
# DIFFERENT project -- the narrowest possible grant, and the provider's
# documented cross-project shape verbatim -- since an implementation that
# only honours the published template is a finding that changes how every
# policy in this estate must be written.
# See verify-bucket-fence.md#the-other-half-foreign-grant-probe.
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

    Deliberately not narrowed -- principal as a string, `s3:*`, both ARNs
    in `Resource` -- because narrowing it would stop answering whether the
    documented shape is what this engine actually honours.
    See verify-bucket-fence.md#documented_grant_policy.
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

    One definition, so the plan `--dry-run` prints is the plan the run
    sends; the narrower shape goes first since it is the smaller grant.
    See verify-bucket-fence.md#_grant_plan.
    """
    return (
        (GRANT_WINDOW_SCOPED, scoped_grant_policy),
        (GRANT_WINDOW_DOCUMENTED, documented_grant_policy),
    )


def assert_probe_policy_grants_only(policy: dict, bucket: str, grantee_arn: str = "") -> None:
    """Refuse a grant probe that could refuse anything, or reach anyone
    else.

    Six structural rules -- Allow-only, no NotPrincipal, principal is
    exactly the grantee, resources stay inside this bucket, actions stay
    inside `GRANT_ACTIONS`, and the document `Id` is this mode's own --
    each closing one way an `Allow` document could stop being harmless.
    See verify-bucket-fence.md#assert_probe_policy_grants_only.
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
    """The same property asked as an EVALUATION question, not a structural
    one.

    Runs the document through `decide` against the anonymous principal and
    concrete resource ARNs, as a second, independent route to the same
    invariant the structural rules already enforce.
    See verify-bucket-fence.md#_refuse_an_anonymous_grant.
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
    verifier: Verifier,
    bucket: str,
    *,
    keys: dict,
    rows: list[tuple],
    evidence: list[str],
    dwell_seconds: float = DWELL_SECONDS,
) -> str:
    """With no policy on the bucket: the grantee is denied, the operator is
    not.

    Both reads are needed as a pair -- the operator's is the control, the
    grantee's denial is the premise a grant can be shown to have changed --
    and the grantee's read is held against a stale-cache echo of a
    just-removed leftover grant. See verify-bucket-fence.md#_grant_baseline.
    """
    evidence.append("BASELINE -- no policy on the bucket")
    unattributable = []
    reachable = []
    for window, key in keys.items():
        operator = _observe(verifier, bucket, f"baseline {window}", "operator", key)
        evidence.append(operator.line())
        if operator.outcome != "allowed":
            unattributable.append(f"operator on the window {window} object ({operator.outcome})")

        grantee = _dwell(
            lambda window=window, key=key: _observe(
                verifier, bucket, f"baseline {window}", GRANT_SUBJECT, key
            ),
            pre_change="allowed",
            evidence=evidence,
            dwell_seconds=dwell_seconds,
        )
        if grantee.outcome not in ("allowed", "denied"):
            unattributable.append(f"grantee on the window {window} object ({grantee.outcome})")
        elif grantee.outcome == "allowed":
            reachable.append(f"window {window}")

    if unattributable:
        rows.append(
            (
                "the baseline reads are attributable",
                INCONCLUSIVE,
                "with nothing on the bucket the operator must read every probe object, and "
                "the grantee's answer must classify as allowed or denied. These did not: "
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
            + "), and that reading held for the full dwell rather than reverting. The "
            "project boundary this whole probe is built on does not hold, so no grant "
            "below could be shown to have granted anything. Nothing further was applied",
            "the premise: a grant can only be shown to grant what was not already there. "
            "The operator read every one of these objects as the control; an `allowed` "
            f"grantee reading is held for up to {dwell_seconds:g}s before it counts, because "
            "a read path still serving a just-removed leftover grant's decision produces "
            "exactly that answer",
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
    dwell_seconds: float = DWELL_SECONDS,
) -> tuple[str, bool]:
    """One grant window: `(outcome, clean)`.

    `clean` is a separate axis from `outcome` so a caller can run the next
    window on an inconclusive-but-clean result and stop only when the
    bucket's state is not verified clean.
    See verify-bucket-fence.md#_grant_window.
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
        pre_change={GRANT_SUBJECT: "denied", "operator": "allowed"},
        dwell_seconds=dwell_seconds,
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
    # only when it removed the policy. `pre_change` here is whatever the live
    # window just showed: if the grant read as `allowed`, that is exactly what
    # a read path still serving the removed document would echo, so an
    # `allowed` reading afterwards is held rather than trusted; a `denied`
    # reading is not something that state could produce and counts at once.
    # (If the live window read `denied`, the roles invert, and the dwell still
    # holds only the reading the removal did not change.)
    after = _dwell(
        lambda: _observe(verifier, bucket, f"window {window} after removal", GRANT_SUBJECT, probe_key),
        pre_change=observations[GRANT_SUBJECT].outcome,
        evidence=evidence,
        dwell_seconds=dwell_seconds,
    )
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
    verifier: Verifier,
    *,
    bucket: str,
    replace_existing: bool,
    grantee_is_ours: bool,
    dwell_seconds: float = DWELL_SECONDS,
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

    # THE STRUCTURAL PRECONDITION THIS MODE EXISTS FOR: an owner key as
    # grantee would silently re-create the blind spot the deny diagnostic
    # could not see past. The comparison is operator-vs-grantee rather than
    # bucket-owner-vs-grantee because the operator is established, not
    # assumed, to be a bucket-project key.
    # See verify-bucket-fence.md#probe_foreign_grant-precondition.
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
            dwell_seconds=dwell_seconds,
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
    dwell_seconds: float = DWELL_SECONDS,
) -> str:
    """The baseline, then both windows, then the reading drawn from the
    pair.

    Both windows always run, even when the first grants or is inconclusive
    but leaves the bucket clean -- the question is which shapes this
    engine honours, not whether any grant works at all.
    See verify-bucket-fence.md#_read_the_grant.
    """
    baseline = _grant_baseline(
        verifier, bucket, keys=keys, rows=rows, evidence=evidence, dwell_seconds=dwell_seconds
    )
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
            dwell_seconds=dwell_seconds,
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

    PASS means the grant reached the grantee; it is not a verdict about
    the fence. The status stays three-valued so an inconclusive window is
    never reported as a denial that never happened.
    See verify-bucket-fence.md#_grant_row.
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
    """The credentials for each role, from the environment and nowhere
    else.

    `needed` narrows which roles a mode insists on, since a verdict about
    a fence needs all three roles while the engine diagnostic needs only
    two. See verify-bucket-fence.md#read_credentials.
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


def _await_policy_settle(dwell_seconds: float) -> None:
    """Hold until the policy engine's read path can no longer be serving the pre-PUT decision.

    Silent for the whole dwell during a production apply reads as a hang, not
    a wait, so this narrates what it is doing and polls in short steps rather
    than sleeping the total in one call.
    """
    if dwell_seconds <= 0:
        return
    _narrate(
        f"verify-bucket-fence: waiting {dwell_seconds:g}s for the policy engine's read path to "
        f"settle before the confirming PUT -- this pause is deliberate, not a hang"
    )
    remaining = dwell_seconds
    elapsed = 0.0
    while remaining > 0:
        step = min(DWELL_POLL_SECONDS, remaining)
        _sleep(step)
        remaining -= step
        elapsed += step
        _narrate(f"verify-bucket-fence:   {elapsed:g}s of {dwell_seconds:g}s elapsed")


def apply_fence(
    verifier: Verifier,
    *,
    bucket: str,
    policy_document: bytes,
    dwell_seconds: float = DWELL_SECONDS,
) -> tuple[list[tuple], bool]:
    """Pre-flight and the double PUT, in one process.

    The second PUT is only a control once the dwell has run: sent right
    after the first, it is authorised against the same cached pre-PUT
    decision and returns 2xx whether the exemption held or the operator
    already lost `PutBucketPolicy`. See verify-bucket-fence.md#apply_fence.
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
    _await_policy_settle(dwell_seconds)
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

    `clean_message` and `banner` let a mode override the closing line and
    failure shout, since not every mode's clean run is a statement about
    a policy. See verify-bucket-fence.md#report.
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
    parser.add_argument(
        "--dwell-seconds",
        type=float,
        default=DWELL_SECONDS,
        help=f"how long a read matching the pre-change state is held before it counts, for "
        f"--probe-notprincipal, --diagnose-policy-engine and --probe-foreign-grant, and how "
        f"long --apply pauses between its two PUTs (default {DWELL_SECONDS:g}, comfortably "
        f"above this endpoint's measured read-path cache); lower it for a fast-path re-run "
        f"once the engine's behaviour is already known -- it must stay above zero, because "
        f"zero is the one value that turns every dwell in this file back into the pause that "
        f"produced the withdrawn conclusion this tool exists to prevent",
    )
    args = parser.parse_args(argv)
    if args.dwell_seconds <= 0:
        # Zero does not mean "no wait needed" here -- it means every dwell in
        # this file degenerates to a single, untrusted read, which is the
        # exact shape of the bug this tool was built to stop reproducing.
        parser.error("--dwell-seconds must be greater than 0")

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
                dwell_seconds=args.dwell_seconds,
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
                verifier,
                bucket=args.bucket,
                replace_existing=args.replace_existing_policy,
                dwell_seconds=args.dwell_seconds,
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
            rows, evidence = probe_notprincipal(
                verifier,
                bucket=args.bucket,
                replace_existing=args.replace_existing_policy,
                dwell_seconds=args.dwell_seconds,
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        # This step can now hold for most of --dwell-seconds, and the reads
        # taken while it held are exactly the transcript an operator needs if
        # the verdict is INCONCLUSIVE -- discarding them here would leave the
        # one step this docstring calls "THE STEP AN OPERATOR ACTUALLY RUNS"
        # with no record of what it actually saw.
        if evidence:
            print(
                "RAW EVIDENCE -- record this block verbatim. It carries no secret key, and "
                "every access key id it names is shown by its last four characters.\n"
            )
            for line in evidence:
                print(line)
            print("")
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
        rows, wrote = apply_fence(
            verifier,
            bucket=args.bucket,
            policy_document=policy_document,
            dwell_seconds=args.dwell_seconds,
        )
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
