#!/usr/bin/env python3
"""The weekly media backup: every enrolled tenant's folder on the shared media
buckets, read directly (never through the gateway), encrypted to that
tenant's own age recipient and written as a dated copy in the backup bucket.

Run by a systemd timer on the control host. Paced to a configured request
ceiling, retries `503 SlowDown` with backoff, and reports its duration.
See media_backup_weekly.md#module-overview.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import random
import re
import stat
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import backup_recipients  # noqa: E402
import media_backup_restore as mbr  # noqa: E402
import shared_objectstorage as shared  # noqa: E402

DEFAULT_RECIPIENTS_FILE = backup_recipients.DEFAULT_RECIPIENTS_FILE
DEFAULT_FOLDERS_FILE = "/etc/branchleft/backup-worker-media-folders"

# The provider allows 750 a second per source address and per bucket. The ceiling
# can never be set above this (see the doc, "Pacing").
HARD_CEILING_REQUESTS_PER_SECOND = 400.0
# Sustained SlowDown slows the run to this, never below.
FLOOR_REQUESTS_PER_SECOND = 1.0
MAX_ATTEMPTS = 8

_BUCKET = re.compile(r"\A[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\Z")
# The gateway's opaque folder: one path segment.
_FOLDER = re.compile(r"\A[A-Za-z0-9_-]{16,128}\Z")
_HOST = re.compile(r"\A[a-z0-9][a-z0-9.-]*[a-z0-9]\Z")
_REGION = re.compile(r"\A[a-z0-9][a-z0-9-]*\Z")
_NO_MEDIA = "no-media"
_SLOWDOWN_STATUS = 503

ENV_NAMES = (
    "MEDIA_LIVE_ENDPOINT",
    "MEDIA_LIVE_REGION",
    "MEDIA_LIVE_ACCESS_KEY_ID",
    "MEDIA_LIVE_SECRET_ACCESS_KEY",
    "MEDIA_BACKUP_ENDPOINT",
    "MEDIA_BACKUP_REGION",
    "MEDIA_BACKUP_BUCKET",
    "MEDIA_BACKUP_ACCESS_KEY_ID",
    "MEDIA_BACKUP_SECRET_ACCESS_KEY",
    "MEDIA_BACKUP_MANIFEST_SIGNING_KEY_FILE",
    "MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND",
)


class WeeklyConfigError(Exception):
    """The configuration cannot be trusted; nothing was read or written."""


@dataclasses.dataclass(frozen=True)
class FolderEntry:
    tenant: str
    bucket: str
    folder: str
    # The operator's assertion that this tenant has no media, so an empty
    # folder is a deliberately empty copy and not a failed listing.
    confirm_no_media: bool


@dataclasses.dataclass(frozen=True)
class Config:
    live_endpoint: str
    live_region: str
    live_access_key: str = dataclasses.field(repr=False)
    live_secret_key: str = dataclasses.field(repr=False)
    backup_endpoint: str
    backup_region: str
    backup_bucket: str
    backup_access_key: str = dataclasses.field(repr=False)
    backup_secret_key: str = dataclasses.field(repr=False)
    signing_key_file: str
    max_requests_per_second: float


def parse_folders(text: str) -> dict[str, FolderEntry]:
    """`tenant bucket folder [no-media]` per line; blank lines and #-comments
    ignored. Refuses a malformed line, a tenant listed twice, and one folder
    claimed by two tenants: that would copy one tenant's media under the other
    tenant's key."""
    entries: dict[str, FolderEntry] = {}
    claimed: dict[tuple[str, str], str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) not in (3, 4) or (len(fields) == 4 and fields[3] != _NO_MEDIA):
            raise WeeklyConfigError(f"line {number}: expected `tenant bucket folder` or `tenant bucket folder {_NO_MEDIA}`")
        tenant, bucket, folder = fields[:3]
        if not mbr._TENANT_SLUG_RE.match(tenant):
            raise WeeklyConfigError(f"line {number}: {tenant!r} is not a valid tenant name")
        if not _BUCKET.match(bucket):
            raise WeeklyConfigError(f"line {number}: tenant {tenant!r} has a bucket name that is not valid")
        if not _FOLDER.match(folder):
            raise WeeklyConfigError(f"line {number}: tenant {tenant!r} has a folder that is not one opaque path segment")
        if tenant in entries:
            raise WeeklyConfigError(f"line {number}: tenant {tenant!r} is listed more than once")
        owner = claimed.get((bucket, folder))
        if owner is not None:
            raise WeeklyConfigError(
                f"line {number}: tenants {owner!r} and {tenant!r} name the same folder; "
                "each tenant needs its own"
            )
        claimed[(bucket, folder)] = tenant
        entries[tenant] = FolderEntry(tenant, bucket, folder, len(fields) == 4)
    return entries


def _read_regular_file(path: str) -> str:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise WeeklyConfigError(f"{path} cannot be read: {exc.strerror}") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise WeeklyConfigError(f"{path} is not a regular file")
        chunks = []
        while chunk := os.read(fd, 65536):
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks).decode("utf-8", errors="replace")


def load_folders(path: str) -> dict[str, FolderEntry]:
    return parse_folders(_read_regular_file(path))


def config_from_env(env: Mapping[str, str]) -> Config:
    """Reads the run's settings. Every name is required and there is no default.
    A refusal names a setting, never a value."""
    missing = [name for name in ENV_NAMES if not env.get(name)]
    if missing:
        raise WeeklyConfigError("not set: " + ", ".join(missing))
    for name, pattern in (
        ("MEDIA_LIVE_ENDPOINT", _HOST),
        ("MEDIA_BACKUP_ENDPOINT", _HOST),
        ("MEDIA_LIVE_REGION", _REGION),
        ("MEDIA_BACKUP_REGION", _REGION),
        ("MEDIA_BACKUP_BUCKET", _BUCKET),
    ):
        if not pattern.match(env[name]):
            raise WeeklyConfigError(f"{name} is not valid")
    try:
        rate = float(env["MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND"])
    except ValueError:
        raise WeeklyConfigError("MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND is not a number") from None
    if not (FLOOR_REQUESTS_PER_SECOND <= rate <= HARD_CEILING_REQUESTS_PER_SECOND):
        raise WeeklyConfigError(
            f"MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND must be from {FLOOR_REQUESTS_PER_SECOND:g} to "
            f"{HARD_CEILING_REQUESTS_PER_SECOND:g}, well below the provider's 750 a second"
        )
    # Backup copies never go in a media bucket (see the doc, "Where the copies go").
    if "media" in env["MEDIA_BACKUP_BUCKET"]:
        raise WeeklyConfigError("MEDIA_BACKUP_BUCKET names a media bucket; backup copies go in the backup bucket")
    return Config(
        live_endpoint=env["MEDIA_LIVE_ENDPOINT"],
        live_region=env["MEDIA_LIVE_REGION"],
        live_access_key=env["MEDIA_LIVE_ACCESS_KEY_ID"],
        live_secret_key=env["MEDIA_LIVE_SECRET_ACCESS_KEY"],
        backup_endpoint=env["MEDIA_BACKUP_ENDPOINT"],
        backup_region=env["MEDIA_BACKUP_REGION"],
        backup_bucket=env["MEDIA_BACKUP_BUCKET"],
        backup_access_key=env["MEDIA_BACKUP_ACCESS_KEY_ID"],
        backup_secret_key=env["MEDIA_BACKUP_SECRET_ACCESS_KEY"],
        signing_key_file=env["MEDIA_BACKUP_MANIFEST_SIGNING_KEY_FILE"],
        max_requests_per_second=rate,
    )


def check_plan(config: Config, recipients: Mapping[str, str], folders: Mapping[str, FolderEntry]) -> None:
    """Refusals that need no network: run at the start of every run and by `--check`."""
    if not recipients:
        raise WeeklyConfigError("the recipients file lists no tenant")
    if len(set(recipients.values())) != len(recipients):
        raise WeeklyConfigError("two tenants share one recipient; each tenant needs its own")
    for entry in folders.values():
        if (config.live_endpoint, entry.bucket) == (config.backup_endpoint, config.backup_bucket):
            raise WeeklyConfigError("the backup bucket is also a live media bucket")
    if not os.path.isfile(config.signing_key_file):
        raise WeeklyConfigError("the manifest signing key file is not a file")
    if not os.access(config.signing_key_file, os.R_OK):
        raise WeeklyConfigError("the manifest signing key file cannot be read by this account")


class RequestPacer:
    """Spaces every request the run makes to a ceiling and halves the rate on
    each `503 SlowDown`. See the doc, "Pacing"."""

    def __init__(
        self,
        *,
        ceiling: float,
        floor: float = FLOOR_REQUESTS_PER_SECOND,
        recover_after: int = 200,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not (0 < floor <= ceiling <= HARD_CEILING_REQUESTS_PER_SECOND):
            raise WeeklyConfigError("the request ceiling is outside what is allowed")
        self.ceiling = ceiling
        self.floor = floor
        self.rate = ceiling
        self.requests = 0
        self.slowdowns = 0
        self._recover_after = recover_after
        self._clock = clock
        self._sleep = sleep
        self._next_slot = 0.0
        self._streak = 0

    def wait(self) -> None:
        now = self._clock()
        slot = max(now, self._next_slot)
        if slot > now:
            self._sleep(slot - now)
        self._next_slot = slot + 1.0 / self.rate
        self.requests += 1

    def record_success(self) -> None:
        self._streak += 1
        if self._streak >= self._recover_after and self.rate < self.ceiling:
            self.rate = min(self.ceiling, self.rate * 1.25)
            self._streak = 0

    def record_slowdown(self) -> None:
        self.slowdowns += 1
        self.rate = max(self.floor, self.rate / 2)
        self._streak = 0


class PacedTransport:
    """The transports the storage calls take, each paced and each retrying
    `503` with a jittered backoff. See the doc, "Pacing"."""

    def __init__(
        self,
        pacer: RequestPacer,
        *,
        sleep: Callable[[float], None] = time.sleep,
        jitter: Callable[[], float] = random.random,
        backoff_base: float = 1.0,
        backoff_cap: float = 60.0,
        get: Callable[..., Any] = lambda url, headers: shared.urllib_request(url, headers, b"", "GET"),
        put: Callable[..., Any] = lambda url, headers, payload: shared.urllib_request(url, headers, payload, "PUT"),
        get_with_headers: Callable[..., Any] = shared.urllib_get_with_headers,
    ) -> None:
        self._pacer = pacer
        self._sleep = sleep
        self._jitter = jitter
        self._base = backoff_base
        self._cap = backoff_cap
        self._get = get
        self._put = put
        self._get_with_headers = get_with_headers

    def _send(self, call: Callable[[], Any]) -> Any:
        result = None
        for attempt in range(MAX_ATTEMPTS):
            self._pacer.wait()
            result = call()
            if result[0] != _SLOWDOWN_STATUS:
                self._pacer.record_success()
                return result
            self._pacer.record_slowdown()
            if attempt + 1 < MAX_ATTEMPTS:
                self._sleep(min(self._cap, self._base * 2**attempt) * (0.5 + self._jitter() / 2))
        return result

    def get(self, url: str, headers: dict[str, str]) -> Any:
        return self._send(lambda: self._get(url, headers))

    def put(self, url: str, headers: dict[str, str], payload: bytes) -> Any:
        return self._send(lambda: self._put(url, headers, payload))

    def get_with_headers(self, url: str, headers: dict[str, str]) -> Any:
        return self._send(lambda: self._get_with_headers(url, headers))


@dataclasses.dataclass
class TenantResult:
    tenant: str
    ok: bool
    run_id: str = ""
    objects: int = 0
    bytes_copied: int = 0
    manifest_key: str = ""
    reason: str = ""


def _backup_one(
    entry: FolderEntry,
    recipient: str,
    config: Config,
    transport: PacedTransport,
) -> TenantResult:
    prefix = entry.folder + "/"

    def list_objects(**kw: Any) -> list[dict[str, str]]:
        return shared.list_objects(prefix=prefix, transport=transport.get, **kw)

    def get_object_with_content_type(**kw: Any) -> tuple[bytes, str]:
        return shared.get_object_with_content_type(transport=transport.get_with_headers, **kw)

    def put_object(**kw: Any) -> None:
        shared.put_object(transport=transport.put, **kw)

    report = mbr.backup_tenant_media(
        tenant=entry.tenant,
        live_bucket=entry.bucket,
        backup_bucket=config.backup_bucket,
        endpoint=config.live_endpoint,
        region=config.live_region,
        backup_endpoint=config.backup_endpoint,
        backup_region=config.backup_region,
        live_access_key=config.live_access_key,
        live_secret_key=config.live_secret_key,
        backup_access_key=config.backup_access_key,
        backup_secret_key=config.backup_secret_key,
        recipient=recipient,
        manifest_signing_key_path=config.signing_key_file,
        confirm_tenant_has_no_media=entry.confirm_no_media,
        list_objects=list_objects,
        get_object_with_content_type=get_object_with_content_type,
        put_object=put_object,
    )
    return TenantResult(
        tenant=entry.tenant,
        ok=True,
        run_id=report.run_id,
        objects=report.object_count,
        bytes_copied=sum(int(o["size"]) for o in report.objects.values()),
        manifest_key=mbr._manifest_key(entry.tenant, report.run_id),
    )


@dataclasses.dataclass
class RunSummary:
    results: list[TenantResult]
    requests: int
    slowdowns: int
    ceiling: float
    final_rate: float
    duration_seconds: float

    @property
    def failed(self) -> int:
        return sum(1 for r in self.results if not r.ok)


def run(
    config: Config,
    recipients: Mapping[str, str],
    folders: Mapping[str, FolderEntry],
    *,
    transport: PacedTransport | None = None,
    pacer: RequestPacer | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> RunSummary:
    """Backs up every tenant in `recipients`, one after the other, each to its
    own recipient. One tenant failing is that tenant's failure: it is counted
    and the loop goes on."""
    check_plan(config, recipients, folders)
    pacer = pacer or RequestPacer(ceiling=config.max_requests_per_second)
    transport = transport or PacedTransport(pacer)
    started = clock()
    results: list[TenantResult] = []
    for tenant in sorted(recipients):
        entry = folders.get(tenant)
        if entry is None:
            results.append(TenantResult(tenant, False, reason="no media folder is listed for this tenant"))
            continue
        try:
            results.append(_backup_one(entry, recipients[tenant], config, transport))
        except (mbr.MediaBackupError, shared.ObjectStorageError) as error:
            results.append(TenantResult(tenant, False, reason=str(error)))
        except Exception as error:  # noqa: BLE001 - class name only, never a message that could carry a value
            results.append(TenantResult(tenant, False, reason=f"unexpected {type(error).__name__}"))
    return RunSummary(
        results=results,
        requests=pacer.requests,
        slowdowns=pacer.slowdowns,
        ceiling=pacer.ceiling,
        final_rate=pacer.rate,
        duration_seconds=clock() - started,
    )


def report_lines(summary: RunSummary) -> list[str]:
    lines = []
    for r in summary.results:
        if r.ok:
            lines.append(
                f"media_backup_weekly: tenant={r.tenant} ok run_id={r.run_id} objects={r.objects} "
                f"bytes={r.bytes_copied} manifest={r.manifest_key}"
            )
        else:
            lines.append(f"media_backup_weekly: tenant={r.tenant} FAILED {r.reason}")
    lines.append(
        f"media_backup_weekly: summary tenants={len(summary.results)} ok={len(summary.results) - summary.failed} "
        f"failed={summary.failed} objects={sum(r.objects for r in summary.results)} "
        f"bytes={sum(r.bytes_copied for r in summary.results)} requests={summary.requests} "
        f"slowdowns={summary.slowdowns} ceiling_rps={summary.ceiling:g} final_rps={summary.final_rate:g} "
        f"duration_seconds={summary.duration_seconds:.1f}"
    )
    return lines


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--recipients-file", default=os.environ.get("BACKUP_WORKER_RECIPIENTS_FILE", DEFAULT_RECIPIENTS_FILE))
    parser.add_argument("--folders-file", default=DEFAULT_FOLDERS_FILE)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate the settings and both files, touch no bucket, print nothing about any value",
    )
    args = parser.parse_args(argv)
    try:
        config = config_from_env(os.environ if env is None else env)
        recipients = backup_recipients.load_recipients(args.recipients_file)
        folders = load_folders(args.folders_file)
        check_plan(config, recipients, folders)
        if args.check:
            print(f"media_backup_weekly: check ok tenants={len(recipients)}", file=sys.stderr)
            return 0
        summary = run(config, recipients, folders)
    except (WeeklyConfigError, backup_recipients.RecipientError) as error:
        print(f"media_backup_weekly: refused: {error}", file=sys.stderr)
        return 2
    for line in report_lines(summary):
        print(line, file=sys.stderr)
    return 1 if summary.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
