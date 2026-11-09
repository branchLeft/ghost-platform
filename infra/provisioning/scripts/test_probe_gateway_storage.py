"""Tests for the gateway storage probes.

Every probe runs against an in-process fake S3 server whose behaviour is set
per location. The fake knows the keys only by id, so these tests prove what
the probe asks and how it reads the answers, never what the real backend does.
"""

from __future__ import annotations

import dataclasses
import hashlib
import http.server
import importlib.util
import io
import json
import pathlib
import re
import sys
import threading
import time
import unittest
import urllib.parse
from unittest import mock

_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "probe_gateway_storage", _HERE / "probe-gateway-storage.py"
)
assert _spec is not None and _spec.loader is not None
probe = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = probe
_spec.loader.exec_module(probe)

OWNER_ID, OWNER_SECRET = "OWNERKEYID00000000A", "ownerSecretValue0123456789abcdef"
FENCE_ID, FENCE_SECRET = "FENCEKEYID00000000B", "fenceSecretValue0123456789abcdef"
NBG1_HOST, FSN1_HOST = "nbg1.storage.example.invalid", "fsn1.storage.example.invalid"
NBG1_BUCKET, FSN1_BUCKET = "probe-bucket-nbg1", "probe-bucket-fsn1"
OWNER_PROJECT, FENCE_PROJECT = "1111", "4242"
XML_ERROR = "<Error><Code>{}</Code></Error>"


@dataclasses.dataclass
class Behaviour:
    head_missing_status: int = 404
    reject_without_crc32: bool = False
    reject_multipart_at: str = ""
    fence_leaks_without_policy: bool = False
    policy_lag: int = 0
    policy_ignored: bool = False
    bucket_project_reads: bool = False
    anonymous_reads: bool = False
    ack_delay: float = 0.0
    truncate_matching: str = ""
    unknown_keys: bool = False


class FakeState:
    def __init__(self, bucket: str, behaviour: Behaviour) -> None:
        self.bucket = bucket
        self.behaviour = behaviour
        self.objects: dict[str, bytes] = {}
        self.writer: dict[str, str] = {}
        self.policy: dict | None = None
        self.fence_since_policy = 0
        self.uploads: dict[str, dict[int, bytes]] = {}
        self.seen_bytes: list[bytes] = []
        self.lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: FakeServer

    def log_message(self, *args: object) -> None:
        return

    def who(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        found = re.search(r"Credential=([A-Za-z0-9]+)/", auth)
        if not found:
            return "anonymous"
        if self.server.state.behaviour.unknown_keys:
            return None
        return {OWNER_ID: "owner", FENCE_ID: "fence"}.get(found.group(1))

    def reply(self, status: int, body: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except OSError:
                pass

    def error(self, status: int, code: str) -> None:
        self.reply(status, XML_ERROR.format(code).encode())

    def admitted(self, who: str, key: str | None) -> bool:
        state = self.server.state
        if who == "owner":
            if key and state.writer.get(key) == "fence":
                return state.behaviour.bucket_project_reads or self.command in (
                    "DELETE",
                    "PUT",
                )
            return True
        if who == "fence":
            if state.policy is not None and not state.behaviour.policy_ignored:
                state.fence_since_policy += 1
                return state.fence_since_policy > state.behaviour.policy_lag
            return state.behaviour.fence_leaks_without_policy
        return state.behaviour.anonymous_reads

    def handle_any(self) -> None:
        state = self.server.state
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        with state.lock:
            state.seen_bytes.append(
                str(self.headers).encode() + self.path.encode() + body
            )
        parts = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
        segments = parts.path.lstrip("/").split("/", 1)
        bucket, key = segments[0], (segments[1] if len(segments) > 1 else None)
        who = self.who()
        if who is None:
            return self.error(403, "InvalidAccessKeyId")
        if parts.path == "/":
            if who == "anonymous":
                return self.error(403, "AccessDenied")
            project = OWNER_PROJECT if who == "owner" else FENCE_PROJECT
            return self.reply(
                200,
                f"<ListAllMyBucketsResult><Owner><ID>p{project}</ID></Owner></ListAllMyBucketsResult>".encode(),
            )
        if bucket != state.bucket:
            return self.error(404, "NoSuchBucket")
        if "policy" in query:
            if who != "owner":
                return self.error(403, "AccessDenied")
            with state.lock:
                if self.command == "PUT":
                    state.policy = json.loads(body)
                    state.fence_since_policy = 0
                    return self.reply(204)
                state.policy = None
            return self.reply(204)
        if (
            body
            and self.headers.get("x-amz-content-sha256")
            != hashlib.sha256(body).hexdigest()
        ):
            return self.error(400, "XAmzContentSHA256Mismatch")
        if not self.admitted(who, key):
            return self.error(403, "AccessDenied")
        if key is None:
            return self.bucket_level(query)
        return self.object_level(who, key, query, body)

    def bucket_level(self, query: dict[str, list[str]]) -> None:
        state = self.server.state
        if self.command == "HEAD":
            return self.reply(200)
        prefix = query.get("prefix", [""])[0]
        keys = sorted(k for k in state.objects if k.startswith(prefix))
        document = "<ListBucketResult>" + "".join(
            f"<Contents><Key>{k}</Key></Contents>" for k in keys
        )
        return self.reply(200, (document + "</ListBucketResult>").encode())

    def object_level(
        self, who: str, key: str, query: dict[str, list[str]], body: bytes
    ) -> None:
        state, behaviour = self.server.state, self.server.state.behaviour
        if "uploads" in query and self.command == "POST":
            if behaviour.reject_multipart_at == "create":
                return self.error(501, "NotImplemented")
            with state.lock:
                upload = f"upload-{len(state.uploads) + 1}"
                state.uploads[upload] = {}
            return self.reply(
                200,
                f"<InitiateMultipartUploadResult><UploadId>{upload}</UploadId></InitiateMultipartUploadResult>".encode(),
            )
        if "partNumber" in query:
            if behaviour.reject_multipart_at == "part":
                return self.error(400, "InvalidRequest")
            with state.lock:
                state.uploads[query["uploadId"][0]][int(query["partNumber"][0])] = body
            return self.reply(200)
        if "uploadId" in query and self.command == "POST":
            if behaviour.reject_multipart_at == "complete":
                return self.reply(200, XML_ERROR.format("InternalError").encode())
            with state.lock:
                pieces = state.uploads.pop(query["uploadId"][0])
                state.objects[key] = b"".join(pieces[n] for n in sorted(pieces))
                state.writer[key] = who
            return self.reply(200, b"<CompleteMultipartUploadResult/>")
        if "uploadId" in query and self.command == "DELETE":
            state.uploads.pop(query["uploadId"][0], None)
            return self.reply(204)
        if self.command == "PUT":
            if behaviour.reject_without_crc32 and "x-amz-checksum-crc32" not in {
                name.lower() for name in self.headers
            }:
                return self.error(400, "InvalidRequest")
            stored = (
                body[: len(body) // 2]
                if behaviour.truncate_matching and behaviour.truncate_matching in key
                else body
            )
            with state.lock:
                state.objects[key] = stored
                state.writer[key] = who
            if behaviour.ack_delay and "/ack/" in key:
                time.sleep(behaviour.ack_delay)
            return self.reply(200)
        if self.command == "DELETE":
            with state.lock:
                state.objects.pop(key, None)
                state.writer.pop(key, None)
            return self.reply(204)
        if key not in state.objects:
            status = behaviour.head_missing_status if self.command == "HEAD" else 404
            return self.error(status, "NoSuchKey")
        return self.reply(200, state.objects[key])

    do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = handle_any


class FakeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, state: FakeState) -> None:
        super().__init__(("127.0.0.1", 0), Handler)
        self.state = state

    def handle_error(self, request: object, client_address: object) -> None:
        return


class FakeTime:
    def __init__(self) -> None:
        self.now = 0.0
        self.lock = threading.Lock()

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        with self.lock:
            self.now += seconds
        time.sleep(0.01)


class StubNetwork(probe.Network):
    def __init__(self, addresses: list[str], reply: probe.Reply) -> None:
        self.addresses = addresses
        self.reply = reply

    def aaaa(self, host: str) -> list[str]:
        return list(self.addresses)

    def head_v6(self, host, address, path, headers, timeout):  # type: ignore[no-untyped-def]
        return self.reply


V6_OK = StubNetwork(["2001:db8::1"], probe.Reply(200))


class SilentAbandonWire(probe.Wire):
    def abandon(self, method, url, headers, payload):  # type: ignore[no-untyped-def]
        return None


class Fakes:
    """One fake server per location, started and stopped with the test."""

    def __init__(
        self, test: unittest.TestCase, nbg1: Behaviour, fsn1: Behaviour | None = None
    ) -> None:
        self.states = {
            "nbg1": FakeState(NBG1_BUCKET, nbg1),
            "fsn1": FakeState(
                FSN1_BUCKET, fsn1 if fsn1 is not None else dataclasses.replace(nbg1)
            ),
        }
        self.servers = {name: FakeServer(state) for name, state in self.states.items()}
        for server in self.servers.values():
            thread = threading.Thread(
                target=server.serve_forever, args=(0.01,), daemon=True
            )
            thread.start()
            test.addCleanup(self._stop, server)
        self.hosts = {"nbg1": NBG1_HOST, "fsn1": FSN1_HOST}
        self.time = FakeTime()

    @staticmethod
    def _stop(server: FakeServer) -> None:
        server.shutdown()
        server.server_close()

    def site(self, location: str) -> probe.Site:
        bucket = NBG1_BUCKET if location == "nbg1" else FSN1_BUCKET
        return probe.Site(
            location,
            self.hosts[location],
            bucket,
            probe.Credentials(OWNER_ID, OWNER_SECRET),
            probe.Credentials(FENCE_ID, FENCE_SECRET),
        )

    def wire(self, location: str, wire_class: type = probe.Wire) -> probe.Wire:
        port = self.servers[location].server_address[1]
        host = self.hosts[location]
        return wire_class(
            timeout=5.0,
            rewrite=lambda url: url.replace(
                f"https://{host}", f"http://127.0.0.1:{port}"
            ),
        )

    def context(
        self,
        location: str = "nbg1",
        network: probe.Network | None = None,
        wire_class: type = probe.Wire,
        dwell: float = 60.0,
        ack: float = 0.3,
    ) -> probe.Context:
        ctx = probe.build_context(
            self.site(location),
            self.wire(location, wire_class),
            network or V6_OK,
            "test0001",
            dwell,
            ack,
            self.time.clock,
            self.time.sleep,
        )
        ctx.abandon_window_seconds = 10.0
        return ctx


def fake_env() -> dict[str, str]:
    return {
        "T_ENDPOINT": NBG1_HOST,
        "T_LOCATION": "nbg1",
        "T_BUCKET": NBG1_BUCKET,
        "C_ENDPOINT": FSN1_HOST,
        "C_LOCATION": "fsn1",
        "C_BUCKET": FSN1_BUCKET,
        "O_ID": OWNER_ID,
        "O_SECRET": OWNER_SECRET,
        "F_ID": FENCE_ID,
        "F_SECRET": FENCE_SECRET,
    }


ARGV = [
    "--target-endpoint-env", "T_ENDPOINT",
    "--target-location-env", "T_LOCATION",
    "--target-bucket-env", "T_BUCKET",
    "--control-endpoint-env", "C_ENDPOINT",
    "--control-location-env", "C_LOCATION",
    "--control-bucket-env", "C_BUCKET",
    "--owner-key-id-env", "O_ID",
    "--owner-secret-env", "O_SECRET",
    "--fence-key-id-env", "F_ID",
    "--fence-secret-env", "F_SECRET",
    "--dwell-seconds", "60",
    "--ack-seconds", "0.3",
]  # fmt: skip


def run_main(
    test: unittest.TestCase, fakes: Fakes, env: dict[str, str] | None = None, argv=None
):  # type: ignore[no-untyped-def]
    out, err = io.StringIO(), io.StringIO()
    by_host = {fakes.hosts[loc]: loc for loc in fakes.hosts}
    code = probe.main(
        argv if argv is not None else ARGV,
        env if env is not None else fake_env(),
        out,
        err,
        lambda site: fakes.wire(by_host[site.endpoint]),
        V6_OK,
        fakes.time.clock,
        fakes.time.sleep,
    )
    return code, out.getvalue(), err.getvalue()


def verdict_of(lines: list[str], prefix: str) -> str:
    matching = [line for line in lines if line.startswith(prefix + " ")]
    test_line = matching[0]
    return test_line[len(prefix) + 1 :].split(":", 1)[0].split()[-1]


class HeadMissingTests(unittest.TestCase):
    def test_404_with_listbucket_passes(self) -> None:
        outcome = probe.probe_head_missing(Fakes(self, Behaviour()).context())
        self.assertEqual(outcome.verdict, probe.PASS)
        self.assertEqual(outcome.answer, "HEAD present=200; HEAD missing=404")

    def test_403_fails(self) -> None:
        outcome = probe.probe_head_missing(
            Fakes(self, Behaviour(head_missing_status=403)).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)

    def test_a_refused_control_write_is_inconclusive_not_a_pass(self) -> None:
        outcome = probe.probe_head_missing(
            Fakes(self, Behaviour(unknown_keys=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)
        self.assertIn("control write refused", outcome.reason)


class UploadTests(unittest.TestCase):
    def test_both_shapes_pass_without_crc32(self) -> None:
        fakes = Fakes(self, Behaviour())
        outcome = probe.probe_upload_no_crc32(fakes.context())
        self.assertEqual(outcome.verdict, probe.PASS, outcome.reason)

    def test_a_backend_that_demands_crc32_fails(self) -> None:
        outcome = probe.probe_upload_no_crc32(
            Fakes(self, Behaviour(reject_without_crc32=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)
        self.assertEqual(outcome.answer.split(";")[0], "PUT crc32=200")

    def test_multipart_refused_at_each_step_fails(self) -> None:
        for step in ("create", "part", "complete"):
            with self.subTest(step=step):
                outcome = probe.probe_upload_no_crc32(
                    Fakes(self, Behaviour(reject_multipart_at=step)).context()
                )
                self.assertEqual(outcome.verdict, probe.FAIL)
                self.assertIn(step, outcome.answer)

    def test_nothing_accepted_is_inconclusive(self) -> None:
        outcome = probe.probe_upload_no_crc32(
            Fakes(self, Behaviour(unknown_keys=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)


class AllowFenceTests(unittest.TestCase):
    def test_exact_fence_passes_and_names_only_the_fence_key(self) -> None:
        fakes = Fakes(self, Behaviour())
        ctx = fakes.context()
        seen: list[dict] = []
        original = fakes.states["nbg1"]
        outcome = probe.probe_allow_fence(ctx)
        self.assertEqual(outcome.verdict, probe.PASS, outcome.reason)
        self.assertIsNotNone(original.policy)
        statement = original.policy["Statement"]  # type: ignore[index]
        seen.extend(statement)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["Effect"], "Allow")
        self.assertEqual(
            seen[0]["Principal"],
            {"AWS": [f"arn:aws:iam:::user/p{FENCE_PROJECT}:{FENCE_ID}"]},
        )
        self.assertNotIn(OWNER_ID, json.dumps(original.policy))

    def test_policy_lag_is_waited_out(self) -> None:
        outcome = probe.probe_allow_fence(
            Fakes(self, Behaviour(policy_lag=3)).context()
        )
        self.assertEqual(outcome.verdict, probe.PASS, outcome.reason)

    def test_an_allow_that_never_admits_fails(self) -> None:
        outcome = probe.probe_allow_fence(
            Fakes(self, Behaviour(policy_ignored=True)).context(dwell=30)
        )
        self.assertEqual(outcome.verdict, probe.FAIL)

    def test_a_key_admitted_before_any_policy_is_inconclusive(self) -> None:
        outcome = probe.probe_allow_fence(
            Fakes(self, Behaviour(fence_leaks_without_policy=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)
        self.assertIn("admitted before any policy", outcome.reason)

    def test_a_leak_to_the_bucket_project_key_fails(self) -> None:
        outcome = probe.probe_allow_fence(
            Fakes(self, Behaviour(bucket_project_reads=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)
        self.assertIn("bucket-project key GET was admitted", outcome.reason)

    def test_an_unsigned_read_fails(self) -> None:
        outcome = probe.probe_allow_fence(
            Fakes(self, Behaviour(anonymous_reads=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)

    def test_the_policy_is_removed_and_the_bucket_is_empty_afterwards(self) -> None:
        fakes = Fakes(self, Behaviour())
        ctx = fakes.context()
        probe.probe_allow_fence(ctx)
        removed, left = probe.run_cleanup(ctx)
        self.assertEqual(left, [])
        self.assertGreater(removed, 0)
        self.assertIsNone(fakes.states["nbg1"].policy)
        self.assertEqual(fakes.states["nbg1"].objects, {})


class Ipv6Tests(unittest.TestCase):
    def verdict(
        self, network: probe.Network, behaviour: Behaviour | None = None
    ) -> probe.Outcome:
        return probe.probe_ipv6(
            Fakes(self, behaviour or Behaviour()).context(network=network)
        )

    def test_reached_over_ipv6_passes(self) -> None:
        self.assertEqual(self.verdict(V6_OK).verdict, probe.PASS)

    def test_no_aaaa_record_fails(self) -> None:
        self.assertEqual(
            self.verdict(StubNetwork([], probe.Reply(None))).verdict, probe.FAIL
        )

    def test_no_local_route_is_inconclusive(self) -> None:
        network = StubNetwork(["2001:db8::1"], probe.Reply(None, failure="no-route"))
        self.assertEqual(self.verdict(network).verdict, probe.INCONCLUSIVE)

    def test_a_timeout_is_inconclusive(self) -> None:
        network = StubNetwork(["2001:db8::1"], probe.Reply(None, failure="timeout"))
        self.assertEqual(self.verdict(network).verdict, probe.INCONCLUSIVE)

    def test_a_refusal_over_ipv6_fails(self) -> None:
        network = StubNetwork(["2001:db8::1"], probe.Reply(403, "AccessDenied"))
        self.assertEqual(self.verdict(network).verdict, probe.FAIL)

    def test_a_broken_control_is_inconclusive_even_if_ipv6_answers(self) -> None:
        outcome = self.verdict(V6_OK, Behaviour(unknown_keys=True))
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)

    def test_limit_counting_never_passes(self) -> None:
        outcome = probe.probe_limit_counting(Fakes(self, Behaviour()).context())
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)


class WriteAndAbandonTests(unittest.TestCase):
    def test_answered_writes_and_an_intact_abandoned_write_pass(self) -> None:
        outcome = probe.probe_write_and_abandon(Fakes(self, Behaviour()).context())
        self.assertEqual(outcome.verdict, probe.PASS, outcome.reason)

    def test_unanswered_writes_fail_and_report_the_commit(self) -> None:
        outcome = probe.probe_write_and_abandon(
            Fakes(self, Behaviour(ack_delay=1.5)).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)
        self.assertIn("committed", outcome.answer)

    def test_a_damaged_abandoned_object_fails(self) -> None:
        outcome = probe.probe_write_and_abandon(
            Fakes(self, Behaviour(truncate_matching="/dropped/")).context()
        )
        self.assertEqual(outcome.verdict, probe.FAIL)

    def test_an_abandoned_write_never_seen_is_inconclusive(self) -> None:
        outcome = probe.probe_write_and_abandon(
            Fakes(self, Behaviour()).context(wire_class=SilentAbandonWire)
        )
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)

    def test_refused_writes_are_inconclusive(self) -> None:
        outcome = probe.probe_write_and_abandon(
            Fakes(self, Behaviour(unknown_keys=True)).context()
        )
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)


class CompareTests(unittest.TestCase):
    def test_an_inconclusive_side_makes_the_pair_inconclusive(self) -> None:
        passing = probe.Outcome(probe.PASS, "ok", "a")
        for pair in (
            (passing, probe.inconclusive("x")),
            (probe.inconclusive("x"), passing),
        ):
            self.assertEqual(probe.compare("p", *pair).verdict, probe.INCONCLUSIVE)

    def test_the_same_reason_at_both_is_named(self) -> None:
        comparison = probe.compare(
            "p", probe.inconclusive("key refused"), probe.inconclusive("key refused")
        )
        self.assertIn("same reason at both", comparison.reason)

    def test_identical_answers_do_not_tell_the_locations_apart(self) -> None:
        same = probe.Outcome(probe.PASS, "ok", "HEAD missing=404")
        comparison = probe.compare("p", same, same)
        self.assertEqual(comparison.verdict, probe.INCONCLUSIVE)
        self.assertIn("did not tell them apart", comparison.reason)

    def test_different_answers_give_the_targets_verdict(self) -> None:
        good = probe.Outcome(probe.PASS, "ok", "404")
        bad = probe.Outcome(probe.FAIL, "no", "403")
        self.assertEqual(probe.compare("p", good, bad).verdict, probe.PASS)
        self.assertEqual(probe.compare("p", bad, good).verdict, probe.FAIL)


class EndToEndTests(unittest.TestCase):
    def test_a_fake_that_differs_per_location_is_told_apart(self) -> None:
        fakes = Fakes(self, Behaviour(), Behaviour(head_missing_status=403))
        code, out, err = run_main(self, fakes)
        lines = out.splitlines()
        self.assertEqual(code, 0, err)
        self.assertEqual(verdict_of(lines, "nbg1 head-missing"), probe.PASS)
        self.assertEqual(verdict_of(lines, "fsn1 head-missing"), probe.FAIL)
        self.assertEqual(verdict_of(lines, "compare head-missing"), probe.PASS)

    def test_a_fake_that_answers_identically_is_inconclusive_in_the_comparison(
        self,
    ) -> None:
        fakes = Fakes(self, Behaviour())
        code, out, err = run_main(self, fakes)
        lines = out.splitlines()
        self.assertEqual(code, 0, err)
        self.assertEqual(verdict_of(lines, "nbg1 head-missing"), probe.PASS)
        for name in probe.PROBE_NAMES:
            with self.subTest(probe=name):
                self.assertEqual(
                    verdict_of(lines, f"compare {name}"), probe.INCONCLUSIVE
                )

    def test_every_probe_prints_one_line_per_location_and_one_comparison(self) -> None:
        _, out, _ = run_main(self, Fakes(self, Behaviour()))
        lines = out.splitlines()
        for name in probe.PROBE_NAMES:
            for prefix in ("nbg1", "fsn1", "compare"):
                self.assertEqual(
                    len([ln for ln in lines if ln.startswith(f"{prefix} {name} ")]), 1
                )
        self.assertEqual(len([ln for ln in lines if ln.startswith("cleanup ")]), 2)

    def test_the_run_leaves_nothing_in_either_bucket(self) -> None:
        fakes = Fakes(self, Behaviour())
        run_main(self, fakes)
        for state in fakes.states.values():
            self.assertEqual(state.objects, {})
            self.assertIsNone(state.policy)

    def test_no_value_reaches_the_output_or_the_wire(self) -> None:
        fakes = Fakes(self, Behaviour())
        _, out, err = run_main(self, fakes)
        secrets_ = [
            OWNER_SECRET,
            FENCE_SECRET,
            OWNER_ID,
            FENCE_ID,
            NBG1_BUCKET,
            FSN1_BUCKET,
            NBG1_HOST,
            FSN1_HOST,
        ]
        for value in secrets_:
            self.assertNotIn(value, out)
            self.assertNotIn(value, err)
        for state in fakes.states.values():
            for blob in state.seen_bytes:
                self.assertNotIn(OWNER_SECRET.encode(), blob)
                self.assertNotIn(FENCE_SECRET.encode(), blob)


class HygieneTests(unittest.TestCase):
    def test_a_raising_probe_is_redacted(self) -> None:
        redact = probe.Redactor([OWNER_SECRET, NBG1_BUCKET])

        def boom(ctx: object) -> probe.Outcome:
            raise RuntimeError(f"failed with {OWNER_SECRET} in {NBG1_BUCKET}")

        outcome = probe.run_probe(mock.Mock(), boom, redact)
        self.assertEqual(outcome.verdict, probe.INCONCLUSIVE)
        self.assertNotIn(OWNER_SECRET, outcome.reason)
        self.assertNotIn(NBG1_BUCKET, outcome.reason)

    def test_the_credential_objects_do_not_print_their_values(self) -> None:
        text = repr(probe.Credentials(OWNER_ID, OWNER_SECRET)) + repr(
            Fakes(self, Behaviour()).site("nbg1")
        )
        for value in (OWNER_ID, OWNER_SECRET, FENCE_SECRET, NBG1_BUCKET, NBG1_HOST):
            self.assertNotIn(value, text)

    def refused(self, env: dict[str, str], argv=None) -> str:  # type: ignore[no-untyped-def]
        fakes = Fakes(self, Behaviour())
        code, out, err = run_main(self, fakes, env, argv)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        return err

    def test_an_unset_variable_is_refused_without_naming_its_value(self) -> None:
        env = fake_env()
        del env["O_SECRET"]
        err = self.refused(env)
        self.assertIn("--owner-secret-env", err)

    def test_an_argument_that_is_a_value_not_a_name_is_refused_and_not_echoed(
        self,
    ) -> None:
        argv = [FENCE_SECRET if a == "F_SECRET" else a for a in ARGV]
        err = self.refused(fake_env(), argv)
        self.assertNotIn(FENCE_SECRET, err)

    def test_the_same_endpoint_for_both_locations_is_refused(self) -> None:
        env = fake_env()
        env["C_ENDPOINT"] = NBG1_HOST
        self.assertIn("same endpoint", self.refused(env))

    def test_the_same_key_for_both_roles_is_refused(self) -> None:
        env = fake_env()
        env["F_ID"] = OWNER_ID
        self.assertIn("same key", self.refused(env))

    def test_a_plain_http_endpoint_is_refused(self) -> None:
        env = fake_env()
        env["T_ENDPOINT"] = "http://" + NBG1_HOST
        err = self.refused(env)
        self.assertNotIn(NBG1_HOST, err)

    def test_the_policy_builder_refuses_a_parser_rejected_action(self) -> None:
        with (
            mock.patch.object(
                probe, "FENCE_ACTIONS", ("s3:GetEncryptionConfiguration",)
            ),
            self.assertRaises(probe._policy.PolicyInputError),
        ):
            probe.fence_policy(
                "probe-bucket", "arn:aws:iam:::user/p1:AAAAAAAAAAAAAAAAAAAA"
            )

    def test_crc32_header_is_the_standard_value(self) -> None:
        headers = probe.crc32_headers(b"123456789")
        self.assertEqual(headers["x-amz-checksum-crc32"], "y/Q5Jg==")

    def test_output_goes_through_one_line_per_result(self) -> None:
        outcome = probe.Outcome(probe.PASS, "two\nlines", "a")
        lines = probe.render(
            "nbg1", "fsn1",
            {n: outcome for n in probe.PROBE_NAMES}, {n: outcome for n in probe.PROBE_NAMES},
            {"nbg1": (1, []), "fsn1": (1, [])}, "r",
        )  # fmt: skip
        self.assertTrue(all("\n" not in line for line in lines))


class RealNetworkTests(unittest.TestCase):
    def test_an_ipv6_connection_that_cannot_be_made_reports_no_status(self) -> None:
        reply = probe.Network().head_v6("localhost", "::1", "/", {}, 1.0)
        self.assertIsNone(reply.status)
        self.assertIn(reply.failure, ("unreachable", "no-route", "timeout"))

    def test_an_unresolvable_name_has_no_ipv6_address(self) -> None:
        self.assertEqual(probe.Network().aaaa("nothing.invalid"), [])


class ShebangTests(unittest.TestCase):
    def test_the_program_is_isolated_mode(self) -> None:
        first = (_HERE / "probe-gateway-storage.py").read_text().splitlines()[0]
        self.assertEqual(first, "#!/usr/bin/python3 -I")


if __name__ == "__main__":
    unittest.main()
