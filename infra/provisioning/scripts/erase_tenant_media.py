#!/usr/bin/env python3
"""Erases one tenant's live media: disables the tenant's gateway credential,
deletes every version and delete marker under the tenant's folder until none
remain, checks the result against a final version listing and the gateway's
write ledger, purges the edge cache and destroys the tenant's backup identity.
An operator job, never on the gateway. It stops loudly, with a non-zero exit,
on any mismatch. See erase_tenant_media.md.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import json
import os
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol

import shared_objectstorage

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_USAGE = 2
EXIT_RED = 3

# The gateway's own rule for a folder name (services/storage-gateway admin).
FOLDER_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")

# Hetzner admits 750 requests a second per source address and, separately, per
# bucket, and neither can be raised. Live readers and writers share the shard,
# so the job is held far below it and refuses a ceiling above this.
DEFAULT_MAX_RPS = 100.0
HARD_MAX_RPS = 300.0

MAX_ROUNDS = 20
MAX_VERSION_PAGES = 10_000
MAX_ATTEMPTS = 8
BACKOFF_START_SECONDS = 0.5
BACKOFF_CAP_SECONDS = 30.0
MAX_REGISTER_BYTES = 8 * 1024 * 1024

ENV_ACCESS_KEY = "ERASE_MEDIA_ACCESS_KEY_ID"
ENV_SECRET_KEY = "ERASE_MEDIA_SECRET_ACCESS_KEY"

ADMIN_CALLER = "erasure-job"


class Refusal(Exception):
    """Raised before anything is changed."""


class RedCheck(Exception):
    """Raised when a step ends in a state the job cannot call erased."""


def _say(message: str) -> None:
    print(f"erase_tenant_media: {message}")


def _alert(message: str) -> None:
    print(f"erase_tenant_media: ALERT: {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# The ports
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True, order=True)
class ObjectVersion:
    key: str
    version_id: str
    kind: str  # "version" or "delete_marker"


class StoreError(Exception):
    """An object-store call that did not succeed. `status` is the HTTP status,
    or 0 when no response arrived."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class MediaStore(Protocol):
    """A media shard as erasure sees it: list versions and delete a version,
    with deliberately no read or write of an object."""

    def list_versions(self, prefix: str) -> list[ObjectVersion]: ...

    def delete_version(self, version: ObjectVersion) -> None: ...


@dataclasses.dataclass(frozen=True)
class GatewayCredential:
    key_id: str
    folder: str
    bucket: str
    state: str


class GatewayAdmin(Protocol):
    def disable_folder(self, folder: str) -> list[GatewayCredential]:
        """Disables every credential the folder has and answers with all of
        them. Raises Refusal when the gateway knows no credential for it."""
        ...


class EdgePurge(Protocol):
    def check_ready(self) -> None:
        """Raises Refusal when a purge could not be made, before anything changes."""
        ...

    def purge_folder(self, folder: str) -> None: ...


class BackupIdentityEraser(Protocol):
    def erase(self, tenant_id: str) -> None:
        """Destroys the tenant's backup identity. Raises RedCheck when it is not shown gone."""
        ...


class WriteLedger(Protocol):
    def object_keys(self, folder: str) -> set[str]:
        """Every object name the gateway has recorded a write for, for the folder."""
        ...


# ---------------------------------------------------------------------------
# The register: which folders are tenants'
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class RegisteredTenant:
    tenant_id: str
    folder: str
    bucket: str


def read_register(path: str) -> list[RegisteredTenant]:
    """The tenant register: a JSON file with an `entries` list, each entry
    carrying `tenantId`, `mediaFolder` and `mediaBucket`. Anything unreadable
    or malformed refuses the run."""
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            raise Refusal("the tenant register is not a regular file")
        if info.st_size > MAX_REGISTER_BYTES:
            raise Refusal("the tenant register is too large to be one")
        with open(path, "rb") as handle:
            document = json.loads(handle.read())
    except OSError as exc:
        raise Refusal(f"the tenant register cannot be read ({type(exc).__name__})") from None
    except ValueError:
        raise Refusal("the tenant register is not valid JSON") from None
    if not isinstance(document, dict) or not isinstance(document.get("entries"), list):
        raise Refusal('the tenant register has no "entries" list')
    found: list[RegisteredTenant] = []
    for raw in document["entries"]:
        if not isinstance(raw, dict):
            raise Refusal("a register entry is not an object")
        values = [raw.get("tenantId"), raw.get("mediaFolder"), raw.get("mediaBucket")]
        if not all(isinstance(value, str) and value for value in values):
            raise Refusal("a register entry has no tenantId, mediaFolder or mediaBucket")
        found.append(RegisteredTenant(str(values[0]), str(values[1]), str(values[2])))
    return found


def resolve_tenant(register: Sequence[RegisteredTenant], folder: str, bucket: str) -> RegisteredTenant:
    """The one registered tenant whose folder is exactly `folder` in `bucket`.
    A folder that is only the start of another tenant's folder is refused by
    name, so a truncated paste can never reach a neighbour."""
    if not FOLDER_PATTERN.match(folder):
        raise Refusal("the folder is not a valid folder name; nothing changed")
    exact = [entry for entry in register if entry.folder == folder]
    if not exact:
        longer = [entry for entry in register if entry.folder.startswith(folder)]
        if longer:
            raise Refusal(
                "the folder is a prefix of another tenant's folder and is not itself a registered tenant's; "
                "nothing changed"
            )
        raise Refusal("the folder is not a registered tenant's; nothing changed")
    if len(exact) > 1:
        raise Refusal("the register lists the folder more than once; nothing changed")
    tenant = exact[0]
    if tenant.bucket != bucket:
        raise Refusal("the folder is registered in a different bucket; nothing changed")
    for other in register:
        if other is not tenant and (other.folder == folder or other.tenant_id == tenant.tenant_id):
            raise Refusal("the register is ambiguous about this tenant; nothing changed")
    return tenant


def folder_prefix(folder: str) -> str:
    """The listing prefix. The trailing slash means the folder `abc...` can
    never match the objects of `abc...x`."""
    return f"{folder}/"


# ---------------------------------------------------------------------------
# The ledger
# ---------------------------------------------------------------------------


class SqliteLedgerReader:
    """The gateway's write ledger, read-only, from a copy of its SQLite file."""

    def __init__(self, path: str) -> None:
        if not os.path.isfile(path):
            raise Refusal("the write ledger file does not exist; nothing changed")
        self._uri = f"file:{path}?mode=ro"

    def object_keys(self, folder: str) -> set[str]:
        try:
            connection = sqlite3.connect(self._uri, uri=True)
        except sqlite3.Error as exc:
            raise RedCheck(f"the write ledger cannot be opened ({type(exc).__name__})") from None
        try:
            rows = connection.execute("SELECT object_key FROM write_ledger WHERE folder = ?", (folder,)).fetchall()
        except sqlite3.Error as exc:
            raise RedCheck(f"the write ledger cannot be read ({type(exc).__name__})") from None
        finally:
            connection.close()
        return {str(row[0]) for row in rows}


# ---------------------------------------------------------------------------
# Pacing and retry
# ---------------------------------------------------------------------------


class Pacer:
    """Holds the job's request rate at or under a ceiling."""

    def __init__(
        self,
        max_rps: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not 0 < max_rps <= HARD_MAX_RPS:
            raise Refusal(f"the request ceiling must be above 0 and at most {HARD_MAX_RPS:g} a second; nothing changed")
        self._interval = 1.0 / max_rps
        self._clock = clock
        self._sleep = sleep
        self._next = clock()

    def wait(self) -> None:
        now = self._clock()
        if now < self._next:
            self._sleep(self._next - now)
            now = self._next
        self._next = now + self._interval


@dataclasses.dataclass
class RunCounts:
    requests: int = 0
    slowdowns: int = 0


class PacedStore:
    """Wraps a store so every call is paced and a `503 SlowDown` is retried
    with a doubling backoff. Any other failure, and a 503 that outlasts the
    attempts, is raised."""

    def __init__(
        self,
        store: MediaStore,
        pacer: Pacer,
        counts: RunCounts,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._store = store
        self._pacer = pacer
        self._counts = counts
        self._sleep = sleep

    def _call[T](self, action: Callable[[], T]) -> T:
        delay = BACKOFF_START_SECONDS
        for attempt in range(MAX_ATTEMPTS):
            self._pacer.wait()
            self._counts.requests += 1
            try:
                return action()
            except StoreError as exc:
                if exc.status != 503 or attempt == MAX_ATTEMPTS - 1:
                    raise
                self._counts.slowdowns += 1
                self._sleep(delay)
                delay = min(delay * 2, BACKOFF_CAP_SECONDS)
        raise AssertionError("unreachable")

    def list_versions(self, prefix: str) -> list[ObjectVersion]:
        return self._call(lambda: self._store.list_versions(prefix))

    def delete_version(self, version: ObjectVersion) -> None:
        self._call(lambda: self._store.delete_version(version))


# ---------------------------------------------------------------------------
# The shard, over the repository's one SigV4 implementation
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ShardAccess:
    bucket: str
    endpoint: str
    region: str
    access_key: str = dataclasses.field(repr=False)
    secret_key: str = dataclasses.field(repr=False)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


class SignedRequests(Protocol):
    """The part of the repository's SigV4 module this job uses."""

    def signed_request(
        self,
        *,
        method: str,
        endpoint: str,
        region: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        key: str | None = None,
        query: dict[str, str] | None = None,
    ) -> tuple[int, bytes]: ...


class S3MediaStore:
    """One shard through the erasure key; one request is one listing page, so
    pacing and retry see each request."""

    def __init__(self, access: ShardAccess, module: SignedRequests = shared_objectstorage) -> None:
        self._s3 = module
        self._access = access

    def _request(self, method: str, query: dict[str, str], key: str | None = None) -> tuple[int, bytes]:
        try:
            status, body = self._s3.signed_request(
                method=method,
                key=key,
                query=query,
                bucket=self._access.bucket,
                endpoint=self._access.endpoint,
                region=self._access.region,
                access_key=self._access.access_key,
                secret_key=self._access.secret_key,
            )
        except Exception as exc:  # noqa: BLE001 -- the class name only: a message could carry the key
            raise StoreError(f"the request did not complete ({type(exc).__name__})") from None
        return int(status), bytes(body)

    def list_versions(self, prefix: str) -> list[ObjectVersion]:
        """Every version and delete marker under `prefix`. An incomplete
        listing is an error, never a short answer."""
        found: list[ObjectVersion] = []
        key_marker: str | None = None
        version_marker: str | None = None
        for _ in range(MAX_VERSION_PAGES):
            query = {"versions": "", "prefix": prefix}
            if key_marker is not None:
                query["key-marker"] = key_marker
            if version_marker is not None:
                query["version-id-marker"] = version_marker
            status, body = self._request("GET", query)
            if not 200 <= status < 300:
                raise StoreError(f"listing the versions failed: HTTP {status}", status)
            truncated = False
            next_key: str | None = None
            next_version: str | None = None
            try:
                root = ET.fromstring(body)
            except ET.ParseError:
                raise StoreError("the version listing is not valid XML") from None
            for child in root:
                name = _local(child.tag)
                if name in ("Version", "DeleteMarker"):
                    fields = {_local(part.tag): (part.text or "") for part in child}
                    if not fields.get("Key"):
                        raise StoreError("a version entry has no key")
                    kind = "delete_marker" if name == "DeleteMarker" else "version"
                    found.append(ObjectVersion(fields["Key"], fields.get("VersionId", ""), kind))
                elif name == "IsTruncated":
                    truncated = (child.text or "").strip().lower() == "true"
                elif name == "NextKeyMarker":
                    next_key = child.text
                elif name == "NextVersionIdMarker":
                    next_version = child.text
            if not truncated:
                return found
            if not next_key:
                raise StoreError("the version listing is truncated with no marker to resume")
            key_marker, version_marker = next_key, next_version
        raise StoreError("the version listing did not end")

    def delete_version(self, version: ObjectVersion) -> None:
        if not version.version_id:
            raise StoreError("a version without a version id cannot be deleted by id")
        status, _ = self._request("DELETE", {"versionId": version.version_id}, key=version.key)
        if status != 404 and not 200 <= status < 300:
            raise StoreError(f"deleting a version failed: HTTP {status}", status)


# ---------------------------------------------------------------------------
# The gateway admin interface (step 1)
# ---------------------------------------------------------------------------


def _admin_payload(caller: str, method: str, path: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    """The bytes the gateway's admin interface verifies, in its own order."""
    return f"{caller}\n{method}\n{path}\n{timestamp}\n{nonce}\n".encode() + body


def openssl_ed25519_sign(key_file: str, payload: bytes) -> bytes:
    """Signs with the erasure job's Ed25519 key through `openssl`, so the
    private key is read by that process and never held here."""
    with tempfile.TemporaryDirectory() as scratch:
        message = os.path.join(scratch, "message")
        with open(message, "wb") as handle:
            handle.write(payload)
        try:
            done = subprocess.run(
                ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", key_file, "-in", message],
                capture_output=True,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise Refusal(f"the admin request could not be signed ({type(exc).__name__}); nothing changed") from None
    if done.returncode != 0 or len(done.stdout) != 64:
        raise Refusal("the admin request could not be signed with the admin key file; nothing changed")
    return done.stdout


class HttpGatewayAdmin:
    """Disables a folder through the gateway's admin interface as the
    `erasure-job` caller."""

    def __init__(
        self,
        base_url: str,
        key_file: str,
        *,
        sign: Callable[[str, bytes], bytes] = openssl_ed25519_sign,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key_file = key_file
        self._sign = sign
        self._now = now

    def disable_folder(self, folder: str) -> list[GatewayCredential]:
        path = f"/folders/{folder}/disable"
        timestamp = str(int(self._now()))
        nonce = secrets.token_hex(16)
        signature = self._sign(self._key_file, _admin_payload(ADMIN_CALLER, "POST", path, timestamp, nonce, b""))
        request = urllib.request.Request(
            self._base + path,
            data=b"",
            method="POST",
            headers={
                "x-gateway-admin-caller": ADMIN_CALLER,
                "x-gateway-admin-timestamp": timestamp,
                "x-gateway-admin-nonce": nonce,
                "x-gateway-admin-signature": base64.b64encode(signature).decode("ascii"),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 -- the operator names the gateway
                raw = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise Refusal("the gateway knows no credential for the folder; nothing changed") from None
            raise Refusal(f"the gateway refused the disable (HTTP {exc.code}); nothing changed") from None
        except (OSError, ValueError) as exc:
            raise Refusal(f"the gateway could not be reached ({type(exc).__name__}); nothing changed") from None
        return parse_credentials(raw)


def parse_credentials(raw: bytes) -> list[GatewayCredential]:
    try:
        document = json.loads(raw)
        credentials = [
            GatewayCredential(str(c["keyId"]), str(c["folder"]), str(c["bucket"]), str(c["state"]))
            for c in document["credentials"]
        ]
    except (ValueError, KeyError, TypeError):
        raise Refusal("the gateway's answer to the disable could not be read; nothing changed") from None
    return credentials


# ---------------------------------------------------------------------------
# The journal: the object names a run has seen, kept so a run again can still
# be checked against the ledger after the objects are gone
# ---------------------------------------------------------------------------


def journal_path(directory: str, folder: str) -> str:
    return os.path.join(directory, f"media-erasure-{folder}.json")


def read_journal(directory: str, folder: str) -> set[str]:
    path = journal_path(directory, folder)
    try:
        with open(path, "rb") as handle:
            document = json.loads(handle.read())
    except FileNotFoundError:
        return set()
    except (OSError, ValueError):
        raise Refusal("the journal of an earlier run cannot be read; nothing changed") from None
    keys = document.get("keys") if isinstance(document, dict) else None
    if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
        raise Refusal("the journal of an earlier run is malformed; nothing changed")
    return {str(key) for key in keys}


def write_journal(directory: str, folder: str, keys: set[str]) -> None:
    """Atomic and synced, so the names survive a crash between a delete and the check."""
    path = journal_path(directory, folder)
    handle, scratch = tempfile.mkstemp(dir=directory, prefix=".media-erasure-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(json.dumps({"folder": folder, "keys": sorted(keys)}).encode())
            out.flush()
            os.fsync(out.fileno())
        os.replace(scratch, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(scratch)
        raise


# ---------------------------------------------------------------------------
# The erasure
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class Report:
    tenant_id: str
    folder: str
    versions_deleted: int = 0
    delete_markers_deleted: int = 0
    object_names: int = 0
    rounds: int = 0
    requests: int = 0
    slowdowns: int = 0
    seconds: float = 0.0


def disable_credentials(admin: GatewayAdmin, tenant: RegisteredTenant) -> None:
    """Step 1. Every credential the folder has ever had must be disabled, and
    none may point at another folder or bucket."""
    credentials = admin.disable_folder(tenant.folder)
    if not credentials:
        raise RedCheck("the gateway answered with no credential for the folder")
    for credential in credentials:
        if credential.folder != tenant.folder or credential.bucket != tenant.bucket:
            raise RedCheck("a credential the gateway lists for the folder is for another folder or bucket")
        if credential.state != "disabled":
            raise RedCheck("a credential for the folder is still not disabled")
    _say(f"{tenant.tenant_id}: {len(credentials)} gateway credential(s) disabled")


def delete_everything(store: PacedStore, folder: str, report: Report, seen: set[str], journal_dir: str) -> None:
    """Step 2. Deletes every version and delete marker under the folder, and
    lists again, until a listing shows none."""
    prefix = folder_prefix(folder)
    for _ in range(MAX_ROUNDS):
        listed = store.list_versions(prefix)
        if not listed:
            return
        report.rounds += 1
        outside = [version for version in listed if not version.key.startswith(prefix)]
        if outside:
            raise RedCheck("the shard listed an object outside the folder; nothing further was deleted")
        # Recorded before the first delete: a run that dies half way is still checked.
        seen.update(version.key for version in listed)
        write_journal(journal_dir, folder, seen)
        for version in listed:
            store.delete_version(version)
            if version.kind == "delete_marker":
                report.delete_markers_deleted += 1
            else:
                report.versions_deleted += 1
    raise RedCheck(f"versions still remain after {MAX_ROUNDS} rounds of deletion")


def check_result(store: PacedStore, ledger: WriteLedger, folder: str, seen: set[str]) -> None:
    """Step 3. A fresh version listing must be empty, and the object names the
    erasure saw must be exactly the names the ledger recorded."""
    problems: list[str] = []
    prefix = folder_prefix(folder)
    remaining = store.list_versions(prefix)
    problems += [f"remaining after deletion: {version.kind} {version.key}" for version in remaining]

    recorded = ledger.object_keys(folder)
    stray_ledger = sorted(key for key in recorded if not key.startswith(prefix))
    problems += [f"the ledger holds a name outside the folder: {key}" for key in stray_ledger]
    unrecorded = sorted(seen - recorded)
    problems += [f"on the shard but not in the ledger: {key}" for key in unrecorded]
    unseen = sorted(recorded - seen)
    problems += [f"in the ledger but not shown by the listing: {key}" for key in unseen]
    if problems:
        for line in problems:
            _alert(line)
        raise RedCheck(f"the completeness check is RED ({len(problems)} mismatch(es))")


def erase_media(
    *,
    folder: str,
    bucket: str,
    register: Sequence[RegisteredTenant],
    admin: GatewayAdmin,
    store: MediaStore,
    ledger: WriteLedger,
    edge: EdgePurge,
    backup: BackupIdentityEraser,
    journal_dir: str,
    max_rps: float = DEFAULT_MAX_RPS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Report:
    """The whole erasure, steps 1 to 5. Raises Refusal before anything changes
    and RedCheck once a step cannot be called done; a failed run is run again."""
    tenant = resolve_tenant(register, folder, bucket)
    pacer = Pacer(max_rps, clock=clock, sleep=sleep)
    if not os.path.isdir(journal_dir):
        raise Refusal("the journal directory does not exist; nothing changed")
    seen = read_journal(journal_dir, folder)
    edge.check_ready()

    counts = RunCounts()
    paced = PacedStore(store, pacer, counts, sleep=sleep)
    report = Report(tenant_id=tenant.tenant_id, folder=folder)
    started = clock()

    disable_credentials(admin, tenant)
    delete_everything(paced, folder, report, seen, journal_dir)
    check_result(paced, ledger, folder, seen)
    report.object_names = len(seen)
    _say(f"{tenant.tenant_id}: completeness check green: {len(seen)} object name(s) match the ledger")

    edge.purge_folder(folder)
    _say(f"{tenant.tenant_id}: edge cache purged")
    backup.erase(tenant.tenant_id)
    _say(f"{tenant.tenant_id}: backup identity destroyed")

    report.requests = counts.requests
    report.slowdowns = counts.slowdowns
    report.seconds = clock() - started
    return report


# ---------------------------------------------------------------------------
# The adapters the command line wires
# ---------------------------------------------------------------------------


class UnavailableEdgePurge:
    """The edge media cache has no purge to call yet, so a run refuses up
    front rather than delete media and then be unable to purge."""

    def check_ready(self) -> None:
        raise Refusal("no edge cache purge is configured, so the run could not finish; nothing changed")

    def purge_folder(self, folder: str) -> None:
        raise RedCheck("no edge cache purge is configured")


class ScriptBackupIdentityEraser:
    """Destroys the backup identity through the repository's own erasure of it."""

    def erase(self, tenant_id: str) -> None:
        import erase_tenant_backup_identity as eb  # noqa: PLC0415 -- only a live run needs the control host's modules

        code = eb.erase(tenant=tenant_id)
        if code != eb.EXIT_OK:
            raise RedCheck(f"the backup identity is not shown gone (exit {code})")


def _secret_from_environment(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value:
        raise Refusal(f"{name} is not set; the erasure key is supplied for each run; nothing changed")
    return value


def main(argv: Sequence[str] | None = None, *, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").strip().splitlines()[0])
    parser.add_argument("--folder", required=True, help="the tenant's media folder")
    parser.add_argument("--bucket", required=True, help="the shard the folder lives in")
    parser.add_argument("--endpoint", required=True, help="the shard's object storage host")
    parser.add_argument("--region", required=True)
    parser.add_argument("--register", required=True, help="the tenant register file")
    parser.add_argument("--ledger", required=True, help="a copy of the gateway's write ledger file")
    parser.add_argument("--gateway-admin-url", required=True)
    parser.add_argument("--admin-key-file", required=True, help="the erasure job's Ed25519 private key (PEM)")
    parser.add_argument("--journal-dir", required=True, help="where the run keeps the names it has seen")
    parser.add_argument("--max-rps", type=float, default=DEFAULT_MAX_RPS)
    args = parser.parse_args(argv)
    environment = os.environ if env is None else env
    try:
        access = ShardAccess(
            bucket=args.bucket,
            endpoint=args.endpoint,
            region=args.region,
            access_key=_secret_from_environment(environment, ENV_ACCESS_KEY),
            secret_key=_secret_from_environment(environment, ENV_SECRET_KEY),
        )
        report = erase_media(
            folder=args.folder,
            bucket=args.bucket,
            register=read_register(args.register),
            admin=HttpGatewayAdmin(args.gateway_admin_url, args.admin_key_file),
            store=S3MediaStore(access),
            ledger=SqliteLedgerReader(args.ledger),
            edge=UnavailableEdgePurge(),
            backup=ScriptBackupIdentityEraser(),
            journal_dir=args.journal_dir,
            max_rps=args.max_rps,
        )
    except Refusal as exc:
        print(f"erase_tenant_media: refused: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    except (RedCheck, StoreError) as exc:
        _alert(f"{exc}; the erasure is NOT shown complete; run it again")
        return EXIT_RED
    except Exception as exc:  # noqa: BLE001 -- the class name only: a message could carry the key
        _alert(f"failed unexpectedly ({type(exc).__name__}); the erasure is NOT shown complete; run it again")
        return EXIT_RED
    _say(
        f"{report.tenant_id}: done: {report.versions_deleted} version(s) and {report.delete_markers_deleted} delete "
        f"marker(s) over {report.object_names} object name(s) in {report.rounds} round(s); "
        f"{report.requests} request(s), {report.slowdowns} slowdown retr(ies), {report.seconds:.1f} s"
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
