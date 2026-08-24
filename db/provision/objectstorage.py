#!/usr/bin/env python3
"""Minimal SigV4 client for Hetzner Object Storage.

Stdlib only. The two automated write pipelines (nightly dump, binlog
shipping) each write one object per run and read nothing back, so they only
ever use `put_object`. `list_objects` and `delete_object` exist for
`prune_backups.py`, which has to read the bucket's own listing to decide what
is safe to remove. The signing algorithm is the same one
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
    """The request did not complete, or the endpoint rejected it."""


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret_key: str, date_stamp: str, region: str) -> bytes:
    key = _sign(f"AWS4{secret_key}".encode("utf-8"), date_stamp)
    key = _sign(key, region)
    key = _sign(key, "s3")
    return _sign(key, "aws4_request")


def _canonical_uri(bucket: str, key: str | None) -> str:
    path = f"/{bucket}" if key is None else f"/{bucket}/{key}"
    return urllib.parse.quote(path, safe="/~")


def _canonical_query(query: dict[str, str] | None) -> str:
    """S3 sub-resource query parameters (`?versioning`, `?lifecycle`) are
    part of the signature, sorted, with valueless parameters present as
    `name=`."""
    if not query:
        return ""
    parts = []
    for name in sorted(query):
        k = urllib.parse.quote(name, safe="~")
        v = urllib.parse.quote(query[name] or "", safe="~")
        parts.append(f"{k}={v}")
    return "&".join(parts)


def build_headers(
    *,
    bucket: str,
    key: str | None,
    payload: bytes,
    host: str,
    region: str,
    access_key: str,
    secret_key: str,
    now: datetime.datetime,
    query: dict[str, str] | None = None,
    content_type: str | None = None,
    extra_headers: dict[str, str] | None = None,
    method: str = "PUT",
) -> dict[str, str]:
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()

    headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    if content_type is not None:
        headers["content-type"] = content_type
    for name, value in (extra_headers or {}).items():
        headers[name.lower()] = value

    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in sorted(headers))
    canonical_request = "\n".join(
        [
            method,
            _canonical_uri(bucket, key),
            _canonical_query(query),
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
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


def _request_url(*, endpoint: str, bucket: str, key: str | None, query: dict[str, str] | None) -> str:
    url = f"https://{endpoint}{_canonical_uri(bucket, key)}"
    q = _canonical_query(query)
    return f"{url}?{q}" if q else url


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


def _raise_for_status(*, what: str, status: int, body: bytes) -> None:
    if 200 <= status < 300:
        return
    code = None
    try:
        code = ET.fromstring(body).findtext("Code")
    except ET.ParseError:
        pass
    raise ObjectStorageError(f"{what} failed: HTTP {status}" + (f" ({code})" if code else ""))


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
    url = _request_url(endpoint=endpoint, bucket=bucket, key=key, query=None)
    status, body = transport(url, headers, data)
    _raise_for_status(what=f"PUT {bucket}/{key}", status=status, body=body)


def _urllib_get(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, method="GET")
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except OSError as exc:
        raise ObjectStorageError(f"GET {url} failed to complete: {exc}") from exc


def _urllib_delete(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, method="DELETE")
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except OSError as exc:
        raise ObjectStorageError(f"DELETE {url} failed to complete: {exc}") from exc


def _local_name(tag: str) -> str:
    """Strips the S3 XML namespace off an ElementTree tag -- Hetzner's RGW
    responses carry the same `s3.amazonaws.com` doc namespace
    `configure_backup_bucket.py`'s `S3_NS` already assumes on the request
    side, and ElementTree exposes it as a `{namespace}Tag` prefix on every
    parsed element."""
    return tag.rsplit("}", 1)[-1]


def _parse_list_objects_v2(body: bytes) -> tuple[list[dict[str, str]], bool, str | None]:
    root = ET.fromstring(body)
    objects: list[dict[str, str]] = []
    is_truncated = False
    next_token = None
    for child in root:
        name = _local_name(child.tag)
        if name == "Contents":
            entry = {_local_name(grandchild.tag): grandchild.text for grandchild in child}
            if entry.get("Key"):
                objects.append({"key": entry["Key"], "last_modified": entry.get("LastModified", "")})
        elif name == "IsTruncated":
            is_truncated = (child.text or "").strip().lower() == "true"
        elif name == "NextContinuationToken":
            next_token = child.text
    return objects, is_truncated, next_token


def list_objects(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    prefix: str | None = None,
    transport=_urllib_get,
) -> list[dict[str, str]]:
    """Lists every object under `prefix` (the whole bucket if omitted) as
    `{"key": ..., "last_modified": ...}`, paginating on
    `IsTruncated`/`NextContinuationToken` until the listing is complete.
    Read-only -- safe to call against the live bucket at any time."""
    results: list[dict[str, str]] = []
    continuation_token: str | None = None
    while True:
        query = {"list-type": "2"}
        if prefix is not None:
            query["prefix"] = prefix
        if continuation_token is not None:
            query["continuation-token"] = continuation_token
        headers = build_headers(
            bucket=bucket,
            key=None,
            payload=b"",
            host=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            now=datetime.datetime.now(datetime.timezone.utc),
            query=query,
            method="GET",
        )
        url = _request_url(endpoint=endpoint, bucket=bucket, key=None, query=query)
        status, body = transport(url, headers)
        _raise_for_status(what=f"GET {bucket}?list-type=2", status=status, body=body)
        objects, is_truncated, next_token = _parse_list_objects_v2(body)
        results.extend(objects)
        if not is_truncated:
            return results
        if not next_token:
            # `IsTruncated=true` with no token to resume from: doc 14 §16.3
            # records this backend accepting a request and silently dropping
            # an element, so a response shaped like this is a corrupt
            # listing, not a complete one. Returning `results` here would
            # read as "this is everything" to every caller downstream,
            # including the retention decision -- raise instead of
            # pretending the page count is known.
            raise ObjectStorageError(
                f"GET {bucket}?list-type=2: IsTruncated=true but no NextContinuationToken -- "
                "listing may be incomplete"
            )
        continuation_token = next_token


def delete_object(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    key: str,
    transport=_urllib_delete,
) -> None:
    """Deletes `key`, raising `ObjectStorageError` on anything but a 2xx or a
    404. The 404 tolerance makes this idempotent: `prune_backups.py` may be
    re-run after a partial failure, and a key it already deleted must not
    turn a safe re-run into an error."""
    headers = build_headers(
        bucket=bucket,
        key=key,
        payload=b"",
        host=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        now=datetime.datetime.now(datetime.timezone.utc),
        method="DELETE",
    )
    url = _request_url(endpoint=endpoint, bucket=bucket, key=key, query=None)
    status, body = transport(url, headers)
    if status == 404:
        return
    _raise_for_status(what=f"DELETE {bucket}/{key}", status=status, body=body)


def put_bucket_subresource(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    subresource: str,
    body: bytes,
    content_md5: str | None = None,
    transport=_urllib_put,
) -> None:
    """PUTs a bucket-level subresource document (`?versioning`, `?lifecycle`)
    -- a one-time, hand-run operation, never called by either automated
    pipeline. `content_md5` (base64, RFC 1864) is required by this endpoint
    for `?lifecycle` and not for `?versioning`, matching
    `shared-infra/hetzner/scripts/probe-object-storage.py`'s already-proven
    behaviour against the same API."""
    query = {subresource: ""}
    extra_headers = {"content-md5": content_md5} if content_md5 else None
    headers = build_headers(
        bucket=bucket,
        key=None,
        payload=body,
        host=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        now=datetime.datetime.now(datetime.timezone.utc),
        query=query,
        extra_headers=extra_headers,
    )
    url = _request_url(endpoint=endpoint, bucket=bucket, key=None, query=query)
    status, response_body = transport(url, headers, body)
    _raise_for_status(what=f"PUT {bucket}?{subresource}", status=status, body=response_body)
