#!/usr/bin/env python3
"""Minimal SigV4 PUT client for Hetzner Object Storage.

Stdlib only and PUT-only: the two jobs that use this (nightly dump, binlog
shipping) each write one object per run and read nothing back. The signing
algorithm is the same one
`shared-infra/hetzner/scripts/probe-object-storage.py` proves works against
this endpoint; path-style addressing is mandatory there for the same reason
it is here -- a dotted bucket name falls outside the endpoint's one-label
wildcard certificate.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ALGORITHM = "AWS4-HMAC-SHA256"


class ObjectStorageError(Exception):
    """The upload did not complete, or the endpoint rejected it."""


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret_key: str, date_stamp: str, region: str) -> bytes:
    key = _sign(f"AWS4{secret_key}".encode("utf-8"), date_stamp)
    key = _sign(key, region)
    key = _sign(key, "s3")
    return _sign(key, "aws4_request")


def _canonical_uri(bucket: str, key: str) -> str:
    return urllib.parse.quote(f"/{bucket}/{key}", safe="/~")


def build_headers(
    *,
    bucket: str,
    key: str,
    payload: bytes,
    host: str,
    region: str,
    access_key: str,
    secret_key: str,
    content_type: str,
    now: datetime.datetime,
) -> dict[str, str]:
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()

    headers = {
        "content-type": content_type,
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in sorted(headers))
    canonical_request = "\n".join(
        ["PUT", _canonical_uri(bucket, key), "", canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [ALGORITHM, amz_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()]
    )
    signature = hmac.new(
        _signing_key(secret_key, date_stamp, region), string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    headers["Authorization"] = (
        f"{ALGORITHM} Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return headers


def _urllib_put(url: str, headers: dict[str, str], payload: bytes) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=payload, method="PUT")
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except OSError as exc:
        raise ObjectStorageError(f"PUT {url} failed to complete: {exc}") from exc


def put_object(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    key: str,
    data: bytes,
    content_type: str = "application/octet-stream",
    transport=_urllib_put,
) -> None:
    """Uploads `data` to `key`, raising `ObjectStorageError` on anything but
    2xx. There is no retry here -- both callers are systemd oneshot units
    that a timer reschedules, so a transient failure is retried by the next
    scheduled run rather than by this function looping on its own."""
    headers = build_headers(
        bucket=bucket,
        key=key,
        payload=data,
        host=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        content_type=content_type,
        now=datetime.datetime.now(datetime.timezone.utc),
    )
    url = f"https://{endpoint}{_canonical_uri(bucket, key)}"
    status, body = transport(url, headers, data)
    if not (200 <= status < 300):
        code = None
        try:
            code = ET.fromstring(body).findtext("Code")
        except ET.ParseError:
            pass
        raise ObjectStorageError(
            f"PUT {bucket}/{key} failed: HTTP {status}" + (f" ({code})" if code else "")
        )
