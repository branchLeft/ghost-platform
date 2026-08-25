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
credential* that must succeed. If the control does not succeed, the denial is
reported as INCONCLUSIVE, never as a pass -- because a key that reaches nothing
tells you nothing about the fence. The one check with no control available is
labelled as such and proves only that the bucket is not world-readable.

And every fence has a second direction that matters just as much: the key that
is supposed to keep working must still work. A policy that denies everybody is
not a fence, it is an outage -- on the backup bucket, a silent one that surfaces
at the next restore.

THE CHECK THAT MATTERS MOST IS REVERSIBLE, AND RUNS FIRST. `--probe-notprincipal`
asks the live engine the one question every other check assumes the answer to:
does this backend read `NotPrincipal` as an exemption, or as decoration?

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
the operator. Denied means `NotPrincipal` does not exempt on this engine and the
real fence would have locked the bucket. Allowed, with a foreign key denied on
the same object, means the exemption works. The probe policy cannot lock
anything, because it contains no statement on the bucket resource -- so
`PutBucketPolicy` and `DeleteBucketPolicy` stay available to every key
throughout, and the probe is removed at the end. That reversibility is asserted
in code before the policy is sent, not assumed.

AND THEN `--preflight`, which resolves each credential's own storage account and
confirms the policy names those principals. Nothing else can: every principal in
a rendered policy comes from one `--project-id` argument, so the generator's own
recoverability check compares a fabricated ARN against itself and passes for any
value at all. Live, an ARN carrying the right access key under the wrong account
names a principal that does not exist -- `NotPrincipal` exempts nobody, the
operator loses `PutBucketPolicy` along with everyone else, and the bucket cannot
be recovered from inside the account. One mistyped digit is enough.
`--preflight` writes nothing.

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

Credentials come from the environment, one pair per role, and are never
accepted as arguments:

    FENCE_OPERATOR_ACCESS_KEY_ID / FENCE_OPERATOR_SECRET_ACCESS_KEY
    FENCE_WORKLOAD_ACCESS_KEY_ID / FENCE_WORKLOAD_SECRET_ACCESS_KEY
    FENCE_FOREIGN_ACCESS_KEY_ID  / FENCE_FOREIGN_SECRET_ACCESS_KEY

The foreign role is any real key in the same project that has no business in
this bucket. It must be a live key with an entitlement somewhere, named by
`--foreign-control-bucket`, or its denials prove nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid

PROBE_PREFIX = "fence-probe/"

# botocore's rendering of a service error, which is the only place the S3 error
# code appears when the CLI fails.
ERROR_CODE = re.compile(r"An error occurred \(([A-Za-z0-9_]+)\)")

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
    def __init__(self, role: str, description: str, args: list[str]):
        self.role = role
        self.description = description
        self.args = args

    def key(self) -> tuple:
        return (self.role, tuple(self.args))


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


def _default_runner(argv: list[str], env: dict[str, str]):
    """A failure to run the CLI is an outcome, not an exception.

    An exception escaping here skips `cleanup()`, which leaves probe objects in
    a production bucket. Both failures are returned in the shape `classify`
    already refuses to read as a denial, so they surface as INCONCLUSIVE.
    """
    try:
        return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 1, "", "the aws CLI did not return within 120s")
    except FileNotFoundError:
        return subprocess.CompletedProcess(argv, 1, "", "the aws CLI is not on PATH")


def classify(returncode: int, stderr: str) -> tuple[str, str]:
    """Map one CLI invocation onto `allowed` / `denied` / `error`, with a reason.

    Anything that is not a clean success or a recognised denial is `error`, and
    an error never contributes to a pass. Collapsing an unrecognised failure
    into "denied" is the mistake this whole file exists to prevent.
    """
    if returncode == 0:
        return "allowed", ""
    match = ERROR_CODE.search(stderr)
    if not match:
        return "error", f"no S3 error code in the CLI output: {stderr.strip()[:200]}"
    code = match.group(1)
    if code in DENIAL_CODES:
        return "denied", code
    if code in NOT_A_DENIAL:
        return "error", f"{code}: {NOT_A_DENIAL[code]}"
    return "error", f"{code}: not a denial and not a success"


class Verifier:
    def __init__(
        self, *, endpoint: str, region: str, credentials: dict, runner=_default_runner, environ=None
    ):
        self.endpoint = endpoint
        self.region = region
        self.credentials = credentials
        self.runner = runner
        # Threaded in rather than read from `os.environ` at use, so a test
        # exercises the same environment the probes get.
        self.environ = os.environ if environ is None else environ
        self._outcomes: dict[tuple, tuple[str, str]] = {}

    def env_for(self, role: str) -> dict[str, str]:
        env = dict(self.environ)
        # The ambient AWS_* variables are cleared rather than left in place: a
        # probe that silently ran as whatever key was already exported is the
        # failure mode with no symptom.
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
            env.pop(name, None)
        if role != "anonymous":
            access_key, secret_key = self.credentials[role]
            env["AWS_ACCESS_KEY_ID"] = access_key
            env["AWS_SECRET_ACCESS_KEY"] = secret_key
        env["AWS_DEFAULT_REGION"] = self.region
        env["AWS_EC2_METADATA_DISABLED"] = "true"
        return env

    def run(self, probe: Probe) -> tuple[str, str]:
        cached = self._outcomes.get(probe.key())
        if cached is not None:
            return cached
        argv = ["aws", "--endpoint-url", self.endpoint, "s3api"] + probe.args
        if probe.role == "anonymous":
            argv.append("--no-sign-request")
        completed = self.runner(argv, self.env_for(probe.role))
        outcome = classify(completed.returncode, completed.stderr or "")
        self._outcomes[probe.key()] = outcome
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


def build_checks(
    *,
    bucket: str,
    foreign_control_bucket: str,
    policy_file: str,
    probe_key: str,
    versioning_already_enabled: bool = False,
) -> list[Check]:
    workload_control = Probe(
        "workload", f"list {bucket}", ["list-objects-v2", "--bucket", bucket, "--max-keys", "1"]
    )
    foreign_control = Probe(
        "foreign",
        f"list {foreign_control_bucket}",
        ["list-objects-v2", "--bucket", foreign_control_bucket, "--max-keys", "1"],
    )
    policy_arg = f"file://{policy_file}"

    checks = [
        Check(
            "operator can read the policy",
            Probe("operator", "get the policy", ["get-bucket-policy", "--bucket", bucket]),
            "allow",
        ),
        Check(
            "THE BUCKET IS STILL ADMINISTRABLE",
            Probe(
                "operator",
                "re-put the identical policy",
                ["put-bucket-policy", "--bucket", bucket, "--policy", policy_arg],
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
                ["put-object", "--bucket", bucket, "--key", probe_key],
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
                ["get-object", "--bucket", bucket, "--key", probe_key, os.devnull],
            ),
            "allow",
        ),
        Check(
            "foreign key cannot list the bucket",
            Probe(
                "foreign",
                f"list {bucket}",
                ["list-objects-v2", "--bucket", bucket, "--max-keys", "1"],
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "foreign key cannot read an object",
            Probe(
                "foreign",
                "read the probe object",
                ["get-object", "--bucket", bucket, "--key", probe_key, os.devnull],
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "foreign key cannot write an object",
            Probe(
                "foreign",
                "put a foreign object",
                ["put-object", "--bucket", bucket, "--key", f"{PROBE_PREFIX}foreign.txt"],
            ),
            "deny",
            control=foreign_control,
        ),
        Check(
            "workload cannot read the fence",
            Probe("workload", "get the policy", ["get-bucket-policy", "--bucket", bucket]),
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
                ["put-bucket-policy", "--bucket", bucket, "--policy", policy_arg],
            ),
            "deny",
            control=workload_control,
        ),
        Check(
            "the bucket is not world-readable",
            Probe(
                "anonymous",
                f"list {bucket} unsigned",
                ["list-objects-v2", "--bucket", bucket, "--max-keys", "1"],
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
                ["delete-object", "--bucket", bucket, "--key", probe_key],
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
                    [
                        "put-bucket-versioning",
                        "--bucket",
                        bucket,
                        "--versioning-configuration",
                        "Status=Enabled",
                    ],
                ),
                "deny",
                control=workload_control,
            ),
        )
    return checks


def compare_stored_policy(verifier, bucket: str, policy_file: str) -> tuple[str, str]:
    """Prove the bucket stores the document that was sent.

    This backend is known to accept a configuration and silently drop an
    element of it, and every other check here would still pass on a bucket
    whose stored policy is not the rendered one -- the probes would simply be
    measuring a different fence. Statements are compared as a sorted set, so an
    engine that reorders them is not reported as a mismatch.
    """
    argv = [
        "aws",
        "--endpoint-url",
        verifier.endpoint,
        "s3api",
        "get-bucket-policy",
        "--bucket",
        bucket,
        "--query",
        "Policy",
        "--output",
        "text",
    ]
    completed = verifier.runner(argv, verifier.env_for("operator"))
    if completed.returncode != 0:
        return INCONCLUSIVE, f"could not read the stored policy: {(completed.stderr or '').strip()[:200]}"
    try:
        stored = json.loads(completed.stdout or "")
        with open(policy_file, "r", encoding="utf-8") as handle:
            sent = json.load(handle)
    except (json.JSONDecodeError, OSError) as error:
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


def cleanup(verifier: Verifier, bucket: str) -> list[str]:
    """Remove every probe object version, as the operator.

    A plain delete on a versioned bucket writes a delete marker and leaves the
    prior version readable at `?versionId=`, so the workload's delete above is
    a check rather than a cleanup.
    """
    argv = [
        "aws",
        "--endpoint-url",
        verifier.endpoint,
        "s3api",
        "list-object-versions",
        "--bucket",
        bucket,
        "--prefix",
        PROBE_PREFIX,
        "--output",
        "json",
    ]
    env = verifier.env_for("operator")
    completed = verifier.runner(argv, env)
    if completed.returncode != 0:
        return [f"could not list probe object versions: {(completed.stderr or '').strip()[:200]}"]
    try:
        listing = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as error:
        return [f"could not parse the probe object listing: {error}"]

    problems = []
    for group in ("Versions", "DeleteMarkers"):
        for entry in listing.get(group) or []:
            delete_argv = [
                "aws",
                "--endpoint-url",
                verifier.endpoint,
                "s3api",
                "delete-object",
                "--bucket",
                bucket,
                "--key",
                entry["Key"],
                "--version-id",
                entry["VersionId"],
            ]
            result = verifier.runner(delete_argv, env)
            if result.returncode != 0:
                problems.append(
                    f"probe object {entry['Key']} version {entry['VersionId']} not removed"
                )
    return problems


def account_of(verifier, role: str) -> tuple[str | None, str]:
    """The storage account a credential belongs to, from ListAllMyBuckets.

    Service-level, so no bucket policy governs it, and it works before a fence
    exists as well as after.
    """
    argv = [
        "aws",
        "--endpoint-url",
        verifier.endpoint,
        "s3api",
        "list-buckets",
        "--query",
        "Owner.ID",
        "--output",
        "text",
    ]
    completed = verifier.runner(argv, verifier.env_for(role))
    if completed.returncode != 0:
        return None, (completed.stderr or "").strip()[:200]
    account = (completed.stdout or "").strip()
    return (account, "") if account else (None, "no Owner.ID in the response")


def preflight(verifier, *, bucket: str, policy_file: str) -> list[tuple]:
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
        with open(policy_file, "r", encoding="utf-8") as handle:
            policy = json.load(handle)
    except (json.JSONDecodeError, OSError) as error:
        rows.append(("the policy file is readable", INCONCLUSIVE, str(error), "", True))
        return rows

    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_prefix = f"{bucket_arn}/"
    exempts_operator = None
    exempts_workload = None
    for statement in policy.get("Statement", []):
        if statement.get("Effect") != "Deny":
            continue
        resource = statement.get("Resource", [])
        resources = [resource] if isinstance(resource, str) else list(resource)
        not_principal = statement.get("NotPrincipal", {})
        named = not_principal.get("AWS", []) if isinstance(not_principal, dict) else []
        named = [named] if isinstance(named, str) else list(named)
        if bucket_arn in resources:
            exempts_operator = (exempts_operator is not False) and operator_arn in named
        if any(r.startswith(objects_prefix) for r in resources) and workload_arn in named:
            exempts_workload = True

    rows.append(
        (
            "the policy exempts THIS operator credential",
            PASS if exempts_operator else FAIL,
            ""
            if exempts_operator
            else f"no bucket-level Deny exempts {operator_arn}. Applying this policy would "
            f"lock the bucket permanently -- most likely the --project-id it was rendered "
            f"with is not {account}.",
            operator_arn,
            True,
        )
    )
    rows.append(
        (
            "the policy exempts THIS workload credential",
            PASS if exempts_workload else FAIL,
            "" if exempts_workload else f"no object-level Deny exempts {workload_arn}",
            workload_arn,
            False,
        )
    )
    return rows


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
        "Id": f"notprincipal-probe-{bucket}",
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

    The probe exists because the engine's `NotPrincipal` semantics are unknown.
    It would be self-defeating to establish that with a document that becomes
    unremovable under the very reading it is testing for, so the check assumes
    the worst case -- `NotPrincipal` matches everybody -- and requires that even
    then, nothing on the bucket resource is denied.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    for statement in policy.get("Statement", []):
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


def probe_notprincipal(verifier, *, bucket: str, replace_existing: bool) -> list[tuple]:
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

    existing = verifier.runner(
        _argv(verifier, ["get-bucket-policy", "--bucket", bucket, "--query", "Policy", "--output", "text"]),
        verifier.env_for("operator"),
    )
    if existing.returncode == 0 and not replace_existing:
        # Replacing a live fence with the probe would un-fence the bucket for
        # the duration. In the documented sequence the bucket is still open at
        # this point, so this only fires on a re-run.
        return [
            (
                "the bucket carries no policy to displace",
                INCONCLUSIVE,
                "this bucket already has a policy; running the probe would replace it and "
                "leave the bucket unfenced until the probe is removed. Pass "
                "--replace-existing-policy only if that window is acceptable.",
                "",
                True,
            )
        ]

    policy = probe_policy(bucket, operator_arn)
    assert_probe_policy_is_reversible(policy, bucket)
    probe_key = f"{PROBE_PREFIX}notprincipal-{uuid.uuid4().hex}.txt"

    put_object = verifier.runner(
        _argv(verifier, ["put-object", "--bucket", bucket, "--key", probe_key]),
        verifier.env_for("operator"),
    )
    if put_object.returncode != 0:
        return [
            (
                "the probe object is written",
                INCONCLUSIVE,
                (put_object.stderr or "").strip()[:200],
                "",
                True,
            )
        ]

    with _temporary_policy(verifier, bucket, policy, rows):
        operator_read = verifier.runner(
            _argv(verifier, ["get-object", "--bucket", bucket, "--key", probe_key, os.devnull]),
            verifier.env_for("operator"),
        )
        foreign_read = verifier.runner(
            _argv(verifier, ["get-object", "--bucket", bucket, "--key", probe_key, os.devnull]),
            verifier.env_for("foreign"),
        )

    operator_outcome, operator_reason = classify(operator_read.returncode, operator_read.stderr or "")
    foreign_outcome, foreign_reason = classify(foreign_read.returncode, foreign_read.stderr or "")

    rows.append(
        (
            "NotPrincipal EXEMPTS the named key on this engine",
            PASS if operator_outcome == "allowed" else FAIL if operator_outcome == "denied" else INCONCLUSIVE,
            ""
            if operator_outcome == "allowed"
            else "the operator was denied by a statement that names it in NotPrincipal. This "
            "engine does not read NotPrincipal as an exemption, and the real fence WOULD "
            "HAVE LOCKED THE BUCKET. Do not apply it."
            if operator_outcome == "denied"
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
            else "a key not named in NotPrincipal was still allowed, so the statement is not "
            "being enforced at all and a fence built from it would fence nothing"
            if foreign_outcome == "allowed"
            else foreign_reason,
            "",
            False,
        )
    )
    rows.extend(("probe object removed: " + problem, FAIL, "", "", False) for problem in cleanup(verifier, bucket))
    return rows


def _argv(verifier, args: list[str]) -> list[str]:
    return ["aws", "--endpoint-url", verifier.endpoint, "s3api"] + args


class _temporary_policy:
    """Applies a policy, and removes it again whatever happens in between."""

    def __init__(self, verifier, bucket: str, policy: dict, rows: list[tuple]):
        self.verifier = verifier
        self.bucket = bucket
        self.policy = policy
        self.rows = rows
        self.path = None

    def __enter__(self):
        handle, self.path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(self.policy, stream)
        applied = self.verifier.runner(
            _argv(
                self.verifier,
                ["put-bucket-policy", "--bucket", self.bucket, "--policy", f"file://{self.path}"],
            ),
            self.verifier.env_for("operator"),
        )
        if applied.returncode != 0:
            self.rows.append(
                (
                    "the probe policy is accepted",
                    INCONCLUSIVE,
                    f"this engine rejected a NotPrincipal document outright: "
                    f"{(applied.stderr or '').strip()[:200]}",
                    "",
                    True,
                )
            )
        return self

    def __exit__(self, *exc):
        removed = self.verifier.runner(
            _argv(self.verifier, ["delete-bucket-policy", "--bucket", self.bucket]),
            self.verifier.env_for("operator"),
        )
        if removed.returncode != 0:
            self.rows.append(
                (
                    "THE PROBE POLICY IS REMOVED",
                    FAIL,
                    f"the probe policy is still on {self.bucket} and denies reads under "
                    f"{PROBE_PREFIX} to every key but the operator. Remove it by hand: "
                    f"aws --endpoint-url {self.verifier.endpoint} s3api delete-bucket-policy "
                    f"--bucket {self.bucket}",
                    "",
                    True,
                )
            )
        if self.path:
            try:
                os.unlink(self.path)
            except OSError:
                pass
        return False


def read_credentials(environ: dict[str, str]) -> dict[str, tuple[str, str]]:
    credentials = {}
    missing = []
    for role, (key_name, secret_name) in ROLE_ENV.items():
        access_key = environ.get(key_name)
        secret_key = environ.get(secret_name)
        if not access_key or not secret_key:
            missing.append(f"{key_name}/{secret_name}")
            continue
        credentials[role] = (access_key, secret_key)
    if missing:
        raise VerifierError("missing credentials in the environment: " + ", ".join(missing))

    ids = {role: pair[0] for role, pair in credentials.items()}
    for left in ("operator", "workload", "foreign"):
        for right in ("operator", "workload", "foreign"):
            if left < right and ids[left] == ids[right]:
                raise VerifierError(
                    f"the {left} and {right} roles are the same access key. Every check that "
                    f"distinguishes them would be meaningless, and the run would report a "
                    f"fence it never tested."
                )
    return credentials


def apply_fence(verifier, *, bucket: str, policy_file: str) -> tuple[list[tuple], bool]:
    """Pre-flight and the double PUT, in one process.

    Split across two commands these are two decisions an operator makes
    separately, with scroll-back and two credential blocks in between, and the
    riskier bucket was the one whose apply had no in-process guard at all --
    `configure_backup_bucket.py` covers the backup bucket and nothing covered
    the state bucket. Here the PUT is unreachable unless the pre-flight passed.
    """
    rows = preflight(verifier, bucket=bucket, policy_file=policy_file)
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

    argv = _argv(verifier, ["put-bucket-policy", "--bucket", bucket, "--policy", f"file://{policy_file}"])
    first = verifier.runner(argv, verifier.env_for("operator"))
    rows.append(
        (
            "the policy is applied",
            PASS if first.returncode == 0 else FAIL,
            "" if first.returncode == 0 else (first.stderr or "").strip()[:200],
            "",
            False,
        )
    )
    if first.returncode != 0:
        return rows, True

    # The identical document again. A no-op when it succeeds, and the only
    # signal available if the engine has just denied the operator the ability
    # to edit the statement doing the denying.
    second = verifier.runner(argv, verifier.env_for("operator"))
    rows.append(
        (
            "THE BUCKET IS STILL ADMINISTRABLE",
            PASS if second.returncode == 0 else FAIL,
            "" if second.returncode == 0 else (second.stderr or "").strip()[:200],
            "a no-op when it succeeds; a permanent lockout when it does not",
            True,
        )
    )
    rows.append(
        ("the stored policy is the one that was sent", *compare_stored_policy(verifier, bucket, policy_file), "", False)
    )
    return rows, True


def report(rows: list[tuple], problems: list[str], stream, *, applied: bool) -> int:
    """`rows` are `(name, status, reason, note, critical)`."""
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
        if applied:
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
                "Re-render it against the account id printed above.",
                file=stream,
            )
    if failed:
        print(f"\n{len(failed)} check(s) FAILED: the fence is not doing what it must.", file=stream)
    if inconclusive:
        print(
            f"\n{len(inconclusive)} check(s) INCONCLUSIVE. An inconclusive check is not a pass "
            f"-- it means the probe proved nothing, which is how an open bucket was previously "
            f"recorded as fenced.",
            file=stream,
        )
    if not failed and not inconclusive and not problems:
        message = (
            "\nEvery check passed, in both directions."
            if applied
            else "\nPre-flight clean. The policy is safe to apply to this bucket, with this "
            "operator credential."
        )
        print(message, file=stream)
    return 0 if not failed and not inconclusive and not problems else 1


def main(argv: list[str] | None = None, runner=_default_runner, environ=None) -> int:
    environ = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", required=True, help="the fenced bucket")
    parser.add_argument(
        "--foreign-control-bucket",
        required=True,
        help="a bucket the foreign key IS entitled to, proving that key is live",
    )
    parser.add_argument(
        "--policy-file",
        required=True,
        help="the policy document just applied; re-PUT as the recoverability check",
    )
    parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    parser.add_argument("--region", default="hel1")
    parser.add_argument(
        "--probe-notprincipal",
        action="store_true",
        help="ask the live engine whether NotPrincipal exempts, reversibly; run this first",
    )
    parser.add_argument(
        "--replace-existing-policy",
        action="store_true",
        help="allow --probe-notprincipal on a bucket that already carries a policy",
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

    probe_key = f"{PROBE_PREFIX}{uuid.uuid4().hex}.txt"
    checks = build_checks(
        bucket=args.bucket,
        foreign_control_bucket=args.foreign_control_bucket,
        policy_file=args.policy_file,
        probe_key=probe_key,
        versioning_already_enabled=args.versioning_already_enabled,
    )

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
        credentials = read_credentials(environ)
    except VerifierError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    verifier = Verifier(
        endpoint=args.endpoint,
        region=args.region,
        credentials=credentials,
        runner=runner,
        environ=environ,
    )

    if args.probe_notprincipal:
        try:
            rows = probe_notprincipal(
                verifier, bucket=args.bucket, replace_existing=args.replace_existing_policy
            )
        except VerifierError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        return report(rows, [], sys.stdout, applied=False)

    if args.preflight:
        return report(preflight(verifier, bucket=args.bucket, policy_file=args.policy_file), [], sys.stdout, applied=False)

    if args.apply:
        rows, wrote = apply_fence(verifier, bucket=args.bucket, policy_file=args.policy_file)
        return report(rows, [], sys.stdout, applied=wrote)

    rows = [
        (check.name, *verifier.check(check), check.note, check.critical) for check in checks
    ]
    rows.append(("the stored policy is the one that was sent", *compare_stored_policy(verifier, args.bucket, args.policy_file), "", False))
    problems = cleanup(verifier, args.bucket)
    return report(rows, problems, sys.stdout, applied=True)


if __name__ == "__main__":
    raise SystemExit(main())
