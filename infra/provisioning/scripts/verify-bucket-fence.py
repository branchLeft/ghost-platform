#!/usr/bin/env python3
"""Prove a bucket fence works, in both directions, against the live bucket.

WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A LIST OF DENIALS.

A single `AccessDenied` is not evidence that a fence works. It is returned by a
working fence, by a credential that was revoked, by a typo in a key id, by a
region mismatch in the SigV4 scope, and by a bucket that lives in a different
project entirely. Those are different facts with one wire response, and a
denial recorded without distinguishing them has already been mistaken here for
proof of per-bucket key scoping that did not exist
(branchLeft/workspace#286).

So every denial check in this file carries a CONTROL: a probe on the *same
credential* that must succeed. If the control does not succeed, the denial is
reported as INCONCLUSIVE, never as a pass -- because a key that reaches nothing
tells you nothing about the fence. The one check with no control available is
labelled as such and proves only that the bucket is not world-readable.

And every fence has a second direction that matters just as much: the key that
is supposed to keep working must still work. A policy that denies everybody is
not a fence, it is an outage -- on the backup bucket, a silent one that surfaces
at the next restore.

THE CHECK THAT MATTERS MOST IS THE FIRST ONE. `put-bucket-policy` as the
operator, re-PUTting the document just applied, is a no-op when it succeeds and
the only warning you will ever get when it does not. A policy that denies the
operator `PutBucketPolicy` cannot be edited or removed by any key in the
project, and recovery is a support request against the storage cluster. Run
this before leaving the terminal, not the next morning.

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
    return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)


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
    def __init__(self, *, endpoint: str, region: str, credentials: dict, runner=_default_runner):
        self.endpoint = endpoint
        self.region = region
        self.credentials = credentials
        self.runner = runner
        self._outcomes: dict[tuple, tuple[str, str]] = {}

    def env_for(self, role: str) -> dict[str, str]:
        env = dict(os.environ)
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
    *, bucket: str, foreign_control_bucket: str, policy_file: str, probe_key: str
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

    return [
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
            "workload cannot re-open the bucket with an ACL",
            # `private` rather than `public-read`: a probe whose success is
            # itself the damage is not a safe probe.
            Probe(
                "workload",
                "set the bucket ACL",
                ["put-bucket-acl", "--bucket", bucket, "--acl", "private"],
            ),
            "deny",
            control=workload_control,
        ),
        Check(
            "workload cannot touch versioning",
            # `Enabled` rather than `Suspended`, for the same reason: suspending
            # versioning on a backup bucket to find out whether it is allowed
            # would be the incident.
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


def report(results: list[tuple[Check, str, str]], problems: list[str], stream) -> int:
    width = max(len(check.name) for check, _, _ in results)
    for check, status, reason in results:
        line = f"{status:<13} {check.name:<{width}}"
        if reason:
            line += f"  -- {reason}"
        elif check.note:
            line += f"  ({check.note})"
        print(line, file=stream)

    for problem in problems:
        print(f"CLEANUP       {problem}", file=stream)

    failed = [check for check, status, _ in results if status == FAIL]
    inconclusive = [check for check, status, _ in results if status == INCONCLUSIVE]

    critical_failed = [check for check in failed + inconclusive if check.critical]
    if critical_failed:
        print(
            "\n*** THE BUCKET MAY BE LOCKED. The operator key could not replace the policy. "
            "No other key in the project can either. Do not leave this terminal: raise a "
            "Hetzner support request to remove the bucket policy, and see "
            "RUNBOOK-bucket-fencing.md.",
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
        print("\nEvery check passed, in both directions.", file=stream)
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
        "--dry-run", action="store_true", help="print the probe matrix and run nothing"
    )
    args = parser.parse_args(argv)

    probe_key = f"{PROBE_PREFIX}{uuid.uuid4().hex}.txt"
    checks = build_checks(
        bucket=args.bucket,
        foreign_control_bucket=args.foreign_control_bucket,
        policy_file=args.policy_file,
        probe_key=probe_key,
    )

    if args.dry_run:
        for check in checks:
            control = f", control: {check.control.role} {check.control.description}" if check.control else ""
            print(f"{check.expect:<5} {check.probe.role:<9} {check.name}{control}")
        return 0

    try:
        credentials = read_credentials(environ)
    except VerifierError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    verifier = Verifier(
        endpoint=args.endpoint, region=args.region, credentials=credentials, runner=runner
    )
    results = [(check, *verifier.check(check)) for check in checks]
    problems = cleanup(verifier, args.bucket)
    return report(results, problems, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
