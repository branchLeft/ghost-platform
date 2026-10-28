#!/usr/bin/env python3
"""Erases one tenant's backup identity from the control host: destroys every
copy of the tenant's private age key (the identity file, its temp leftover, any
other file in the identity directory that holds the same key, and every
version of the wrapped spare in the private bucket), takes the tenant off the
two lists, then reads every location back and exits non-zero while any copy
remains. Run as root, fail closed. It deletes the wrapped spare and never reads
or unwraps it, so it needs no wrapping key. See erase_tenant_backup_identity.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import functools
import os
import pathlib
import stat
import sys
import xml.etree.ElementTree as ET
from collections.abc import Callable, Sequence
from typing import Protocol

import backup_recipients as br
import backup_worker as bw
import enrol_tenant_backup as et
import restore_drill as rd
import shared_objectstorage

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_USAGE = 2
EXIT_PROOF_RED = 3

DEFAULT_ERASE_CONFIG = "/etc/branchleft/erase-tenant-backup.env"

ERASE_ENV_PREFIX = "ERASE_BACKUP_SPARE_"
ERASE_REQUIRED_NAMES = tuple(
    ERASE_ENV_PREFIX + suffix for suffix in ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
)

# An identity file is a few hundred bytes; anything larger is not one, and is
# reported rather than read.
MAX_ENTRY_BYTES = 64 * 1024
MAX_VERSION_PAGES = 1000

_PUBLIC_KEY_COMMENT_PREFIX = b"# public key: "


def _say(message: str) -> None:
    print(f"erase_tenant_backup_identity: {message}")


def _alert(message: str) -> None:
    print(f"erase_tenant_backup_identity: ALERT: {message}", file=sys.stderr)


@dataclasses.dataclass(frozen=True)
class EraseConfig:
    bucket: str
    endpoint: str
    region: str
    access_key: str = dataclasses.field(repr=False)
    secret_key: str = dataclasses.field(repr=False)


@dataclasses.dataclass(frozen=True)
class ObjectVersion:
    key: str
    version_id: str
    kind: str  # "version" or "delete_marker"


class EraseStore(Protocol):
    """The spare bucket as erasure sees it: list and delete, nothing else.
    There is deliberately no get or put, so no code path can read a spare."""

    def list_keys(self, prefix: str) -> list[str]: ...

    def list_versions(self, prefix: str) -> list[ObjectVersion]: ...

    def delete_version(self, version: ObjectVersion) -> None: ...


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


class S3EraseStore(et.S3SpareStore):
    """The spare bucket through the repository's one SigV4 implementation,
    with the two version calls erasure needs added."""

    def put(self, key: str, data: bytes) -> None:
        raise NotImplementedError("erasure never writes the spare bucket")

    def get(self, key: str) -> bytes:
        raise NotImplementedError("erasure never reads a spare")

    def list_keys(self, prefix: str) -> list[str]:
        return [entry["key"] for entry in self._s3.list_objects(prefix=prefix, **self._creds())]

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
            status, body = self._s3.signed_request(method="GET", query=query, **self._creds())
            if not 200 <= status < 300:
                raise shared_objectstorage.ObjectStorageError(f"listing the versions failed: HTTP {status}")
            truncated = False
            next_key: str | None = None
            next_version: str | None = None
            for child in ET.fromstring(body):
                name = _local(child.tag)
                if name in ("Version", "DeleteMarker"):
                    fields = {_local(part.tag): (part.text or "") for part in child}
                    if not fields.get("Key"):
                        raise shared_objectstorage.ObjectStorageError("a version entry has no key")
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
                raise shared_objectstorage.ObjectStorageError("the version listing is truncated with no marker to resume")
            key_marker, version_marker = next_key, next_version
        raise shared_objectstorage.ObjectStorageError("the version listing did not end")

    def delete_version(self, version: ObjectVersion) -> None:
        if not version.version_id:
            self._s3.delete_object(key=version.key, **self._creds())
            return
        status, _ = self._s3.signed_request(
            method="DELETE", key=version.key, query={"versionId": version.version_id}, **self._creds()
        )
        if status != 404 and not 200 <= status < 300:
            raise shared_objectstorage.ObjectStorageError(f"deleting a version failed: HTTP {status}")


def spare_prefix(tenant: str) -> str:
    """Slugs hold no dot, so `spares/a.` can never match the objects of `a-b`."""
    return f"{et.SPARE_KEY_PREFIX}{tenant}."


def load_erase_config(path: str, *, owner_uid: int) -> EraseConfig:
    values = et.read_env_file(path, owner_uid=owner_uid, what="the erase configuration")
    missing = [name for name in ERASE_REQUIRED_NAMES if not values.get(name)]
    if missing:
        raise et.Refusal(f"the erase configuration does not set {', '.join(missing)}; nothing changed")
    return EraseConfig(
        bucket=values[ERASE_ENV_PREFIX + "BUCKET"],
        endpoint=values[ERASE_ENV_PREFIX + "ENDPOINT"],
        region=values[ERASE_ENV_PREFIX + "REGION"],
        access_key=values[ERASE_ENV_PREFIX + "ACCESS_KEY_ID"],
        secret_key=values[ERASE_ENV_PREFIX + "SECRET_ACCESS_KEY"],
    )


# ---------------------------------------------------------------------------
# Finding the copies
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class KeyMatchers:
    """What a stray copy of the tenant's identity contains. Held in memory only."""

    secret_lines: frozenset[bytes] = dataclasses.field(repr=False)
    public_keys: frozenset[bytes]

    @property
    def empty(self) -> bool:
        return not self.secret_lines and not self.public_keys

    def holds(self, data: bytes) -> bool:
        if any(line in data for line in self.secret_lines):
            return True
        return any(_PUBLIC_KEY_COMMENT_PREFIX + key in data for key in self.public_keys)


def key_matchers(identity: bytes | None, recipient: str | None) -> KeyMatchers:
    secrets = set(et._SECRET_KEY_LINE.findall(identity or b""))
    publics = set(et._PUBLIC_KEY_COMMENT.findall(identity or b""))
    if recipient:
        publics.add(recipient.encode("utf-8"))
    return KeyMatchers(frozenset(secrets), frozenset(publics))


def learn_matchers(tenant: str, paths: et.Paths) -> KeyMatchers:
    """Reads the canonical identity before anything is destroyed, and the
    tenant's recipient from the recipients file. Neither being readable stops
    nothing: erasure then matches on file name alone, and says so."""
    try:
        _, identity = et._read_regular_file(et.identity_path(paths.identity_dir, tenant), what="the identity file")
    except (et.Refusal, OSError):
        identity = None
    try:
        recipient = br.load_recipients(paths.recipients_file).get(tenant)
    except (br.RecipientError, OSError):
        recipient = None
    return key_matchers(identity, recipient)


@dataclasses.dataclass(frozen=True)
class Scan:
    holders: tuple[str, ...]
    unchecked: tuple[str, ...]


def scan_identity_dir(identity_dir: str, tenant: str, matchers: KeyMatchers) -> Scan:
    """Every entry that is the tenant's own file or holds the tenant's key, and
    every entry that could not be judged. A symlink under another name is not a
    copy of the bytes and is left alone."""
    own = {
        os.path.basename(et.identity_path(identity_dir, tenant)),
        os.path.basename(et.identity_tmp_path(identity_dir, tenant)),
    }
    holders: list[str] = []
    unchecked: list[str] = []
    try:
        with os.scandir(identity_dir) as entries:
            names = sorted(entry.name for entry in entries)
    except OSError as exc:
        return Scan((), (f"the identity directory cannot be read ({type(exc).__name__})",))
    for name in names:
        if name in own:
            holders.append(name)
            continue
        path = os.path.join(identity_dir, name)
        try:
            info = os.lstat(path)
        except OSError:
            unchecked.append(f"identity directory entry {name} cannot be examined")
            continue
        if stat.S_ISLNK(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            unchecked.append(f"identity directory entry {name} is not a regular file and cannot be checked")
            continue
        if info.st_size > MAX_ENTRY_BYTES:
            unchecked.append(f"identity directory entry {name} is too large to check")
            continue
        try:
            _, data = et._read_regular_file(path, what="an identity directory entry")
        except (et.Refusal, OSError):
            unchecked.append(f"identity directory entry {name} cannot be read")
            continue
        if matchers.holds(data):
            holders.append(name)
    return Scan(tuple(holders), tuple(unchecked))


def _describe(version: ObjectVersion) -> str:
    return f"spare {version.kind.replace('_', ' ')} {version.key} (version {version.version_id or 'unversioned'})"


def find_remaining(*, tenant: str, paths: et.Paths, store: EraseStore, matchers: KeyMatchers) -> list[str]:
    """The proof. A fresh read of every location from its own source; each
    line names a copy that remains or a location that could not be read. An
    empty list is the only success. Never returns or prints key bytes."""
    found: list[str] = []

    scan = scan_identity_dir(paths.identity_dir, tenant, matchers)
    found += [f"identity directory entry {name}" for name in scan.holders]
    found += list(scan.unchecked)

    prefix = spare_prefix(tenant)
    try:
        keys = [key for key in store.list_keys(prefix) if key.startswith(prefix)]
    except Exception as exc:  # noqa: BLE001 -- an unreadable location is RED, whatever the cause
        found.append(f"the spare bucket cannot be listed ({type(exc).__name__}); it is not shown to be empty")
    else:
        found += [f"spare object {key}" for key in keys]
    try:
        versions = [version for version in store.list_versions(prefix) if version.key.startswith(prefix)]
    except Exception as exc:  # noqa: BLE001
        found.append(f"the spare versions cannot be listed ({type(exc).__name__}); they are not shown to be gone")
    else:
        found += [_describe(version) for version in versions]

    try:
        listed = et.tenant_names(et.snapshot(paths.tenants_file, what="the tenants file").data)
    except Exception as exc:  # noqa: BLE001
        found.append(f"the tenants file cannot be read ({type(exc).__name__})")
    else:
        if tenant in listed:
            found.append("the tenants file still lists the tenant")
    try:
        recipients = br.load_recipients(paths.recipients_file)
    except Exception as exc:  # noqa: BLE001
        found.append(f"the recipients file cannot be read or parsed ({type(exc).__name__})")
    else:
        if tenant in recipients:
            found.append("the recipients file still lists the tenant")
    return found


# ---------------------------------------------------------------------------
# Destroying the copies
# ---------------------------------------------------------------------------


def destroy_identity_entry(identity_dir: str, name: str) -> None:
    """A symlink is unlinked and never written through; a regular file is
    zero-filled, synced and unlinked by the restore drill's own shred."""
    path = os.path.join(identity_dir, name)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode):
        os.unlink(path)
    elif stat.S_ISREG(info.st_mode):
        rd._destroy_file(pathlib.Path(path))
    else:
        raise IsADirectoryError("not a regular file")


def _attempt(problems: list[str], what: str, action: Callable[[], object]) -> bool:
    """Every destroy step is tried even when an earlier one failed; a failure
    is named by class only, since a message could carry key material."""
    try:
        action()
    except Exception as exc:  # noqa: BLE001
        problems.append(f"{what} failed ({type(exc).__name__})")
        return False
    return True


def destroy_copies(*, tenant: str, paths: et.Paths, store: EraseStore, matchers: KeyMatchers) -> list[str]:
    problems: list[str] = []
    problems += et.retract_listing(paths, tenant)

    scan = scan_identity_dir(paths.identity_dir, tenant, matchers)
    for name in scan.holders:
        destroy = functools.partial(destroy_identity_entry, paths.identity_dir, name)
        if _attempt(problems, f"destroying identity directory entry {name}", destroy):
            _say(f"identity directory entry {name}: destroyed")
    _attempt(problems, "syncing the identity directory", functools.partial(et._fsync_directory, paths.identity_dir))

    prefix = spare_prefix(tenant)
    try:
        versions = [version for version in store.list_versions(prefix) if version.key.startswith(prefix)]
    except Exception as exc:  # noqa: BLE001
        problems.append(f"listing the spare versions failed ({type(exc).__name__})")
        versions = []
    for version in versions:
        if _attempt(problems, f"deleting {_describe(version)}", functools.partial(store.delete_version, version)):
            _say(f"{_describe(version)}: deleted")
    return problems


# ---------------------------------------------------------------------------
# The erasure
# ---------------------------------------------------------------------------


class _Progress:
    """Whether anything has been changed yet, so a late failure is reported as
    a possibly surviving key rather than as 'nothing changed'."""

    began = False


def _erase(
    *,
    tenant: str,
    erase_config: str,
    paths: et.Paths,
    euid: int,
    owner_uid: int,
    store: EraseStore | None,
    progress: _Progress,
) -> int:
    if euid != 0:
        raise et.Refusal("must run as root; nothing changed")
    try:
        bw.validate_tenant_name(tenant)
    except bw.InvalidTenantName as exc:
        raise et.Refusal(f"{exc}; nothing changed") from None

    with et._EnrolLock(paths.lock_path):
        config = load_erase_config(erase_config, owner_uid=owner_uid)
        worker_env = et.read_env_file(paths.worker_env, owner_uid=owner_uid, what="the worker environment")
        drill_env = et.read_env_file(paths.drill_env, owner_uid=owner_uid, what="the restore drill environment")
        try:
            copies = rd.copies_from_env(drill_env)
        except rd.DrillConfigError as exc:
            raise et.Refusal(f"{exc}; nothing changed") from None
        et.check_identity_dir(paths.identity_dir, owner_uid=owner_uid)
        dump_copies = et.worker_copy_identities(worker_env)
        dump_copies += [et.CopyIdentity(f"drill {copy.name}", copy.bucket, copy.access_key) for copy in copies]
        et.refuse_if_spare_is_a_dump_copy(config, dump_copies)

        spare_store = store if store is not None else S3EraseStore(config)
        matchers = learn_matchers(tenant, paths)
        if matchers.empty:
            _say("no key material could be read to match on: stray copies are found by file name only")

        if not find_remaining(tenant=tenant, paths=paths, store=spare_store, matchers=matchers):
            _say(f"{tenant}: no copy of its backup identity was present; nothing to erase")
            return EXIT_OK

        progress.began = True
        problems = destroy_copies(tenant=tenant, paths=paths, store=spare_store, matchers=matchers)
        remaining = find_remaining(tenant=tenant, paths=paths, store=spare_store, matchers=matchers)
        if remaining:
            for line in remaining:
                _alert(f"{tenant}: {line}")
            for line in problems:
                _alert(f"{tenant}: {line}")
            _alert(f"{tenant}: the erasure proof is RED; the tenant's backup identity is not shown to be gone")
            return EXIT_PROOF_RED
        for line in problems:
            _say(f"{tenant}: note: {line}, but the read-back below found nothing")
        _say(
            f"{tenant}: proof green: the identity directory, the spare bucket (objects and versions) "
            "and both lists were read back and hold no copy"
        )
        return EXIT_OK


def erase(
    *,
    tenant: str,
    erase_config: str = DEFAULT_ERASE_CONFIG,
    paths: et.Paths | None = None,
    euid: int | None = None,
    owner_uid: int = 0,
    store: EraseStore | None = None,
) -> int:
    """The whole erasure; returns the exit code. The keyword arguments after
    `paths` are the seams CI uses to run it without root or a bucket."""
    progress = _Progress()
    try:
        return _erase(
            tenant=tenant,
            erase_config=erase_config,
            paths=paths or et.Paths(),
            euid=os.geteuid() if euid is None else euid,
            owner_uid=owner_uid,
            store=store,
            progress=progress,
        )
    except et.Refusal as exc:
        print(f"erase_tenant_backup_identity: refused: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    except Exception as exc:  # noqa: BLE001 -- the class name only: a message could carry key material
        if progress.began:
            _alert(f"failed unexpectedly ({type(exc).__name__}) after erasure began; a copy may remain, run it again")
            return EXIT_PROOF_RED
        print(
            f"erase_tenant_backup_identity: failed unexpectedly ({type(exc).__name__}); nothing changed",
            file=sys.stderr,
        )
        return EXIT_REFUSED


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", required=True, help="the tenant slug")
    parser.add_argument("--erase-config", default=DEFAULT_ERASE_CONFIG)
    parser.add_argument("--worker-env-file", default=et.DEFAULT_WORKER_ENV)
    parser.add_argument("--drill-env-file", default=et.DEFAULT_DRILL_ENV)
    parser.add_argument("--tenants-file", default=et.DEFAULT_TENANTS_FILE)
    parser.add_argument("--recipients-file", default=et.DEFAULT_RECIPIENTS_FILE)
    parser.add_argument("--identity-dir", default=et.DEFAULT_IDENTITY_DIR)
    parser.add_argument("--lock-path", default=et.DEFAULT_LOCK_PATH)
    args = parser.parse_args(argv)
    paths = et.Paths(
        worker_env=args.worker_env_file,
        drill_env=args.drill_env_file,
        tenants_file=args.tenants_file,
        recipients_file=args.recipients_file,
        identity_dir=args.identity_dir,
        lock_path=args.lock_path,
    )
    return erase(tenant=args.tenant, erase_config=args.erase_config, paths=paths)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
