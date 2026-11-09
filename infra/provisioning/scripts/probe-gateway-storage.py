#!/usr/bin/python3 -I
"""Live probes of how the object storage backend treats the storage gateway's requests.

Run by hand against a throwaway bucket in each of two locations (the one under
test and a control). Every value comes from an environment variable whose NAME
is passed as an argument; no value is ever printed, logged or written.
See probe-gateway-storage.md.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import dataclasses
import datetime
import errno
import hashlib
import http.client
import importlib.util
import json
import os
import pathlib
import re
import secrets
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections.abc import Callable, Mapping, Sequence
from typing import TextIO

_HERE = pathlib.Path(__file__).resolve().parent


def _load(name: str, filename: str):  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    if spec is None or spec.loader is None:
        raise ImportError(f"{filename} could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_shared = _load("gateway_probe_shared_objectstorage", "shared_objectstorage.py")
_policy = _load("gateway_probe_bucketpolicy", "bucketpolicy.py")

PASS = "PASS"
FAIL = "FAIL"
INCONCLUSIVE = "INCONCLUSIVE"

PROBE_NAMES = (
    "head-missing",
    "upload-no-crc32",
    "allow-fence",
    "ipv6",
    "limit-counting",
    "write-and-abandon",
)

REDACTED = "[redacted]"
BUCKET_MARKER = "branchleft-gw-probe-"
EXIT_CONFIG = 2
EXIT_NOT_THROWAWAY = 3
PREFLIGHT_PAGE_KEYS = 100
FENCE_ACTIONS = ("s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket")
DEFAULT_DWELL_SECONDS = 300.0
POLL_SECONDS = 15.0
DEFAULT_ACK_SECONDS = 15.0
ABANDON_WINDOW_SECONDS = 30.0
ABANDON_POLL_SECONDS = 2.0
ACK_ATTEMPTS = 8
PART_BYTES = 5 * 1024 * 1024
MAX_BODY_BYTES = 32 * 1024 * 1024

_NAME = re.compile(r"\A[A-Z][A-Z0-9_]{0,63}\Z")
_LOCATION = re.compile(r"\A[a-z][a-z0-9-]{1,15}\Z")
_SECRET_KEY = re.compile(r"\A[A-Za-z0-9/+=]{16,128}\Z")
_CODE = re.compile(r"<Code>([A-Za-z0-9]{1,64})</Code>")
_KEY = re.compile(r"<Key>([^<]*)</Key>")
_TRUNCATED = re.compile(r"<IsTruncated>\s*true\s*</IsTruncated>", re.IGNORECASE)
_UPLOAD_ID = re.compile(r"<UploadId>([^<]{1,1024})</UploadId>")
_LOCAL_NETWORK_ERRNO = frozenset(
    code
    for code in (
        getattr(errno, "ENETUNREACH", None),
        getattr(errno, "EHOSTUNREACH", None),
        getattr(errno, "EADDRNOTAVAIL", None),
        getattr(errno, "EAFNOSUPPORT", None),
        getattr(errno, "ENETDOWN", None),
    )
    if code is not None
)


class ConfigError(Exception):
    """The run cannot start. The message names options and variables, never values."""


@dataclasses.dataclass(frozen=True)
class Credentials:
    key_id: str = dataclasses.field(repr=False)
    secret: str = dataclasses.field(repr=False)


@dataclasses.dataclass(frozen=True)
class Site:
    location: str
    endpoint: str = dataclasses.field(repr=False)
    bucket: str = dataclasses.field(repr=False)
    owner: Credentials
    fence: Credentials

    def sensitive(self) -> list[str]:
        return [
            self.endpoint,
            self.bucket,
            self.owner.key_id,
            self.owner.secret,
            self.fence.key_id,
            self.fence.secret,
        ]


@dataclasses.dataclass(frozen=True)
class Outcome:
    verdict: str
    reason: str
    answer: str = ""


@dataclasses.dataclass(frozen=True)
class Comparison:
    probe: str
    verdict: str
    reason: str


@dataclasses.dataclass(frozen=True)
class Reply:
    status: int | None
    code: str = ""
    body: bytes = dataclasses.field(default=b"", repr=False)
    failure: str = ""

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    def describe(self) -> str:
        if self.status is None:
            return f"no response ({self.failure or 'unknown'})"
        return f"{self.status} {self.code}".strip()

    def short(self) -> str:
        return str(self.status) if self.status is not None else self.failure or "none"


def inconclusive(reason: str, answer: str = "") -> Outcome:
    return Outcome(INCONCLUSIVE, reason, answer)


class Redactor:
    """Replaces every sensitive value in text that is about to be shown."""

    def __init__(self, values: Sequence[str]) -> None:
        self._values = sorted({v for v in values if v}, key=len, reverse=True)

    def __call__(self, text: str) -> str:
        for value in self._values:
            text = text.replace(value, REDACTED)
        return text


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


class Wire:
    """Sends requests; the one place that touches the network (tests replace `rewrite`)."""

    def __init__(
        self,
        timeout: float = 60.0,
        rewrite: Callable[[str], str] | None = None,
    ) -> None:
        self.timeout = timeout
        self._rewrite = rewrite

    def target(self, url: str) -> str:
        return self._rewrite(url) if self._rewrite is not None else url

    def send(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        payload: bytes,
        timeout: float | None = None,
    ) -> Reply:
        data = payload if payload or method in ("PUT", "POST") else None
        request = urllib.request.Request(self.target(url), data=data, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        limit = self.timeout if timeout is None else timeout
        try:
            with _OPENER.open(request, timeout=limit) as response:
                return _reply(response.status, response.read(MAX_BODY_BYTES))
        except urllib.error.HTTPError as exc:
            return _reply(exc.code, exc.read(MAX_BODY_BYTES))
        except TimeoutError:
            return Reply(None, failure="timeout")
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                return Reply(None, failure="timeout")
            return Reply(None, failure="unreachable")
        except (OSError, http.client.HTTPException):
            return Reply(None, failure="unreachable")

    def abandon(
        self, method: str, url: str, headers: Mapping[str, str], payload: bytes
    ) -> str | None:
        """Sends a whole request and closes the connection without reading the answer.

        Returns None when the request was sent, otherwise a short failure word."""
        parts = urllib.parse.urlsplit(self.target(url))
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        lines = [f"{method} {path} HTTP/1.1"]
        sent = {name.lower(): value for name, value in headers.items()}
        sent["content-length"] = str(len(payload))
        sent["connection"] = "close"
        sent.setdefault("host", host)
        lines.extend(f"{name}: {value}" for name, value in sent.items())
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + payload
        try:
            sock = socket.create_connection((host, port), timeout=self.timeout)
            try:
                if parts.scheme == "https":
                    sock = ssl.create_default_context().wrap_socket(
                        sock, server_hostname=host
                    )
                sock.sendall(raw)
            finally:
                sock.close()
        except (OSError, ssl.SSLError):
            return "unreachable"
        return None


def _reply(status: int, body: bytes) -> Reply:
    match = _CODE.search(body.decode("utf-8", errors="replace"))
    return Reply(status, match.group(1) if match else "", body)


class Network:
    """Name lookups and IPv6 connections; replaced wholesale in tests."""

    def aaaa(self, host: str) -> list[str]:
        try:
            found = socket.getaddrinfo(host, 443, socket.AF_INET6, socket.SOCK_STREAM)
        except socket.gaierror:
            return []
        return sorted({str(item[4][0]) for item in found})

    def head_v6(
        self,
        host: str,
        address: str,
        path: str,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Reply:
        try:
            raw = socket.create_connection((address, 443), timeout=timeout)
        except OSError as exc:
            if exc.errno in _LOCAL_NETWORK_ERRNO:
                return Reply(None, failure="no-route")
            if isinstance(exc, (socket.timeout, TimeoutError)):
                return Reply(None, failure="timeout")
            return Reply(None, failure="unreachable")
        try:
            wrapped = ssl.create_default_context().wrap_socket(
                raw, server_hostname=host
            )
            connection = http.client.HTTPSConnection(host, timeout=timeout)
            connection.sock = wrapped
            connection.request("HEAD", path, headers=dict(headers))
            response = connection.getresponse()
            response.read()
            status = response.status
            connection.close()
        except (OSError, ssl.SSLError, http.client.HTTPException):
            return Reply(None, failure="unreachable")
        return Reply(status)


class S3Client:
    """One identity (or none) talking to one location's bucket through the shared signer."""

    def __init__(
        self,
        site: Site,
        wire: Wire,
        credentials: Credentials | None,
        now: Callable[[], datetime.datetime],
    ) -> None:
        self.site = site
        self.wire = wire
        self.credentials = credentials
        self.now = now

    def prepare(
        self,
        method: str,
        key: str | None,
        query: dict[str, str] | None,
        payload: bytes,
        extra: dict[str, str] | None,
    ) -> tuple[str, dict[str, str]]:
        url = _shared.request_url(
            endpoint=self.site.endpoint, bucket=self.site.bucket, key=key, query=query
        )
        if self.credentials is None:
            return url, dict(extra or {})
        headers = _shared.build_headers(
            bucket=self.site.bucket,
            key=key,
            payload=payload,
            host=self.site.endpoint,
            region=self.site.location,
            access_key=self.credentials.key_id,
            secret_key=self.credentials.secret,
            now=self.now(),
            query=query,
            content_type="application/octet-stream" if payload else None,
            extra_headers=extra,
            method=method,
        )
        return url, headers

    def service_request(self) -> Reply:
        """GET on the service root (the bucket listing), which names the caller's project."""
        if self.credentials is None:
            raise ValueError("the service listing needs a key")
        host = self.site.endpoint
        headers = _shared.build_headers(
            bucket="",
            key=None,
            payload=b"",
            host=host,
            region=self.site.location,
            access_key=self.credentials.key_id,
            secret_key=self.credentials.secret,
            now=self.now(),
            method="GET",
        )
        return self.wire.send("GET", f"https://{host}/", headers, b"")

    def request(
        self,
        method: str,
        key: str | None = None,
        query: dict[str, str] | None = None,
        payload: bytes = b"",
        extra: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Reply:
        url, headers = self.prepare(method, key, query, payload, extra)
        return self.wire.send(method, url, headers, payload, timeout)


@dataclasses.dataclass
class Context:
    site: Site
    wire: Wire
    network: Network
    owner: S3Client
    fence: S3Client
    anonymous: S3Client
    prefix: str
    clock: Callable[[], float]
    sleep: Callable[[float], None]
    dwell_seconds: float = DEFAULT_DWELL_SECONDS
    ack_seconds: float = DEFAULT_ACK_SECONDS
    abandon_window_seconds: float = ABANDON_WINDOW_SECONDS
    cleanup: list[tuple[str, Callable[[], bool]]] = dataclasses.field(
        default_factory=list
    )

    def key(self, *parts: str) -> str:
        return "/".join((self.prefix,) + parts)

    def forget_later(self, label: str, action: Callable[[], bool]) -> None:
        self.cleanup.append((label, action))

    def remove_later(self, client: S3Client, key: str) -> None:
        def action() -> bool:
            reply = client.request("DELETE", key)
            return reply.ok or reply.status == 404

        self.forget_later(key, action)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _blob(label: str, size: int) -> bytes:
    seed = hashlib.sha256(label.encode()).digest()
    return (seed * (size // len(seed) + 1))[:size]


def crc32_headers(data: bytes) -> dict[str, str]:
    digest = base64.b64encode(struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)).decode()
    return {"x-amz-checksum-crc32": digest, "x-amz-sdk-checksum-algorithm": "CRC32"}


def probe_head_missing(ctx: Context) -> Outcome:
    present, missing = (
        ctx.key("head", "present"),
        ctx.key("head", "missing", "never-written"),
    )
    written = ctx.owner.request("PUT", present, payload=_blob("head", 512))
    if not written.ok:
        return inconclusive(f"control write refused: {written.describe()}")
    ctx.remove_later(ctx.owner, present)
    listing = ctx.owner.request("GET", query={"list-type": "2", "prefix": ctx.prefix})
    if not listing.ok or present.encode() not in listing.body:
        return inconclusive(f"the key cannot list the bucket: {listing.describe()}")
    found = ctx.owner.request("HEAD", present)
    if found.status != 200:
        return inconclusive(f"control HEAD of a present object: {found.describe()}")
    absent = ctx.owner.request("HEAD", missing)
    answer = f"HEAD present=200; HEAD missing={absent.short()}"
    if absent.status == 404:
        return Outcome(
            PASS, "HEAD on a missing object is 404 with ListBucket held", answer
        )
    if absent.status == 403:
        return Outcome(
            FAIL, "HEAD on a missing object is 403 although ListBucket is held", answer
        )
    return inconclusive(f"HEAD on a missing object: {absent.describe()}", answer)


def _multipart(ctx: Context, key: str) -> tuple[str | None, str]:
    """Returns (failed step description or None, the step reached)."""
    created = ctx.owner.request("POST", key, query={"uploads": ""})
    upload = _UPLOAD_ID.search(created.body.decode("utf-8", errors="replace"))
    if not created.ok or upload is None:
        return f"create refused: {created.describe()}", "create"
    upload_id = upload.group(1)
    state = {"open": True}

    def abort() -> bool:
        if not state["open"]:
            return True
        reply = ctx.owner.request("DELETE", key, query={"uploadId": upload_id})
        return reply.ok or reply.status == 404

    ctx.forget_later(f"{key} (multipart)", abort)
    parts = [_blob("part-1", PART_BYTES), _blob("part-2", 1024)]
    etags: list[str] = []
    for number, data in enumerate(parts, start=1):
        sent = ctx.owner.request(
            "PUT",
            key,
            query={"partNumber": str(number), "uploadId": upload_id},
            payload=data,
        )
        if not sent.ok:
            return f"part {number} refused: {sent.describe()}", f"part {number}"
        etags.append(hashlib.md5(data).hexdigest())
    document = (
        "<CompleteMultipartUpload>"
        + "".join(
            f'<Part><PartNumber>{i}</PartNumber><ETag>"{tag}"</ETag></Part>'
            for i, tag in enumerate(etags, start=1)
        )
        + "</CompleteMultipartUpload>"
    ).encode()
    done = ctx.owner.request(
        "POST", key, query={"uploadId": upload_id}, payload=document
    )
    if not done.ok or b"<Error" in done.body:
        return f"complete refused: {done.describe()}", "complete"
    state["open"] = False
    ctx.remove_later(ctx.owner, key)
    back = ctx.owner.request("GET", key)
    if not back.ok or _sha(back.body) != _sha(parts[0] + parts[1]):
        return f"object read back differs: {back.describe()}", "read back"
    return None, "complete"


def probe_upload_no_crc32(ctx: Context) -> Outcome:
    data = _blob("single", 4096)
    with_header = ctx.key("upload", "with-crc32")
    without = ctx.key("upload", "without-crc32")
    control = ctx.owner.request(
        "PUT", with_header, payload=data, extra=crc32_headers(data)
    )
    if control.ok:
        ctx.remove_later(ctx.owner, with_header)
    plain = ctx.owner.request("PUT", without, payload=data)
    if plain.ok:
        ctx.remove_later(ctx.owner, without)
    if not control.ok and not plain.ok:
        return inconclusive(
            f"no PUT was accepted either way: {control.describe()}, {plain.describe()}"
        )
    answer = f"PUT crc32={control.short()}; PUT plain={plain.short()}"
    if not plain.ok:
        return Outcome(
            FAIL,
            f"a PUT without the CRC32 header was refused: {plain.describe()}",
            answer,
        )
    back = ctx.owner.request("GET", without)
    if not back.ok or _sha(back.body) != _sha(data):
        return inconclusive(
            f"the plain PUT could not be read back intact: {back.describe()}", answer
        )
    problem, reached = _multipart(ctx, ctx.key("upload", "multipart"))
    answer += f"; multipart reached={reached}"
    if problem is not None:
        return Outcome(FAIL, f"multipart without the CRC32 header: {problem}", answer)
    return Outcome(
        PASS, "a single PUT and a multipart upload both succeed without CRC32", answer
    )


def fence_policy(bucket: str, principal: str) -> str:
    document = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AdmitTheFenceKey",
                "Effect": "Allow",
                "Principal": {"AWS": [principal]},
                "Action": list(FENCE_ACTIONS),
                "Resource": [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"],
            }
        ],
    }
    _policy.assert_enforceable(document)
    return json.dumps(document, separators=(",", ":"), sort_keys=True)


def fence_project_id(ctx: Context) -> str | None:
    answer = ctx.fence.service_request()
    if not answer.ok:
        return None
    owner = _shared.parse_owner_id(answer.body)
    if owner is None:
        return None
    digits = owner[1:] if owner[:1] in ("p", "P") else owner
    return digits if digits.isdigit() else None


def read_policy(ctx: Context) -> Reply:
    """GET of the bucket policy by the bucket's own key: 404 means there is none."""
    return ctx.owner.request("GET", None, query={"policy": ""})


def _canonical(value: object) -> object:
    """A policy in a form that ignores key order and one-versus-many wording."""
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()}
    items = value if isinstance(value, list) else [value]
    return sorted(
        (_canonical(item) if isinstance(item, dict) else item for item in items),
        key=lambda item: json.dumps(item, sort_keys=True),
    )


def remove_own_policy(ctx: Context, written: str) -> bool:
    """Deletes the bucket policy only if it is still the one this run wrote."""
    current = read_policy(ctx)
    if current.status == 404:
        return True
    if not current.ok:
        return False
    try:
        same = _canonical(json.loads(current.body)) == _canonical(json.loads(written))
    except ValueError:
        return False
    if not same:
        return False
    reply = ctx.owner.request("DELETE", None, query={"policy": ""})
    return reply.ok or reply.status == 404


def probe_allow_fence(ctx: Context) -> Outcome:
    control = ctx.key("fence", "control")
    seeded = ctx.owner.request("PUT", control, payload=_blob("fence", 256))
    if not seeded.ok:
        return inconclusive(
            f"control write by the bucket's own key refused: {seeded.describe()}"
        )
    ctx.remove_later(ctx.owner, control)
    baseline_key = ctx.key("fence", "baseline")
    before = ctx.fence.request("PUT", baseline_key, payload=_blob("baseline", 64))
    if before.ok:
        ctx.remove_later(ctx.owner, baseline_key)
        return inconclusive(
            "the fence key was admitted before any policy existed, so an Allow cannot be shown "
            "to be what admits it",
            "fence key admitted without a policy",
        )
    if before.status != 403:
        return inconclusive(f"fence key before any policy: {before.describe()}")
    project = fence_project_id(ctx)
    if project is None:
        return inconclusive(
            "the fence key's project could not be read from the service listing"
        )
    try:
        principal = _policy.key_principal(project, ctx.site.fence.key_id)
        document = fence_policy(ctx.site.bucket, principal)
    except _policy.PolicyInputError as exc:
        return inconclusive(f"the policy could not be built: {exc}")
    existing = read_policy(ctx)
    if existing.status != 404:
        return inconclusive(
            "a bucket policy is present or unreadable just before the write, so none was "
            f"written: {existing.describe()}"
        )
    applied = ctx.owner.request(
        "PUT", None, query={"policy": ""}, payload=document.encode(), extra=None
    )
    if not applied.ok:
        return inconclusive(f"the policy was not accepted: {applied.describe()}")
    ctx.forget_later("bucket policy", lambda: remove_own_policy(ctx, document))
    admitted_key = ctx.key("fence", "by-fence-key")
    payload = _blob("fence-key", 128)
    started = ctx.clock()
    attempt = ctx.fence.request("PUT", admitted_key, payload=payload)
    while not attempt.ok and ctx.clock() - started < ctx.dwell_seconds:
        ctx.sleep(POLL_SECONDS)
        attempt = ctx.fence.request("PUT", admitted_key, payload=payload)
    waited = int(ctx.clock() - started)
    if not attempt.ok:
        answer = f"fence key PUT after {ctx.dwell_seconds:.0f}s: {attempt.short()}"
        if attempt.status == 403:
            return Outcome(
                FAIL, f"the Allow never admitted the named key ({waited}s)", answer
            )
        return inconclusive(f"the named key's PUT: {attempt.describe()}", answer)
    ctx.remove_later(ctx.fence, admitted_key)
    violations: list[str] = []
    unknown: list[str] = []
    got = ctx.fence.request("GET", admitted_key)
    if not got.ok or _sha(got.body) != _sha(payload):
        violations.append(f"named key GET {got.describe()}")
    listed = ctx.fence.request("GET", query={"list-type": "2", "prefix": ctx.prefix})
    if not listed.ok:
        violations.append(f"named key LIST {listed.describe()}")
    checks = (
        ("unsigned GET", ctx.anonymous.request("GET", admitted_key)),
        ("unsigned LIST", ctx.anonymous.request("GET", query={"list-type": "2"})),
        ("bucket-project key GET", ctx.owner.request("GET", admitted_key)),
    )
    seen = [
        f"fence PUT={attempt.short()}",
        f"GET={got.short()}",
        f"LIST={listed.short()}",
    ]
    for label, reply in checks:
        seen.append(f"{label}={reply.short()}")
        if reply.ok:
            violations.append(f"{label} was admitted")
        elif reply.status != 403:
            unknown.append(f"{label} {reply.describe()}")
    answer = "; ".join(seen)
    if violations:
        return Outcome(
            FAIL, "the Allow fence is not exact: " + "; ".join(violations), answer
        )
    if unknown:
        return inconclusive("; ".join(unknown), answer)
    return Outcome(
        PASS,
        f"the Allow admits the named key and refuses the rest tried (policy took ~{waited}s)",
        answer,
    )


def probe_ipv6(ctx: Context) -> Outcome:
    base = ctx.owner.request("HEAD", None)
    if base.status != 200:
        return inconclusive(
            f"control HEAD of the bucket over the normal path: {base.describe()}"
        )
    addresses = ctx.network.aaaa(ctx.site.endpoint)
    if not addresses:
        return Outcome(FAIL, "the endpoint publishes no IPv6 address", "no AAAA record")
    url, headers = ctx.owner.prepare("HEAD", None, None, b"", None)
    parts = urllib.parse.urlsplit(url)
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    last = Reply(None, failure="unreachable")
    for address in addresses:
        last = ctx.network.head_v6(
            ctx.site.endpoint, address, path, headers, ctx.ack_seconds
        )
        if last.status is not None:
            break
    if last.status is not None and 200 <= last.status < 300:
        return Outcome(
            PASS, "a signed request reached the bucket over IPv6", "IPv6 HEAD 200"
        )
    if last.status is not None:
        return Outcome(
            FAIL,
            f"over IPv6 the bucket answered {last.describe()}",
            f"IPv6 HEAD {last.status}",
        )
    if last.failure == "no-route":
        return inconclusive("this host has no IPv6 route, so the backend was not asked")
    return inconclusive(
        f"IPv6 connection failed ({last.failure}); host and backend not told apart"
    )


def probe_limit_counting(ctx: Context) -> Outcome:
    del ctx
    return inconclusive(
        "not measured: telling a per-address limit from a per-/64 limit needs more than the "
        "limit's request rate from two source addresses in one /64 against two buckets"
    )


def _write_and_abandon_acks(ctx: Context) -> tuple[Outcome | None, str]:
    key = ctx.key("abandon", "ack", "object")
    ctx.remove_later(ctx.owner, key)
    stamps: list[str] = []
    payloads = [_blob(f"ack-{i}", 2048) for i in range(ACK_ATTEMPTS)]
    for data in payloads:
        reply = ctx.owner.request("PUT", key, payload=data, timeout=ctx.ack_seconds)
        stamps.append(reply.short())
    silent = [s for s in stamps if s in ("timeout", "unreachable")]
    refused = [
        s
        for s in stamps
        if s not in ("timeout", "unreachable") and not s.startswith("2")
    ]
    answer = f"acknowledged {ACK_ATTEMPTS - len(silent) - len(refused)}/{ACK_ATTEMPTS}"
    if refused:
        return inconclusive(
            f"writes were refused ({','.join(sorted(set(refused)))})", answer
        ), answer
    if silent:
        back = ctx.owner.request("GET", key)
        committed = "committed" if back.ok and back.body in payloads else "not seen"
        answer += f"; unanswered={len(silent)}; read back: {committed}"
        return (
            Outcome(
                FAIL,
                f"{len(silent)} of {ACK_ATTEMPTS} writes got no answer in {ctx.ack_seconds:.0f}s; "
                f"read back shows the write {committed}",
                answer,
            ),
            answer,
        )
    return None, answer


def probe_write_and_abandon(ctx: Context) -> Outcome:
    early, answer = _write_and_abandon_acks(ctx)
    if early is not None:
        return early
    key = ctx.key("abandon", "dropped", "object")
    data = _blob("abandoned", 1024 * 1024)
    ctx.remove_later(ctx.owner, key)
    url, headers = ctx.owner.prepare("PUT", key, None, data, None)
    failure = ctx.wire.abandon("PUT", url, headers, data)
    if failure is not None:
        return inconclusive(f"the write could not be sent ({failure})", answer)
    started = ctx.clock()
    back = ctx.owner.request("GET", key)
    while back.status == 404 and ctx.clock() - started < ctx.abandon_window_seconds:
        ctx.sleep(ABANDON_POLL_SECONDS)
        back = ctx.owner.request("GET", key)
    if back.ok and _sha(back.body) == _sha(data):
        answer += "; abandoned write committed intact"
        return Outcome(
            PASS,
            "every write was answered and an abandoned write committed intact",
            answer,
        )
    if back.ok:
        answer += "; abandoned write committed damaged"
        return Outcome(
            FAIL, "an abandoned write left a partial or damaged object", answer
        )
    answer += f"; abandoned write not seen ({back.short()})"
    return inconclusive(
        f"the abandoned write was not visible within {ctx.abandon_window_seconds:.0f}s; "
        "a later commit cannot be ruled out",
        answer,
    )


PROBES: tuple[tuple[str, Callable[[Context], Outcome]], ...] = (
    ("head-missing", probe_head_missing),
    ("upload-no-crc32", probe_upload_no_crc32),
    ("allow-fence", probe_allow_fence),
    ("ipv6", probe_ipv6),
    ("limit-counting", probe_limit_counting),
    ("write-and-abandon", probe_write_and_abandon),
)


def run_probe(
    ctx: Context, fn: Callable[[Context], Outcome], redact: Redactor
) -> Outcome:
    try:
        return fn(ctx)
    except Exception as exc:  # noqa: BLE001 - a probe that raised has no verdict
        text = redact(f"{type(exc).__name__}: {exc}")[:160]
        return inconclusive(f"the probe stopped: {text}")


def run_cleanup(ctx: Context) -> tuple[int, list[str]]:
    removed, left = 0, []
    for label, action in reversed(ctx.cleanup):
        try:
            done = action()
        except Exception:  # noqa: BLE001 - a failed removal is reported, not raised
            done = False
        if done:
            removed += 1
        else:
            left.append(label)
    return removed, left


def preflight(ctx: Context) -> str | None:
    """Reads only. Returns why the bucket is not a clean throwaway, or None when it is."""
    policy = read_policy(ctx)
    if policy.ok:
        return "the bucket already has a bucket policy"
    if policy.status != 404:
        return f"the bucket policy could not be read ({policy.describe()})"
    listing = ctx.owner.request(
        "GET", query={"list-type": "2", "max-keys": str(PREFLIGHT_PAGE_KEYS)}
    )
    if not listing.ok:
        return f"the bucket could not be listed ({listing.describe()})"
    text = listing.body.decode("utf-8", errors="replace")
    inside = ctx.prefix + "/"
    foreign = [key for key in _KEY.findall(text) if not key.startswith(inside)]
    if foreign:
        return f"the bucket holds {len(foreign)} key(s) outside the probe prefix"
    if _TRUNCATED.search(text):
        return "the bucket holds more keys than one bounded page shows"
    return None


def run_site(
    ctx: Context, redact: Redactor
) -> tuple[dict[str, Outcome], tuple[int, list[str]]]:
    results = {name: run_probe(ctx, fn, redact) for name, fn in PROBES}
    return results, run_cleanup(ctx)


def compare(probe: str, target: Outcome, control: Outcome) -> Comparison:
    if target.verdict == INCONCLUSIVE or control.verdict == INCONCLUSIVE:
        if target.verdict == control.verdict and target.reason == control.reason:
            return Comparison(
                probe, INCONCLUSIVE, f"same reason at both locations: {target.reason}"
            )
        return Comparison(
            probe,
            INCONCLUSIVE,
            f"target {target.verdict} ({target.reason}); control {control.verdict} ({control.reason})",
        )
    if target.answer == control.answer:
        return Comparison(
            probe,
            INCONCLUSIVE,
            f"both locations answered the same way ({target.answer}); the probe did not tell "
            "them apart, so each location's own line stands alone",
        )
    return Comparison(
        probe,
        target.verdict,
        f"{target.reason}; the control answered differently: {control.verdict} ({control.answer})",
    )


def _line(text: str) -> str:
    return " ".join(text.split())


def render(
    target: str,
    control: str,
    target_results: Mapping[str, Outcome],
    control_results: Mapping[str, Outcome],
    cleanups: Mapping[str, tuple[int, list[str]]],
    run_id: str,
) -> list[str]:
    lines = [f"run {run_id} target={target} control={control}"]
    for location, results in ((target, target_results), (control, control_results)):
        for name in PROBE_NAMES:
            outcome = results[name]
            lines.append(
                _line(f"{location} {name} {outcome.verdict}: {outcome.reason}")
            )
    for name in PROBE_NAMES:
        verdict = compare(name, target_results[name], control_results[name])
        lines.append(_line(f"compare {name} {verdict.verdict}: {verdict.reason}"))
    for location, (removed, left) in cleanups.items():
        tail = "" if not left else " left behind: " + ", ".join(left)
        lines.append(
            _line(
                f"cleanup {location}: removed {removed}, not removed {len(left)}{tail}"
            )
        )
    return lines


@dataclasses.dataclass(frozen=True)
class SiteNames:
    endpoint: str
    location: str
    bucket: str


def _env(environ: Mapping[str, str], option: str, name: str) -> str:
    if not _NAME.match(name):
        raise ConfigError(
            f"{option} must name an environment variable (capital letters, digits, underscore)"
        )
    value = environ.get(name, "")
    if not value:
        raise ConfigError(f"the variable named by {option} is not set")
    return value


def endpoint_host(raw: str) -> str:
    if "//" in raw:
        parts = urllib.parse.urlsplit(raw)
        if parts.scheme != "https" or not parts.netloc:
            raise ConfigError("an endpoint must be a bare host name or an https URL")
        raw = parts.netloc
    host = raw.strip("/")
    if not re.match(r"\A[A-Za-z0-9.-]{3,253}\Z", host):
        raise ConfigError("an endpoint must be a bare host name or an https URL")
    return host


def read_site(
    environ: Mapping[str, str],
    prefix: str,
    names: SiteNames,
    owner: tuple[str, str],
    fence: tuple[str, str],
) -> Site:
    location = _env(environ, f"--{prefix}-location-env", names.location)
    if not _LOCATION.match(location):
        raise ConfigError(
            f"the value of --{prefix}-location-env is not a location name"
        )
    bucket = _env(environ, f"--{prefix}-bucket-env", names.bucket)
    try:
        _policy.validate_bucket_name(bucket)
    except _policy.PolicyInputError:
        raise ConfigError(
            f"the value of --{prefix}-bucket-env is not a bucket name"
        ) from None
    if not bucket.startswith(BUCKET_MARKER):
        raise ConfigError(
            f"the value of --{prefix}-bucket-env does not start with the throwaway marker "
            f"{BUCKET_MARKER!r}; this program only runs against a bucket made for it"
        )
    credentials = []
    for label, (id_name, secret_name) in (("owner", owner), ("fence", fence)):
        key_id = _env(environ, f"--{label}-key-id-env", id_name)
        secret = _env(environ, f"--{label}-secret-env", secret_name)
        if not re.match(r"\A[A-Za-z0-9]{16,64}\Z", key_id):
            raise ConfigError(
                f"the value of --{label}-key-id-env is not an access key id"
            )
        if not _SECRET_KEY.match(secret):
            raise ConfigError(
                f"the value of --{label}-secret-env does not look like a secret key"
            )
        credentials.append(Credentials(key_id, secret))
    if credentials[0].key_id == credentials[1].key_id:
        raise ConfigError("the owner key and the fence key are the same key")
    return Site(
        location=location,
        endpoint=endpoint_host(
            _env(environ, f"--{prefix}-endpoint-env", names.endpoint)
        ),
        bucket=bucket,
        owner=credentials[0],
        fence=credentials[1],
    )


def build_context(
    site: Site,
    wire: Wire,
    network: Network,
    run_id: str,
    dwell: float,
    ack: float,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Context:
    def now() -> datetime.datetime:
        # datetime.UTC needs 3.11; the shebang interpreter can be 3.9
        return datetime.datetime.now(datetime.timezone.utc)  # noqa: UP017

    return Context(
        site=site,
        wire=wire,
        network=network,
        owner=S3Client(site, wire, site.owner, now),
        fence=S3Client(site, wire, site.fence, now),
        anonymous=S3Client(site, wire, None, now),
        prefix=f"gw-probe-{run_id}",
        clock=clock,
        sleep=sleep,
        dwell_seconds=dwell,
        ack_seconds=ack,
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the gateway's storage probes at a location and a control. "
        "Every option takes the NAME of an environment variable, never a value."
    )
    for side in ("target", "control"):
        for what in ("endpoint", "location", "bucket"):
            parser.add_argument(f"--{side}-{what}-env", required=True, metavar="NAME")
    for who in ("owner", "fence"):
        parser.add_argument(f"--{who}-key-id-env", required=True, metavar="NAME")
        parser.add_argument(f"--{who}-secret-env", required=True, metavar="NAME")
    parser.add_argument("--dwell-seconds", type=float, default=DEFAULT_DWELL_SECONDS)
    parser.add_argument("--ack-seconds", type=float, default=DEFAULT_ACK_SECONDS)
    return parser.parse_args(list(argv))


def main(
    argv: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
    wire_for: Callable[[Site], Wire] | None = None,
    network: Network | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    out = out or sys.stdout
    err = err or sys.stderr
    args = parse_args(sys.argv[1:] if argv is None else argv)
    env = os.environ if environ is None else environ
    owner = (args.owner_key_id_env, args.owner_secret_env)
    fence = (args.fence_key_id_env, args.fence_secret_env)
    try:
        sites = [
            read_site(
                env,
                side,
                SiteNames(
                    getattr(args, f"{side}_endpoint_env"),
                    getattr(args, f"{side}_location_env"),
                    getattr(args, f"{side}_bucket_env"),
                ),
                owner,
                fence,
            )
            for side in ("target", "control")
        ]
        if sites[0].endpoint == sites[1].endpoint or sites[0].bucket == sites[1].bucket:
            raise ConfigError(
                "the target and the control name the same endpoint or bucket"
            )
        if sites[0].location == sites[1].location:
            raise ConfigError("the target and the control name the same location")
    except ConfigError as exc:
        print(f"refused: {exc}", file=err)
        return EXIT_CONFIG
    redact = Redactor([v for site in sites for v in site.sensitive()])
    run_id = secrets.token_hex(4)
    contexts = [
        build_context(
            site,
            wire_for(site) if wire_for is not None else Wire(),
            network or Network(),
            run_id,
            args.dwell_seconds,
            args.ack_seconds,
            clock,
            sleep,
        )
        for site in sites
    ]
    problems = [
        (ctx.site.location, reason)
        for ctx in contexts
        if (reason := preflight(ctx)) is not None
    ]
    if problems:
        for location, reason in problems:
            print(
                f"refused: {location}: {redact(reason)}; nothing was written", file=err
            )
        return EXIT_NOT_THROWAWAY
    for site in sites:
        print(f"started {site.location}", file=err)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        finished = list(pool.map(lambda ctx: run_site(ctx, redact), contexts))
    target, control = sites[0].location, sites[1].location
    lines = render(
        target,
        control,
        finished[0][0],
        finished[1][0],
        {target: finished[0][1], control: finished[1][1]},
        run_id,
    )
    for line in lines:
        print(redact(line), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
