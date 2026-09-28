"""Tests for the live role-fence probe.

The fake endpoint here answers every request by evaluating the policy the
renderer actually emits, through `bucketpolicy.decide`. So a PASS below means
the probe's expectations and the renderer's role table agree -- and the
sabotage cases show the probe going red when the fence is wrong, and refusing
to go green when nothing works at all.
"""

from __future__ import annotations

import contextlib
import http.server
import importlib.util
import io
import json
import pathlib
import re
import shutil
import subprocess
import threading
import unittest
import urllib.parse
from unittest import mock

import bucketpolicy

_HERE = pathlib.Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = _load("probe_backup_role_fence", "probe-backup-role-fence.py")
fence = _load("render_bucket_fence_policy_for_probe", "render-bucket-fence-policy.py")

PROJECT = "1231234"
BUCKET = "branchleft-backups"
KEYS = {
    "operator": ("OPERATOR0000000000000", "operator/secret+key=000000000000"),
    "writer": ("WRITER00000000000000", "writer/secret+key=0000000000000"),
    "reader": ("READER00000000000000", "reader/secret+key=0000000000000"),
}
ENVIRON = {
    var: value
    for role, (key_var, secret_var) in probe.CREDENTIAL_ENV.items()
    for var, value in ((key_var, KEYS[role][0]), (secret_var, KEYS[role][1]))
}


def rendered_fence() -> dict:
    return fence.render_policy(
        BUCKET, PROJECT, [], KEYS["operator"][0],
        writer_access_keys=[KEYS["writer"][0]], reader_access_keys=[KEYS["reader"][0]],
    )


def denied_xml(code: str = "AccessDenied") -> bytes:
    return f"<?xml version='1.0'?><Error><Code>{code}</Code><Message>x</Message></Error>".encode()


def s3_action(method: str, key: str | None, query: dict[str, str]) -> str:
    if key is None and method == "PUT":
        return {"policy": "s3:PutBucketPolicy", "versioning": "s3:PutBucketVersioning"}[
            next(iter(query))]
    if key is not None and "acl" in query:
        return "s3:PutObjectAcl" if method == "PUT" else "s3:GetObjectAcl"
    if key is None:
        if "versions" in query:
            return "s3:ListBucketVersions"
        if "uploads" in query:
            return "s3:ListBucketMultipartUploads"
        if "policy" in query:
            return "s3:GetBucketPolicy"
        return "s3:ListBucket"
    if method in ("PUT", "POST"):
        return "s3:PutObject"
    if method == "DELETE":
        if "uploadId" in query:
            return "s3:AbortMultipartUpload"
        return "s3:DeleteObjectVersion" if "versionId" in query else "s3:DeleteObject"
    if "uploadId" in query:
        return "s3:ListMultipartUploadParts"
    return "s3:GetObjectVersion" if "versionId" in query else "s3:GetObject"


class FakeEndpoint:
    """Stands in for curl and the bucket together, answering from a policy."""

    def __init__(self, policy: dict | None, *, versioning: bool = True, broken_roles=(),
                 transport_down: bool = False, stray_key: str | None = None):
        self.policy = policy
        self.versioning = versioning
        self.broken_roles = set(broken_roles)
        self.transport_down = transport_down
        self.stray_key = stray_key
        self.versions: list[tuple[str, str]] = []
        self.config_writes: list = []
        self.counter = 0
        self.calls: list[tuple[str, str, str | None, dict]] = []
        self.argvs: list[list[str]] = []
        self.envs: list[dict] = []

    def role_of(self, config: bytes) -> tuple[str, str]:
        user = config.decode().split('"')[1].replace('\\"', '"').replace("\\\\", "\\")
        access_key = user.split(":", 1)[0]
        role = next(r for r, (k, _) in KEYS.items() if k == access_key)
        return role, access_key

    def decide(self, access_key: str, action: str, key: str | None) -> str:
        if self.policy is None:
            return "deny"
        resource = f"arn:aws:s3:::{BUCKET}" + (f"/{key}" if key is not None else "")
        return bucketpolicy.decide(
            self.policy, bucketpolicy.key_principal(PROJECT, access_key), action, resource
        )

    def __call__(self, argv, *, input, capture_output, env, timeout, check):
        self.argvs.append(list(argv))
        self.envs.append(env)
        if self.transport_down:
            return subprocess.CompletedProcess(argv, 7, b"", b"curl: (7) Failed to connect")
        method = argv[argv.index("--request") + 1]
        body_path = argv[argv.index("--output") + 1]
        header_path = argv[argv.index("--dump-header") + 1]
        url = urllib.parse.urlsplit(argv[-1])
        path = urllib.parse.unquote(url.path)
        key = path.split("/", 2)[2] if path.count("/") >= 2 else None
        query = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
        role, access_key = self.role_of(input)
        action = s3_action(method, key, query)
        self.last_payload = None
        if "--data-binary" in argv:
            with open(argv[argv.index("--data-binary") + 1].removeprefix("@"), "rb") as handle:
                self.last_payload = handle.read()
        self.last_headers = [argv[i + 1] for i, a in enumerate(argv) if a == "--header"]
        self.calls.append((role, action, key, query))
        status, body, headers = self.respond(role, access_key, action, method, key, query)
        with open(body_path, "wb") as handle:
            handle.write(body)
        with open(header_path, "w") as handle:
            if method == "PUT":
                handle.write("HTTP/1.1 100 Continue\r\n\r\n")
            handle.write(f"HTTP/1.1 {status} X\r\n")
            for name, value in headers.items():
                handle.write(f"{name}: {value}\r\n")
        return subprocess.CompletedProcess(argv, 0, str(status).encode(), b"")

    def respond(self, role, access_key, action, method, key, query):
        if role in self.broken_roles:
            return 403, denied_xml("InvalidAccessKeyId"), {}
        if self.decide(access_key, action, key) != "allow":
            return 403, denied_xml(), {}
        if action == "s3:GetBucketPolicy":
            return 200, json.dumps(self.policy or {}).encode(), {}
        if action in ("s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutObjectAcl"):
            self.config_writes.append((role, action, self.last_payload, self.last_headers))
            return 200, b"", {}
        if action == "s3:PutObject" and method == "PUT":
            self.counter += 1
            version = f"v{self.counter}" if self.versioning else "null"
            self.versions.append((key, version))
            return 200, b"", {"x-amz-version-id": version, "ETag": '"e"'}
        if action == "s3:PutObject" and method == "POST":
            return 200, b"<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>", {}
        if action == "s3:ListBucketVersions":
            prefix = query.get("prefix", "")
            entries = "".join(
                f"<Version><Key>{k}</Key><VersionId>{v}</VersionId></Version>"
                for k, v in self.versions if k.startswith(prefix)
            )
            if self.stray_key:
                entries += f"<Version><Key>{self.stray_key}</Key><VersionId>s1</VersionId></Version>"
            return 200, f"<ListVersionsResult>{entries}</ListVersionsResult>".encode(), {}
        if action == "s3:DeleteObjectVersion":
            self.versions = [(k, v) for k, v in self.versions
                             if not (k == key and v == query["versionId"])]
            return 204, b"", {}
        if action == "s3:DeleteObject":
            self.counter += 1
            self.versions.append((key, f"marker{self.counter}"))
            return 204, b"", {}
        return 200, b"<ok/>", {}


def run_probe(endpoint: FakeEndpoint, **kwargs) -> tuple[int, list[str]]:
    curl = probe.Curl(host="hel1.example.test", region="hel1", bucket=BUCKET,
                      credentials=probe.read_credentials(ENVIRON), run=endpoint)
    with mock.patch.object(probe, "_sleep") as sleep, contextlib.redirect_stderr(io.StringIO()):
        code, lines = probe.probe(curl, dwell=kwargs.get("dwell", 120.0),
                                  recheck=kwargs.get("recheck", 30.0), run_id="run1")
    run_probe.sleeps = [c.args[0] for c in sleep.call_args_list]
    return code, lines


def line_for(lines: list[str], name: str) -> str:
    return next(line for line in lines if line.endswith(name) or f"{name}  --" in line)


class TestAgainstTheRenderedFence(unittest.TestCase):
    def test_the_rendered_fence_passes_every_check_in_both_passes(self):
        endpoint = FakeEndpoint(rendered_fence())
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 0, "\n".join(lines))
        self.assertTrue(all(line.startswith("PASS") for line in lines), "\n".join(lines))
        self.assertEqual(len(lines), 29)

    def test_it_proves_each_allow_and_each_deny_per_role(self):
        _, lines = run_probe(FakeEndpoint(rendered_fence()))
        text = "\n".join(lines)
        for role, expect, name in [
            ("writer", "allow", "writer PUTs a new object"),
            ("writer", "deny", "writer GETs an object"),
            ("writer", "deny", "writer lists the bucket"),
            ("writer", "deny", "writer DELETEs an object"),
            ("writer", "deny", "writer DELETEs an object version"),
            ("writer", "deny", "writer aborts a multipart upload"),
            ("reader", "allow", "reader GETs an object"),
            ("reader", "allow", "reader lists the bucket"),
            ("reader", "deny", "reader PUTs an object"),
            ("reader", "deny", "reader DELETEs an object"),
        ]:
            self.assertRegex(text, rf"PASS\s+{role}\s+expect {expect}\s+{name}")

    def test_it_waits_out_the_cache_before_the_first_pass_and_between_passes(self):
        endpoint = FakeEndpoint(rendered_fence())
        run_probe(endpoint, dwell=120.0, recheck=30.0)
        self.assertEqual(run_probe.sleeps, [120.0, 30.0])

    def test_it_cleans_up_every_version_it_wrote(self):
        endpoint = FakeEndpoint(rendered_fence())
        _, lines = run_probe(endpoint)
        self.assertEqual(endpoint.versions, [])
        self.assertFalse(any(line.startswith("LEFTOVER") for line in lines))
        self.assertIn(("operator", "s3:AbortMultipartUpload", f"{probe.PROBE_PREFIX}/run1/upload",
                       {"uploadId": "up-1"}), endpoint.calls)

    def test_every_write_stays_under_the_run_prefix(self):
        endpoint = FakeEndpoint(rendered_fence())
        run_probe(endpoint)
        for role, action, key, _ in endpoint.calls:
            if action in ("s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"):
                self.assertTrue(key.startswith(f"{probe.PROBE_PREFIX}/run1/"), key)


class TestItGoesRed(unittest.TestCase):
    def test_a_writer_that_can_read_and_delete_fails(self):
        # The sabotage: drop the put-only key's explicit Deny. The object
        # catch-all still exempts it, so it falls to the project default.
        policy = rendered_fence()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyPutOnlyKeysReadsAndRemovals"
        ]
        code, lines = run_probe(FakeEndpoint(policy))
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "writer GETs an object").startswith("FAIL"))
        self.assertTrue(line_for(lines, "writer DELETEs an object").startswith("FAIL"))

    def test_a_reader_that_can_write_fails(self):
        policy = rendered_fence()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyReadOnlyKeysMutations"
        ]
        code, lines = run_probe(FakeEndpoint(policy))
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "reader PUTs an object").startswith("FAIL"))

    def test_no_fence_at_all_fails(self):
        # Hetzner's project default: every key can do everything.
        code, _ = run_probe(FakeEndpoint({"Statement": []}))
        self.assertEqual(code, 1)


class TestAnAllDenyIsNeverAPass(unittest.TestCase):
    def test_everything_denied_is_inconclusive(self):
        endpoint = FakeEndpoint(None)
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 2)
        self.assertIn("operator could not write the seed", lines[0])
        self.assertFalse(any(line.startswith("PASS") for line in lines))

    def test_a_dead_writer_key_makes_its_denials_inconclusive_not_passes(self):
        # Setup needs the writer's multipart start, so break the writer after it.
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if role == "writer" and not (method == "POST"):
                return 403, denied_xml("InvalidAccessKeyId"), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        code, lines = run_probe(endpoint)
        self.assertNotEqual(code, 0)
        self.assertTrue(line_for(lines, "writer GETs an object").startswith("INCONCLUSIVE"))
        self.assertTrue(line_for(lines, "writer PUTs a new object").startswith(
            ("FAIL", "INCONCLUSIVE")))

    def test_a_denied_reader_control_makes_reader_denials_inconclusive(self):
        policy = rendered_fence()
        endpoint = FakeEndpoint(policy)
        original = endpoint.decide

        def decide(access_key, action, key):
            if access_key == KEYS["reader"][0]:
                return "deny"
            return original(access_key, action, key)

        endpoint.decide = decide
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "reader GETs an object").startswith("FAIL"))
        self.assertTrue(line_for(lines, "reader PUTs an object").startswith("INCONCLUSIVE"))

    def test_an_unversioned_bucket_stops_before_any_check(self):
        code, lines = run_probe(FakeEndpoint(rendered_fence(), versioning=False))
        self.assertEqual(code, 2)
        self.assertIn("versioning is not enabled", lines[0])

    def test_a_writer_that_cannot_start_an_upload_stops_before_any_check(self):
        endpoint = FakeEndpoint(rendered_fence(), broken_roles={"writer"})
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 2)
        self.assertIn("could not start a multipart upload", lines[0])

    def test_the_transport_down_is_inconclusive(self):
        code, lines = run_probe(FakeEndpoint(rendered_fence(), transport_down=True))
        self.assertEqual(code, 2)
        self.assertTrue(any("could not list" in line for line in lines))

    def test_an_operator_that_cannot_read_its_seed_voids_the_pass(self):
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if role == "operator" and action == "s3:GetObject":
                return 403, denied_xml(), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "writer GETs an object").startswith("INCONCLUSIVE"))


class TestCombine(unittest.TestCase):
    def test_passes_that_disagree_are_inconclusive(self):
        combined = probe.combine({"a": (probe.PASS, "")}, {"a": (probe.INCONCLUSIVE, "x")})
        self.assertEqual(combined["a"][0], probe.INCONCLUSIVE)
        self.assertIn("longer --dwell", combined["a"][1])

    def test_a_failure_in_either_pass_is_a_failure(self):
        for first, second in ((probe.FAIL, probe.PASS), (probe.PASS, probe.FAIL)):
            reason_first = "r1" if first == probe.FAIL else ""
            reason_second = "r2" if second == probe.FAIL else ""
            combined = probe.combine({"a": (first, reason_first)}, {"a": (second, reason_second)})
            self.assertEqual(combined["a"], (probe.FAIL, reason_first or reason_second))

    def test_agreement_stands(self):
        self.assertEqual(probe.combine({"a": (probe.PASS, "")}, {"a": (probe.PASS, "")}),
                         {"a": (probe.PASS, "")})


class TestCredentialsNeverReachTheCommandLine(unittest.TestCase):
    def test_no_secret_in_argv_and_the_child_env_is_constructed(self):
        endpoint = FakeEndpoint(rendered_fence())
        run_probe(endpoint)
        self.assertTrue(endpoint.argvs)
        for argv in endpoint.argvs:
            joined = " ".join(argv)
            for access_key, secret in KEYS.values():
                self.assertNotIn(secret, joined)
                self.assertNotIn(access_key, joined)
            self.assertIn("--aws-sigv4", argv)
            self.assertEqual(argv[argv.index("--aws-sigv4") + 1], "aws:amz:hel1:s3")
        for env in endpoint.envs:
            self.assertEqual(env, probe.CHILD_ENV)

    def test_the_config_escapes_quotes_and_backslashes(self):
        self.assertEqual(probe.curl_config("AK", 'a"b\\c'), b'user = "AK:a\\"b\\\\c"\n')


class TestReadCredentials(unittest.TestCase):
    def test_all_six_are_required_and_named_when_missing(self):
        environ = dict(ENVIRON)
        del environ["PROBE_READER_SECRET_ACCESS_KEY"]
        with self.assertRaises(probe.ProbeError) as caught:
            probe.read_credentials(environ)
        self.assertIn("PROBE_READER_SECRET_ACCESS_KEY", str(caught.exception))

    def test_one_key_in_two_roles_is_refused(self):
        environ = dict(ENVIRON)
        environ["PROBE_READER_ACCESS_KEY_ID"] = environ["PROBE_WRITER_ACCESS_KEY_ID"]
        with self.assertRaises(probe.ProbeError):
            probe.read_credentials(environ)

    def test_malformed_values_are_refused_without_echoing_them(self):
        for var, value in (("PROBE_WRITER_ACCESS_KEY_ID", "bad:key0000000000000"),
                           ("PROBE_WRITER_SECRET_ACCESS_KEY", "has space 0000000000")):
            environ = dict(ENVIRON)
            environ[var] = value
            with self.assertRaises(probe.ProbeError) as caught:
                probe.read_credentials(environ)
            self.assertNotIn(value, str(caught.exception))


class TestTransportPieces(unittest.TestCase):
    def test_endpoint_host(self):
        self.assertEqual(probe.endpoint_host("https://hel1.example.test/"), "hel1.example.test")
        self.assertEqual(probe.endpoint_host("hel1.example.test"), "hel1.example.test")
        for bad in ("http://hel1.example.test", "https://"):
            with self.assertRaises(probe.ProbeError):
                probe.endpoint_host(bad)

    def test_the_url_is_path_style_and_encoded(self):
        curl = probe.Curl(host="h.test", region="hel1", bucket=BUCKET, credentials={})
        self.assertEqual(curl.url("a b/c", {"versions": "", "prefix": "p/"}),
                         f"https://h.test/{BUCKET}/a%20b/c?prefix=p%2F&versions=")
        self.assertEqual(curl.url(None, None), f"https://h.test/{BUCKET}")

    def test_the_last_response_headers_win(self):
        raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nX-Amz-Version-Id: v9\r\n"
        self.assertEqual(probe.parse_headers(raw), {"x-amz-version-id": "v9"})

    def test_hostile_or_broken_xml_yields_nothing(self):
        for body in (b"<!DOCTYPE x><a/>", b"not xml", b""):
            self.assertEqual(probe.parse_versions(body), [])
            self.assertEqual(probe._xml_text(body, "UploadId"), [])

    def test_a_curl_that_cannot_start_is_an_error_not_a_denial(self):
        def run(*args, **kwargs):
            raise FileNotFoundError("curl")

        curl = probe.Curl(host="h.test", region="hel1", bucket=BUCKET,
                          credentials={"writer": KEYS["writer"]}, run=run)
        outcome, reason = curl.request("writer", "GET", "k").outcome()
        self.assertEqual(outcome, "error")
        self.assertIn("FileNotFoundError", reason)

    def test_a_stray_key_in_the_cleanup_listing_is_reported_and_left_alone(self):
        endpoint = FakeEndpoint(rendered_fence(), stray_key="dumps/real-backup.sql.age")
        _, lines = run_probe(endpoint)
        self.assertTrue(any("dumps/real-backup.sql.age" in line and line.startswith("LEFTOVER")
                            for line in lines))
        self.assertNotIn(("operator", "s3:DeleteObjectVersion", "dumps/real-backup.sql.age",
                          {"versionId": "s1"}), endpoint.calls)

    def test_a_failed_cleanup_delete_is_reported(self):
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if role == "operator" and action in ("s3:DeleteObjectVersion", "s3:AbortMultipartUpload"):
                return 403, denied_xml(), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        _, lines = run_probe(endpoint)
        self.assertTrue(any(line.startswith("LEFTOVER") and "version" in line for line in lines))
        self.assertTrue(any(line.startswith("LEFTOVER") and "multipart" in line for line in lines))


class _Recorder(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def do_GET(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        type(self).seen.append((dict(self.headers), self.path, body))
        self.send_response(403)
        self.end_headers()
        self.wfile.write(denied_xml())

    do_PUT = do_GET

    def log_message(self, *args):
        pass


@unittest.skipUnless(shutil.which("curl", path=probe.CHILD_ENV["PATH"]), "curl is not installed")
class TestTheRealCurlSigns(unittest.TestCase):
    """Through the real binary: the credential arrives on stdin and is used."""

    def test_curl_signs_with_the_key_from_stdin_and_reads_the_denial(self):
        _Recorder.seen = []
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            curl = probe.Curl(host="unused", region="hel1", bucket=BUCKET,
                              credentials={"writer": KEYS["writer"]})
            with mock.patch.object(
                probe.Curl, "url",
                lambda self, key, query: f"http://127.0.0.1:{port}/{BUCKET}/{key}",
            ):
                outcome, reason = curl.request("writer", "GET", "k").outcome()
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual((outcome, reason), ("denied", "AccessDenied"))
        headers, path, _ = _Recorder.seen[0]
        self.assertEqual(path, f"/{BUCKET}/k")
        authorization = headers.get("Authorization", "")
        self.assertTrue(authorization.startswith("AWS4-HMAC-SHA256 Credential=" + KEYS["writer"][0]),
                        authorization)
        self.assertIn("/hel1/s3/aws4_request", authorization)
        self.assertNotIn(KEYS["writer"][1], authorization)

    def test_curl_sends_the_payload_from_a_file_and_signs_the_acl_header(self):
        _Recorder.seen = []
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            curl = probe.Curl(host="unused", region="hel1", bucket=BUCKET,
                              credentials={"writer": KEYS["writer"]})
            with mock.patch.object(
                probe.Curl, "url",
                lambda self, key, query: f"http://127.0.0.1:{port}/{BUCKET}/{key}?acl=",
            ):
                outcome, _ = curl.request("writer", "PUT", "k", {"acl": ""}, b"payload-bytes",
                                          probe.PRIVATE_ACL).outcome()
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(outcome, "denied")
        headers, _, body = _Recorder.seen[0]
        self.assertEqual(body, b"payload-bytes")
        self.assertEqual(headers.get("x-amz-acl"), "private")
        signed = headers.get("Authorization", "").split("SignedHeaders=")[1].split(",")[0]
        self.assertIn("x-amz-acl", signed.split(";"))


class TestTheConfigurationDenies(unittest.TestCase):
    """Rewriting the fence, suspending versioning and publishing an object."""

    def test_they_pass_against_the_rendered_fence_with_their_shape_controls(self):
        endpoint = FakeEndpoint(rendered_fence())
        _, lines = run_probe(endpoint)
        text = "\n".join(lines)
        for role, expect, name in [
            ("operator", "allow", probe.OPERATOR_POLICY_PUT),
            ("operator", "allow", probe.OPERATOR_VERSIONING_PUT),
            ("operator", "allow", probe.OPERATOR_ACL_PUT),
            ("writer", "deny", "writer re-PUTs the identical bucket policy"),
            ("writer", "deny", "writer sets versioning to Enabled"),
            ("writer", "deny", "writer sets an ACL on its own object"),
            ("reader", "deny", "reader re-PUTs the identical bucket policy"),
            ("reader", "deny", "reader sets versioning to Enabled"),
        ]:
            self.assertRegex(text, rf"PASS\s+{role}\s+expect {expect}\s+{re.escape(name)}")

    def test_every_write_is_a_no_op_if_it_lands(self):
        endpoint = FakeEndpoint(rendered_fence())
        run_probe(endpoint)
        stored = json.dumps(rendered_fence()).encode()
        writes = {action: (payload, headers) for _, action, payload, headers in endpoint.config_writes}
        self.assertEqual(writes["s3:PutBucketPolicy"][0], stored)
        self.assertIn(b"<Status>Enabled</Status>", writes["s3:PutBucketVersioning"][0])
        self.assertEqual(writes["s3:PutObjectAcl"][1], ["x-amz-acl: private"])
        for _, action, _, _ in endpoint.config_writes:
            self.assertIn(action, writes)
        self.assertEqual({role for role, *_ in endpoint.config_writes}, {"operator"})

    def test_a_reader_that_can_rewrite_the_fence_fails(self):
        # The sabotage: the configuration deny is gone. The writer is still
        # held by the bucket catch-all; the reader, exempt from it, is not.
        policy = rendered_fence()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyBucketConfigurationExceptOperator"
        ]
        code, lines = run_probe(FakeEndpoint(policy))
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "reader re-PUTs the identical bucket policy").startswith("FAIL"))
        self.assertTrue(line_for(lines, "writer re-PUTs the identical bucket policy").startswith("PASS"))

    def test_a_writer_that_can_rewrite_the_fence_fails(self):
        policy = rendered_fence()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyBucketConfigurationExceptOperator"
        ]
        for s in policy["Statement"]:
            if s["Sid"] == "DenyBucketAccessExceptNamedKeys":
                s["NotPrincipal"]["AWS"].append(bucketpolicy.key_principal(PROJECT, KEYS["writer"][0]))
        code, lines = run_probe(FakeEndpoint(policy))
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "writer re-PUTs the identical bucket policy").startswith("FAIL"))
        self.assertTrue(line_for(lines, "writer sets versioning to Enabled").startswith("FAIL"))

    def test_a_writer_that_can_set_an_acl_fails(self):
        policy = rendered_fence()
        for s in policy["Statement"]:
            if s["Sid"] in ("DenyPutOnlyKeysReadsAndRemovals", "DenyObjectMutationsExceptOperator"):
                s["Action"] = [a for a in s["Action"] if a != "s3:PutObjectAcl"]
        code, lines = run_probe(FakeEndpoint(policy))
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, "writer sets an ACL on its own object").startswith("FAIL"))

    def test_a_request_the_operator_cannot_make_proves_no_denial(self):
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if action == "s3:PutBucketVersioning":
                return 400, denied_xml("MalformedXML"), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 2)
        self.assertTrue(line_for(lines, "writer sets versioning to Enabled").startswith("INCONCLUSIVE"))

    def test_an_operator_denied_its_shape_request_voids_the_denial(self):
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if role == "operator" and action == "s3:PutObjectAcl":
                return 403, denied_xml(), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 1)
        self.assertTrue(line_for(lines, probe.OPERATOR_ACL_PUT).startswith("FAIL"))
        self.assertTrue(line_for(lines, "writer sets an ACL on its own object").startswith(
            "INCONCLUSIVE"))

    def test_an_unreadable_policy_stops_before_any_check(self):
        endpoint = FakeEndpoint(rendered_fence())
        original = endpoint.respond

        def respond(role, access_key, action, method, key, query):
            if action == "s3:GetBucketPolicy" and role == "operator":
                return 404, denied_xml("NoSuchBucketPolicy"), {}
            return original(role, access_key, action, method, key, query)

        endpoint.respond = respond
        code, lines = run_probe(endpoint)
        self.assertEqual(code, 2)
        self.assertIn("could not read the bucket policy", lines[0])


class TestMain(unittest.TestCase):
    def run_main(self, argv, environ=ENVIRON, run=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(probe, "_sleep"):
            code = probe.main(argv, environ=environ, run=run or FakeEndpoint(rendered_fence()))
        return code, out.getvalue(), err.getvalue()

    def test_a_good_fence_exits_zero_with_a_pass_result(self):
        code, out, _ = self.run_main(["--bucket", BUCKET])
        self.assertEqual(code, 0)
        self.assertIn("RESULT: PASS", out)

    def test_a_bad_fence_exits_one(self):
        code, out, _ = self.run_main(["--bucket", BUCKET], run=FakeEndpoint({"Statement": []}))
        self.assertEqual(code, 1)
        self.assertIn("RESULT: FAIL", out)

    def test_an_all_deny_exits_two(self):
        code, out, _ = self.run_main(["--bucket", BUCKET], run=FakeEndpoint(None))
        self.assertEqual(code, 2)
        self.assertIn("RESULT: INCONCLUSIVE", out)

    def test_a_dwell_inside_the_cache_window_is_refused(self):
        code, _, err = self.run_main(["--bucket", BUCKET, "--dwell", "5"])
        self.assertEqual(code, 2)
        self.assertIn("cache window", err)

    def test_bad_inputs_are_refused_before_any_request(self):
        endpoint = FakeEndpoint(rendered_fence())
        for argv, environ in ((["--bucket", "Bad.Bucket"], ENVIRON),
                              (["--bucket", BUCKET, "--endpoint", "http://x"], ENVIRON),
                              (["--bucket", BUCKET], {})):
            code, _, _ = self.run_main(argv, environ=environ, run=endpoint)
            self.assertEqual(code, 2)
        self.assertEqual(endpoint.calls, [])


if __name__ == "__main__":
    unittest.main()
