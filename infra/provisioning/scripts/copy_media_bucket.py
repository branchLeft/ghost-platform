#!/usr/bin/python3 -I
"""Copy every object from one Object Storage bucket to another, read-only on the source.

The source is reached only through ReadOnlyBucket, which has list and read
methods and no write or delete method, so the copy path cannot put or delete
there. Destination writes are put-only, and each copied object is read back
and checked by SHA-256 before it counts. Credentials come from the
environment, never argv. See copy_media_bucket.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import os
import pathlib
import sys
import time
from collections.abc import Callable, Sequence
from typing import Protocol

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from shared_objectstorage import (
    ObjectStorageError,
    get_object,
    list_objects,
    put_object,
)

SOURCE_KEY_ENV = "COPY_SOURCE_ACCESS_KEY_ID"
SOURCE_SECRET_ENV = "COPY_SOURCE_SECRET_ACCESS_KEY"
DEST_KEY_ENV = "COPY_DEST_ACCESS_KEY_ID"
DEST_SECRET_ENV = "COPY_DEST_SECRET_ACCESS_KEY"


class CopyConfigError(Exception):
    """The copy was asked for something it refuses before it reads a byte."""


class CopyError(Exception):
    """A copied object did not match its source, or the destination holds a different object."""


class SourceStore(Protocol):
    """What the copy may do to the source: list and read. Nothing else is declared."""

    def list_keys(self, prefix: str | None) -> list[str]: ...

    def read(self, key: str) -> bytes: ...


class DestinationStore(Protocol):
    def list_keys(self, prefix: str | None) -> list[str]: ...

    def read(self, key: str) -> bytes: ...

    def write(self, key: str, data: bytes) -> None: ...


@dataclasses.dataclass(frozen=True)
class BucketAddress:
    bucket: str
    endpoint: str
    region: str
    access_key: str = dataclasses.field(repr=False)
    secret_key: str = dataclasses.field(repr=False)


class ReadOnlyBucket:
    """A bucket reached for list and get only. This class has no write or delete method."""

    def __init__(self, address: BucketAddress) -> None:
        self._address = address

    def list_keys(self, prefix: str | None) -> list[str]:
        entries = list_objects(
            bucket=self._address.bucket,
            endpoint=self._address.endpoint,
            region=self._address.region,
            access_key=self._address.access_key,
            secret_key=self._address.secret_key,
            prefix=prefix,
        )
        return [entry["key"] for entry in entries]

    def read(self, key: str) -> bytes:
        data: bytes = get_object(
            bucket=self._address.bucket,
            endpoint=self._address.endpoint,
            region=self._address.region,
            access_key=self._address.access_key,
            secret_key=self._address.secret_key,
            key=key,
        )
        return data


class WritableBucket(ReadOnlyBucket):
    """The destination: the same list and read, plus put. It has no delete method."""

    def write(self, key: str, data: bytes) -> None:
        put_object(
            bucket=self._address.bucket,
            endpoint=self._address.endpoint,
            region=self._address.region,
            access_key=self._address.access_key,
            secret_key=self._address.secret_key,
            key=key,
            data=data,
        )


@dataclasses.dataclass(frozen=True)
class CopyReport:
    listed: int
    copied: int
    skipped_identical: int
    total_bytes: int
    duration_seconds: float


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def copy_bucket(
    source: SourceStore,
    destination: DestinationStore,
    *,
    prefix: str | None,
    clock: Callable[[], float] = time.monotonic,
) -> CopyReport:
    """Copies every listed source object to the destination, verifying each by SHA-256.

    An object the destination already holds with identical bytes is skipped, so a
    re-run after a dropped connection is safe. A destination object that differs
    is refused, never overwritten.
    """
    started = clock()
    keys = sorted(source.list_keys(prefix))
    already_there = set(destination.list_keys(prefix))
    copied = 0
    skipped = 0
    total = 0
    for key in keys:
        data = source.read(key)
        digest = sha256_hex(data)
        if key in already_there:
            if sha256_hex(destination.read(key)) != digest:
                raise CopyError(
                    "the destination already holds a different object at one listed key; "
                    "refusing to overwrite it"
                )
            skipped += 1
        else:
            destination.write(key, data)
            if sha256_hex(destination.read(key)) != digest:
                raise CopyError(
                    "a copied object does not match its source checksum after read-back"
                )
            copied += 1
        total += len(data)
    return CopyReport(
        listed=len(keys),
        copied=copied,
        skipped_identical=skipped,
        total_bytes=total,
        duration_seconds=clock() - started,
    )


def refuse_same_bucket(source: BucketAddress, destination: BucketAddress) -> None:
    if (source.endpoint, source.bucket) == (destination.endpoint, destination.bucket):
        raise CopyConfigError(
            "the source and the destination are the same bucket; refusing"
        )


def _env(name: str) -> str:
    value = os.environ.get(name, "")
    if value == "":
        raise CopyConfigError(f"the environment variable {name} is not set")
    return value


def format_report(report: CopyReport) -> str:
    return (
        f"listed {report.listed} objects; copied {report.copied}; "
        f"already identical {report.skipped_identical}; "
        f"total {report.total_bytes} bytes; copy duration {report.duration_seconds:.1f} s"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-bucket", required=True)
    parser.add_argument(
        "--source-endpoint",
        required=True,
        help="a host, e.g. hel1.your-objectstorage.com",
    )
    parser.add_argument("--source-region", required=True)
    parser.add_argument("--dest-bucket", required=True)
    parser.add_argument(
        "--dest-endpoint",
        required=True,
        help="a host, e.g. fsn1.your-objectstorage.com",
    )
    parser.add_argument("--dest-region", required=True)
    parser.add_argument(
        "--prefix", default=None, help="copy only keys under this prefix"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        source = BucketAddress(
            bucket=args.source_bucket,
            endpoint=args.source_endpoint,
            region=args.source_region,
            access_key=_env(SOURCE_KEY_ENV),
            secret_key=_env(SOURCE_SECRET_ENV),
        )
        destination = BucketAddress(
            bucket=args.dest_bucket,
            endpoint=args.dest_endpoint,
            region=args.dest_region,
            access_key=_env(DEST_KEY_ENV),
            secret_key=_env(DEST_SECRET_ENV),
        )
        refuse_same_bucket(source, destination)
        report = copy_bucket(
            ReadOnlyBucket(source), WritableBucket(destination), prefix=args.prefix
        )
    except (CopyConfigError, CopyError, ObjectStorageError) as error:
        print(f"copy_media_bucket: {error}", file=sys.stderr)
        return 1
    print(format_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
