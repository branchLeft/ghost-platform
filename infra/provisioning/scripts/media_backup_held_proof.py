#!/usr/bin/env python3
"""Fixture-directory driver for the held-media backup proof: runs the real
`media_backup_restore` backup and restore over local directories standing in
for the live bucket, the backup bucket and a restore target, with real `age`.
It never reaches a network, a bucket or a host.
See media_backup_held_proof.md#module-overview.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import media_backup_restore  # noqa: E402
from shared_objectstorage import ObjectStorageError  # noqa: E402

IDENTITY_FILENAME = "tenant.identity"
RECIPIENT_FILENAME = "tenant.recipient"


class DirectoryObjectStore:
    """The five storage calls `media_backup_restore` makes, over directories.
    `buckets` maps the bucket name the module is called with to a directory;
    a key is the file's path under that directory."""

    def __init__(self, buckets: dict[str, pathlib.Path]) -> None:
        self._buckets = buckets

    def _path(self, bucket: str, key: str) -> pathlib.Path:
        root = self._buckets[bucket]
        if key.startswith("/") or ".." in key.split("/"):
            raise ObjectStorageError(f"refusing key {key!r}")
        return root / key

    def list_objects(self, *, bucket, endpoint, region, access_key, secret_key, prefix=None):
        del endpoint, region, access_key, secret_key
        root = self._buckets[bucket]
        keys = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
        if prefix is not None:
            keys = [key for key in keys if key.startswith(prefix)]
        return [{"key": key, "last_modified": ""} for key in keys]

    def get_object(self, *, bucket, endpoint, region, access_key, secret_key, key):
        del endpoint, region, access_key, secret_key
        path = self._path(bucket, key)
        if not path.is_file():
            raise ObjectStorageError(f"GET {bucket}/{key} failed: HTTP 404 (NoSuchKey)")
        return path.read_bytes()

    def get_object_with_content_type(self, *, bucket, endpoint, region, access_key, secret_key, key):
        data = self.get_object(
            bucket=bucket, endpoint=endpoint, region=region, access_key=access_key,
            secret_key=secret_key, key=key,
        )
        return data, mimetypes.guess_type(key)[0] or "application/octet-stream"

    def put_object(
        self, *, bucket, endpoint, region, access_key, secret_key, key, data,
        content_type="application/octet-stream", **_kw,
    ):
        del endpoint, region, access_key, secret_key, content_type
        path = self._path(bucket, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _ensure_identity(key_dir: pathlib.Path) -> tuple[pathlib.Path, str]:
    """A throwaway `age` identity for the fixture, made on first use."""
    identity = key_dir / IDENTITY_FILENAME
    recipient_file = key_dir / RECIPIENT_FILENAME
    if not identity.is_file():
        key_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
        public = subprocess.run(
            ["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True
        ).stdout.strip()
        recipient_file.write_text(public)
    return identity, recipient_file.read_text().strip()


def _store(**dirs: pathlib.Path) -> DirectoryObjectStore:
    return DirectoryObjectStore(dict(dirs))


COMMON = dict(endpoint="fixture.test", region="fixture")
KEYS = dict(access_key="fixture", secret_key="fixture")


def cmd_backup(args: argparse.Namespace) -> dict:
    _, recipient = _ensure_identity(pathlib.Path(args.key_dir))
    store = _store(live=pathlib.Path(args.live_dir), backup=pathlib.Path(args.backup_dir))
    report = media_backup_restore.backup_tenant_media(
        tenant=args.tenant,
        live_bucket="live",
        backup_bucket="backup",
        live_access_key="fixture",
        live_secret_key="fixture",
        backup_access_key="fixture",
        backup_secret_key="fixture",
        recipient=recipient,
        list_objects=store.list_objects,
        get_object_with_content_type=store.get_object_with_content_type,
        put_object=store.put_object,
        **COMMON,
    )
    return {"run_id": report.run_id, "backed_up": sorted(report.objects)}


def cmd_restore(args: argparse.Namespace) -> dict:
    restore_dir = pathlib.Path(args.restore_dir)
    if restore_dir.exists() and any(restore_dir.iterdir()):
        raise SystemExit(f"restore target {restore_dir} is not empty")
    restore_dir.mkdir(parents=True, exist_ok=True)
    identity, _ = _ensure_identity(pathlib.Path(args.key_dir))
    store = _store(backup=pathlib.Path(args.backup_dir), restore=restore_dir)
    report = media_backup_restore.restore_tenant_media(
        tenant=args.tenant,
        backup_bucket="backup",
        backup_access_key="fixture",
        backup_secret_key="fixture",
        identity_path=str(identity),
        run_id=args.run_id,
        target_bucket="restore",
        target_access_key="fixture",
        target_secret_key="fixture",
        list_objects=store.list_objects,
        get_object=store.get_object,
        put_object=store.put_object,
        **COMMON,
    )
    return {"run_id": report.run_id, "restored": sorted(report.verified_keys)}


def cmd_inspect(args: argparse.Namespace) -> dict:
    """Decrypts every ciphertext in the backup directory, manifests included,
    so a test can look for a trace in the backup itself and not only in what
    a restore chose to write."""
    identity, _ = _ensure_identity(pathlib.Path(args.key_dir))
    backup_dir = pathlib.Path(args.backup_dir)
    blobs = []
    for path in sorted(p for p in backup_dir.rglob("*") if p.is_file()):
        plaintext = media_backup_restore.decrypt_with_age(
            data=path.read_bytes(), identity_path=str(identity)
        )
        is_manifest = path.name == "manifest.json.age"
        blobs.append(
            {
                "path": path.relative_to(backup_dir).as_posix(),
                "sha256": hashlib.sha256(plaintext).hexdigest(),
                "manifest_text": plaintext.decode() if is_manifest else None,
            }
        )
    return {"blobs": blobs}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("backup", "restore", "inspect"):
        p = sub.add_parser(name)
        p.add_argument("--key-dir", required=True)
        p.add_argument("--backup-dir", required=True)
        if name != "inspect":
            p.add_argument("--tenant", required=True)
    sub.choices["backup"].add_argument("--live-dir", required=True)
    sub.choices["restore"].add_argument("--restore-dir", required=True)
    sub.choices["restore"].add_argument("--run-id")
    args = parser.parse_args(argv)
    handler = {"backup": cmd_backup, "restore": cmd_restore, "inspect": cmd_inspect}[args.command]
    try:
        result = handler(args)
    except (
        media_backup_restore.MediaBackupError,
        media_backup_restore.MediaRestoreVerificationError,
        ObjectStorageError,
    ) as error:
        print(f"media_backup_held_proof: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
