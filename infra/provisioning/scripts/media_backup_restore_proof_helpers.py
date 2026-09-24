#!/usr/bin/env python3
"""Small object-storage primitives `media-backup-restore-proof.sh` needs and
`media_backup_restore.py` deliberately does not expose -- reading one
object's digest to verify what Ghost itself wrote, corrupting a backup
object in place, counting a bucket's objects for the "genuine destroy" and
"backup skipped media" checks, and reading back the (opaque, RANDOM) backup
key or the decrypted manifest for a live key the proof uploaded -- since the
production module's own key scheme is deliberately unrelated to a live key
or its content -- a content-derived key is a fingerprint that needs no key
to recompute and so survives crypto-shredding -- the proof asks the module
for its own key rather than reimplementing the derivation.

Never imported by `media_backup_restore.py` or by anything that ships:
this is proof-only tooling, kept separate so the production module's own
surface stays exactly what the backup/restore pipeline needs and nothing a
test harness needed instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from media_backup_restore import (  # noqa: E402
    _object_key_for_backup,
    decrypt_with_age,
    find_newest_generation,
)
from shared_objectstorage import (  # noqa: E402
    ObjectStorageError,
    delete_object,
    get_object,
    list_objects,
    put_object,
)


def _common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--access-key", required=True)
    parser.add_argument("--secret-key", required=True)
    parser.add_argument("--bucket", required=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    sha_p = sub.add_parser("sha256", help="print an object's SHA-256 digest")
    _common_args(sha_p)
    sha_p.add_argument("--key", required=True)

    corrupt_p = sub.add_parser("corrupt", help="append garbage bytes to an object in place")
    _common_args(corrupt_p)
    corrupt_p.add_argument("--key", required=True)

    delete_p = sub.add_parser("delete", help="delete one object")
    _common_args(delete_p)
    delete_p.add_argument("--key", required=True)

    put_p = sub.add_parser(
        "put", help="write a raw object -- e.g. a second live object the proof itself needs to exist"
    )
    _common_args(put_p)
    put_p.add_argument("--key", required=True)
    put_p.add_argument("--body", required=True, help="the object's literal content")

    count_p = sub.add_parser("count", help="print how many objects a bucket (or prefix) holds")
    _common_args(count_p)
    count_p.add_argument("--prefix")

    list_p = sub.add_parser("list", help="print every key in a bucket (or prefix), one per line")
    _common_args(list_p)
    list_p.add_argument("--prefix")

    manifest_p = sub.add_parser(
        "manifest", help="decrypt and print one tenant's NEWEST generation's manifest as JSON"
    )
    manifest_p.add_argument("--endpoint", required=True)
    manifest_p.add_argument("--region", required=True)
    manifest_p.add_argument("--access-key", required=True)
    manifest_p.add_argument("--secret-key", required=True)
    manifest_p.add_argument("--bucket", required=True)
    manifest_p.add_argument("--tenant", required=True)
    manifest_p.add_argument("--identity-file", required=True)

    run_id_p = sub.add_parser(
        "current-run-id", help="print one tenant's NEWEST generation's run id"
    )
    _common_args(run_id_p)
    run_id_p.add_argument("--tenant", required=True)

    backup_key_p = sub.add_parser(
        "backup-object-key",
        help="print the backup bucket key for a live object, given its run id and backup_id "
        "(both from `manifest` / `current-run-id`)",
    )
    backup_key_p.add_argument("--tenant", required=True)
    backup_key_p.add_argument("--run-id", required=True)
    backup_key_p.add_argument("--backup-id", required=True)

    objects_prefix_p = sub.add_parser(
        "objects-prefix",
        help="print one tenant's generation's objects/ prefix, given its run id",
    )
    objects_prefix_p.add_argument("--tenant", required=True)
    objects_prefix_p.add_argument("--run-id", required=True)

    args = parser.parse_args(argv)
    # Built lazily, per command: `backup-object-key` / `objects-prefix` are
    # pure local computation with none of these flags, so building this
    # unconditionally from `args` would crash on those commands alone.
    needs_bucket_args = args.command in (
        "sha256", "corrupt", "delete", "count", "list", "put", "manifest", "current-run-id",
    )
    common = (
        dict(
            endpoint=args.endpoint, region=args.region, access_key=args.access_key,
            secret_key=args.secret_key, bucket=args.bucket,
        )
        if needs_bucket_args
        else {}
    )

    def _newest_generation(tenant: str):
        kwargs = dict(common)
        kwargs["backup_bucket"] = kwargs.pop("bucket")
        found = find_newest_generation(tenant=tenant, list_objects=list_objects, **kwargs)
        if found is None:
            raise ObjectStorageError(f"no generation with a manifest exists yet for tenant {tenant!r}")
        return found  # (run_id, manifest_key)

    try:
        if args.command == "sha256":
            data = get_object(key=args.key, **common)
            print(hashlib.sha256(data).hexdigest())
        elif args.command == "corrupt":
            data = get_object(key=args.key, **common)
            put_object(key=args.key, data=data + b"\x00CORRUPTED-BY-PROOF-SABOTAGE\x00", **common)
        elif args.command == "delete":
            delete_object(key=args.key, **common)
        elif args.command == "put":
            put_object(key=args.key, data=args.body.encode(), **common)
        elif args.command == "count":
            objects = list_objects(prefix=args.prefix, **common)
            print(len(objects))
        elif args.command == "list":
            for entry in list_objects(prefix=args.prefix, **common):
                print(entry["key"])
        elif args.command == "current-run-id":
            run_id, _manifest_key = _newest_generation(args.tenant)
            print(run_id)
        elif args.command == "manifest":
            _run_id, manifest_key = _newest_generation(args.tenant)
            ciphertext = get_object(
                bucket=args.bucket, endpoint=args.endpoint, region=args.region,
                access_key=args.access_key, secret_key=args.secret_key,
                key=manifest_key,
            )
            manifest = json.loads(
                decrypt_with_age(data=ciphertext, identity_path=args.identity_file)
            )
            print(json.dumps(manifest, indent=2, sort_keys=True))
        elif args.command == "backup-object-key":
            print(_object_key_for_backup(args.tenant, args.run_id, args.backup_id))
        elif args.command == "objects-prefix":
            print(f"media/{args.tenant}/generations/{args.run_id}/objects/")
    except ObjectStorageError as error:
        print(f"media-backup-restore-proof-helpers: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
