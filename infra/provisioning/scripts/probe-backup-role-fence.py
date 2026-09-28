#!/usr/bin/env python3
"""Prove the role-aware backup fence against the live bucket, one role at a time.

Run by hand by the platform owner, after the fence rendered with
`render-bucket-fence-policy.py --writer-access-key ... --reader-access-key ...`
has been applied. It writes only under a probe prefix, and the operator key
removes every version it wrote before it exits.

WHY CURL. Every request goes out through `curl --aws-sigv4`, because `aws
s3api` v2 renders no S3 error code for this endpoint's error documents, and a
denial is only a denial when its `Code` says `AccessDenied`. The same 403
answers a wrong key, a wrong region and a working fence; `classify()` from
`verify-bucket-fence.py` reads the code and is reused here rather than copied.

WHY IT WAITS. The engine's policy read path serves the previous decision for a
while after a change. A probe inside that window reads the old policy, which
after a first apply is Hetzner's project default -- allow everything -- and
after a re-apply can be a stricter old fence that makes a wrong new one look
right. So the probe waits `--dwell` seconds before its first pass, then runs
every check a second time after `--recheck` more, and a check whose two
passes disagree is INCONCLUSIVE, never PASS.

WHY THERE ARE CONTROLS. A key that reaches nothing is denied everything, and
an all-deny must not read as a fenced bucket. Every denial is counted only if
the same role's control -- the one action that role must be able to do --
succeeded in the same pass. The operator's seed write is the control for the
run as a whole: if it fails, nothing after it is evidence.

WHAT IT CANNOT PROVE. It probes the actions it names. `HeadObject` is not
probed separately: it is authorised as `GetObject`, and a HEAD response
carries no body, so its denial has no error code to read. An action outside the
parser's vocabulary cannot be named in any policy on this engine, so it
cannot be denied, and it is not probed either.

Credentials come from six environment variables, read by name and handed to
curl on stdin, never on its command line where `ps` would show them:

  PROBE_OPERATOR_ACCESS_KEY_ID  PROBE_OPERATOR_SECRET_ACCESS_KEY
  PROBE_WRITER_ACCESS_KEY_ID    PROBE_WRITER_SECRET_ACCESS_KEY
  PROBE_READER_ACCESS_KEY_ID    PROBE_READER_SECRET_ACCESS_KEY

Exit status: 0 every check passed in both passes; 1 a check failed; 2 the
run was inconclusive or could not start.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET

_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("verify_bucket_fence", _HERE / "verify-bucket-fence.py")
assert _spec is not None and _spec.loader is not None
_verifier = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_verifier)
classify = _verifier.classify

from bucketpolicy import validate_bucket_name  # noqa: E402

PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"

ROLES = ("operator", "writer", "reader")
CREDENTIAL_ENV = {
    role: (f"PROBE_{role.upper()}_ACCESS_KEY_ID", f"PROBE_{role.upper()}_SECRET_ACCESS_KEY")
    for role in ROLES
}

# Measured on this endpoint: applying a policy has taken up to 60s to answer.
# Twice that, as `verify-bucket-fence.py`'s DWELL_SECONDS reasons.
DEFAULT_DWELL_SECONDS = 120.0
DEFAULT_RECHECK_SECONDS = 30.0
PROBE_PREFIX = "fence-probe/role-fence"

# The child gets this and nothing else from the environment. The shell that
# runs this probe exports live credentials for other systems.
CHILD_ENV = {"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "LC_ALL": "C"}

_ACCESS_KEY = re.compile(r"\A[A-Za-z0-9]{16,64}\Z")
_SECRET_KEY = re.compile(r"\A[A-Za-z0-9/+=]{16,128}\Z")

_sleep = time.sleep


class ProbeError(Exception):
    """The probe could not be set up, so no verdict is available."""


class Response:
    def __init__(self, status: int | None, body: bytes, headers: dict[str, str], failure: str = ""):
        self.status = status
        self.body = body
        self.headers = headers
        self.failure = failure

    def outcome(self) -> tuple[str, str]:
        return classify(self.status, self.body, self.failure)


def read_credentials(environ) -> dict[str, tuple[str, str]]:
    credentials = {}
    missing = []
    for role, (key_var, secret_var) in CREDENTIAL_ENV.items():
        access_key = environ.get(key_var, "")
        secret_key = environ.get(secret_var, "")
        if not access_key or not secret_key:
            missing.extend(v for v, value in ((key_var, access_key), (secret_var, secret_key)) if not value)
            continue
        if not _ACCESS_KEY.match(access_key):
            raise ProbeError(f"{key_var} is not an access key id (16-64 alphanumerics)")
        if not _SECRET_KEY.match(secret_key):
            raise ProbeError(f"{secret_var} does not look like a secret key")
        credentials[role] = (access_key, secret_key)
    if missing:
        raise ProbeError("not set: " + ", ".join(missing))
    ids = [credentials[role][0] for role in ROLES]
    if len(set(ids)) != len(ids):
        raise ProbeError(
            "two roles were given the same access key. Each role's checks are only evidence "
            "about that role if the key is that role's alone."
        )
    return credentials


def endpoint_host(endpoint: str) -> str:
    if "//" not in endpoint:
        return endpoint.strip("/")
    parts = urllib.parse.urlsplit(endpoint)
    if parts.scheme != "https" or not parts.netloc:
        raise ProbeError(f"--endpoint must be an https URL; {endpoint!r} would send a signature in the clear")
    return parts.netloc


def curl_config(access_key: str, secret_key: str) -> bytes:
    """A curl config carrying the credential, fed on stdin."""
    value = f"{access_key}:{secret_key}".replace("\\", "\\\\").replace('"', '\\"')
    return f'user = "{value}"\n'.encode()


class Curl:
    """One signed request per call, through the real curl binary."""

    def __init__(self, *, host: str, region: str, bucket: str, credentials, run=subprocess.run):
        self.host = host
        self.region = region
        self.bucket = bucket
        self.credentials = credentials
        self.run = run

    def url(self, key: str | None, query: dict[str, str] | None) -> str:
        path = f"/{self.bucket}"
        if key is not None:
            path += "/" + urllib.parse.quote(key, safe="/-_.~")
        url = f"https://{self.host}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(sorted(query.items()), quote_via=urllib.parse.quote)
        return url

    def argv(self, method: str, url: str, body_path: str, header_path: str, payload: bytes | None) -> list[str]:
        argv = [
            "curl", "--silent", "--show-error", "--config", "-",
            "--aws-sigv4", f"aws:amz:{self.region}:s3",
            "--output", body_path, "--dump-header", header_path,
            "--write-out", "%{http_code}",
            "--max-time", "60",
        ]
        argv += ["--request", method]
        if payload is not None:
            argv += ["--data-binary", payload.decode()]
        argv.append(url)
        return argv

    def request(self, role: str, method: str, key: str | None = None,
                query: dict[str, str] | None = None, payload: bytes | None = None) -> Response:
        access_key, secret_key = self.credentials[role]
        with tempfile.TemporaryDirectory(prefix="role-fence-probe-") as scratch:
            body_path = os.path.join(scratch, "body")
            header_path = os.path.join(scratch, "headers")
            argv = self.argv(method, self.url(key, query), body_path, header_path, payload)
            try:
                done = self.run(
                    argv, input=curl_config(access_key, secret_key),
                    capture_output=True, env=dict(CHILD_ENV), timeout=90, check=False,
                )
            except (OSError, subprocess.SubprocessError) as error:
                return Response(None, b"", {}, f"{type(error).__name__}: {error}")
            stdout = done.stdout.decode(errors="replace").strip()
            if done.returncode != 0 or not stdout.isdigit():
                return Response(None, b"", {}, done.stderr.decode(errors="replace").strip()
                                or f"curl exited {done.returncode}")
            body = _read(body_path)
            headers = parse_headers(_read(header_path))
        status = int(stdout)
        return Response(status, body, headers)


def _read(path: str) -> bytes:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return b""


def parse_headers(raw: bytes) -> dict[str, str]:
    """The LAST response's headers, lower-cased. A `100 Continue` precedes a PUT's."""
    headers: dict[str, str] = {}
    for line in raw.decode("latin-1").splitlines():
        if line.startswith("HTTP/"):
            headers = {}
        elif ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    return headers


def _xml_text(body: bytes, tag: str) -> list[str]:
    text = body[: 1024 * 1024].decode("utf-8", errors="replace")
    if "<!DOCTYPE" in text:
        return []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    return [(e.text or "").strip() for e in root.iter() if e.tag.rsplit("}", 1)[-1] == tag]


def parse_versions(body: bytes) -> list[tuple[str, str]]:
    """(key, version id) for every version and delete marker in a listing."""
    text = body[: 4 * 1024 * 1024].decode("utf-8", errors="replace")
    if "<!DOCTYPE" in text:
        return []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    found = []
    for element in root:
        if element.tag.rsplit("}", 1)[-1] not in ("Version", "DeleteMarker"):
            continue
        fields = {child.tag.rsplit("}", 1)[-1]: (child.text or "") for child in element}
        if fields.get("Key") and fields.get("VersionId"):
            found.append((fields["Key"], fields["VersionId"]))
    return found


class Check:
    def __init__(self, role: str, name: str, expect: str, method: str, key=None, query=None,
                 payload=None, control: bool = False):
        self.role = role
        self.name = name
        self.expect = expect
        self.method = method
        self.key = key
        self.query = query
        self.payload = payload
        self.control = control


def build_checks(run_prefix: str, seed_key: str, seed_version: str, upload_key: str,
                 upload_id: str) -> list[Check]:
    """Each role's controls first, then its denials. Removals run last in a pass."""
    listing = {"list-type": "2", "prefix": run_prefix, "max-keys": "5"}
    versions = {"versions": "", "prefix": run_prefix, "max-keys": "5"}
    by_version = {"versionId": seed_version}
    upload = {"uploadId": upload_id}
    body = b"role-fence-probe"
    return [
        Check("operator", "operator reads the seed", "allow", "GET", seed_key, control=True),
        Check("writer", "writer PUTs a new object", "allow", "PUT",
              f"{run_prefix}writer-object", payload=body, control=True),
        Check("writer", "writer GETs an object", "deny", "GET", seed_key),
        Check("writer", "writer GETs an object version", "deny", "GET", seed_key, by_version),
        Check("writer", "writer lists the bucket", "deny", "GET", None, listing),
        Check("writer", "writer lists object versions", "deny", "GET", None, versions),
        Check("writer", "writer lists multipart uploads", "deny", "GET", None, {"uploads": ""}),
        Check("writer", "writer lists an upload's parts", "deny", "GET", upload_key, upload),
        Check("writer", "writer reads the bucket policy", "deny", "GET", None, {"policy": ""}),
        Check("reader", "reader GETs an object", "allow", "GET", seed_key, control=True),
        Check("reader", "reader lists the bucket", "allow", "GET", None, listing, control=True),
        Check("reader", "reader lists object versions", "allow", "GET", None, versions),
        Check("reader", "reader GETs an object version", "allow", "GET", seed_key, by_version),
        Check("reader", "reader PUTs an object", "deny", "PUT",
              f"{run_prefix}reader-object", payload=body),
        Check("reader", "reader reads the bucket policy", "deny", "GET", None, {"policy": ""}),
        Check("writer", "writer aborts a multipart upload", "deny", "DELETE", upload_key, upload),
        Check("reader", "reader aborts a multipart upload", "deny", "DELETE", upload_key, upload),
        Check("writer", "writer DELETEs an object", "deny", "DELETE", seed_key),
        Check("writer", "writer DELETEs an object version", "deny", "DELETE", seed_key, by_version),
        Check("reader", "reader DELETEs an object", "deny", "DELETE", seed_key),
        Check("reader", "reader DELETEs an object version", "deny", "DELETE", seed_key, by_version),
    ]


def run_pass(curl: Curl, checks: list[Check]) -> dict[str, tuple[str, str]]:
    """Every check once. Returns name -> (verdict, reason)."""
    outcomes = {c.name: curl.request(c.role, c.method, c.key, c.query, c.payload).outcome()
                for c in checks}
    controls_ok = {role: True for role in ROLES}
    for c in checks:
        if c.control and outcomes[c.name][0] != "allowed":
            controls_ok[c.role] = False
    results = {}
    for c in checks:
        outcome, reason = outcomes[c.name]
        if not controls_ok["operator"] and c.role != "operator":
            results[c.name] = (INCONCLUSIVE, "the operator could not read its own seed, so "
                               "nothing in this pass is evidence about the fence")
        elif outcome == "error":
            results[c.name] = (INCONCLUSIVE, reason)
        elif c.expect == "allow":
            results[c.name] = (PASS, "") if outcome == "allowed" else (
                FAIL, f"this role must be able to do this, and was denied ({reason})")
        elif not controls_ok[c.role]:
            results[c.name] = (INCONCLUSIVE, f"the {c.role} key's control did not succeed in "
                               "this pass, so a denial is not evidence about the fence")
        else:
            results[c.name] = (PASS, "") if outcome == "denied" else (
                FAIL, "the fence did not deny this")
    return results


def combine(first: dict, second: dict) -> dict[str, tuple[str, str]]:
    """Both passes must agree. A disagreement is the cache, not a verdict."""
    combined = {}
    for name, (verdict, reason) in first.items():
        again, again_reason = second[name]
        if FAIL in (verdict, again):
            combined[name] = (FAIL, reason or again_reason)
        elif verdict == again:
            combined[name] = (verdict, reason)
        else:
            combined[name] = (INCONCLUSIVE, f"the two passes disagree ({verdict} then {again}); "
                              "the policy cache may not have settled -- re-run with a longer --dwell")
    return combined


def seed(curl: Curl, run_prefix: str) -> tuple[str, str, str, str]:
    seed_key = f"{run_prefix}seed"
    response = curl.request("operator", "PUT", seed_key, payload=b"role-fence-probe seed")
    outcome, reason = response.outcome()
    if outcome != "allowed":
        raise ProbeError(
            f"the operator could not write the seed object ({outcome}: {reason}). Without it "
            f"no denial below is evidence: check the operator key and the bucket name."
        )
    seed_version = response.headers.get("x-amz-version-id", "")
    if not seed_version or seed_version == "null":
        raise ProbeError("the seed write returned no version id: versioning is not enabled on "
                         "this bucket, and the version probes would test nothing")
    upload_key = f"{run_prefix}upload"
    response = curl.request("writer", "POST", upload_key, {"uploads": ""})
    outcome, reason = response.outcome()
    upload_ids = _xml_text(response.body, "UploadId") if outcome == "allowed" else []
    if not upload_ids or not upload_ids[0]:
        raise ProbeError(
            f"the writer could not start a multipart upload ({outcome}: {reason}). That is "
            f"its put permission; if it fails, the writer's control fails too."
        )
    return seed_key, seed_version, upload_key, upload_ids[0]


def cleanup(curl: Curl, run_prefix: str, upload_key: str | None, upload_id: str | None) -> list[str]:
    """Remove every version under this run's prefix as the operator. Returns leftovers."""
    problems = []
    if upload_key and upload_id:
        outcome, reason = curl.request("operator", "DELETE", upload_key, {"uploadId": upload_id}).outcome()
        if outcome != "allowed":
            problems.append(f"multipart upload {upload_id} under {upload_key}: {outcome} {reason}")
    response = curl.request("operator", "GET", None, {"versions": "", "prefix": run_prefix})
    outcome, reason = response.outcome()
    if outcome != "allowed":
        return problems + [f"could not list {run_prefix} to clean it up: {outcome} {reason}"]
    for key, version in parse_versions(response.body):
        if not key.startswith(run_prefix):
            problems.append(f"the listing returned {key!r}, outside {run_prefix}; not touched")
            continue
        outcome, reason = curl.request("operator", "DELETE", key, {"versionId": version}).outcome()
        if outcome != "allowed":
            problems.append(f"{key} version {version}: {outcome} {reason}")
    return problems


def wait(seconds: float, why: str) -> None:
    if seconds <= 0:
        return
    print(f"waiting {seconds:g}s: {why}", file=sys.stderr)
    _sleep(seconds)


def probe(curl: Curl, *, dwell: float, recheck: float, run_id: str) -> tuple[int, list[str]]:
    run_prefix = f"{PROBE_PREFIX}/{run_id}/"
    wait(dwell, "the policy read path serves the previous decision for a while after a change")
    lines = []
    upload_key = upload_id = None
    try:
        seed_key, seed_version, upload_key, upload_id = seed(curl, run_prefix)
        checks = build_checks(run_prefix, seed_key, seed_version, upload_key, upload_id)
        first = run_pass(curl, checks)
        wait(recheck, "second pass, so a result the cache produced cannot stand alone")
        second = run_pass(curl, checks)
        results = combine(first, second)
    except ProbeError as error:
        results = None
        lines.append(f"{INCONCLUSIVE}  setup: {error}")
    finally:
        leftovers = cleanup(curl, run_prefix, upload_key, upload_id)
    if results is not None:
        for check in checks:
            verdict, reason = results[check.name]
            lines.append(f"{verdict:<12}  {check.role:<8}  expect {check.expect:<5}  {check.name}"
                         + (f"  -- {reason}" if reason else ""))
    for problem in leftovers:
        lines.append(f"LEFTOVER      {problem}")
    if results is None:
        return 2, lines
    verdicts = {v for v, _ in results.values()}
    if FAIL in verdicts:
        return 1, lines
    if INCONCLUSIVE in verdicts:
        return 2, lines
    return 0, lines


def main(argv: list[str] | None = None, environ=None, run=subprocess.run) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", default="https://hel1.your-objectstorage.com")
    parser.add_argument("--region", default="hel1")
    parser.add_argument("--dwell", type=float, default=DEFAULT_DWELL_SECONDS,
                        help="seconds to wait before the first pass (default %(default)s)")
    parser.add_argument("--recheck", type=float, default=DEFAULT_RECHECK_SECONDS,
                        help="seconds between the two passes (default %(default)s)")
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ
    try:
        validate_bucket_name(args.bucket)
        if args.dwell < 20:
            raise ProbeError("--dwell below 20s is inside the policy cache window; the first "
                             "pass would read the previous policy")
        credentials = read_credentials(environ)
        curl = Curl(host=endpoint_host(args.endpoint), region=args.region, bucket=args.bucket,
                    credentials=credentials, run=run)
    except (ProbeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    code, lines = probe(curl, dwell=args.dwell, recheck=args.recheck, run_id=uuid.uuid4().hex)
    for line in lines:
        print(line)
    print({0: "RESULT: PASS -- every allow and every deny held, in both passes",
           1: "RESULT: FAIL -- the fence does not do what the role table says",
           2: "RESULT: INCONCLUSIVE -- not evidence either way; see the lines above"}[code])
    return code


if __name__ == "__main__":
    raise SystemExit(main())
