#!/usr/bin/env python3
"""Nightly copy of the two Pulumi state buckets into backup copy 1, and the
restore that proves a copy. See state_copy.md."""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import hashlib
import io
import json
import os
import pathlib
import re
import sys
import tarfile
import tempfile
import time
from collections.abc import Callable, Mapping

import shared_objectstorage as so
from media_backup_restore import (
    MediaBackupError,
    MediaRestoreVerificationError,
    count_age_recipient_stanzas,
    decrypt_with_age,
    encrypt_with_age,
    generate_run_id,
)

LABELS = ("estate", "tenant")
STATE_PREFIX = "state"
GENERATIONS = "generations"
TAR_NAME = "state.tar.age"
MANIFEST_NAME = "manifest.json.age"
# A Pulumi file backend always holds stacks under this path. A listing with
# none of it is a wrong bucket, a wrong key scope or an outage, never a
# healthy empty state.
STACKS_MARKER = ".pulumi/stacks/"
# The ciphertext is built in memory; state is kilobytes, so a bucket past
# this is not state and the run fails loudly.
MAX_TOTAL_BYTES = 256 * 1024 * 1024

DEFAULT_METRICS_DIR = "/var/lib/branchleft/backup-worker-exporter"
METRICS_FILENAME = "state_copy.prom"
M_SUCCESS = "state_copy_last_success_timestamp_seconds"
M_CONFIGURED = "state_copy_bucket_configured"
M_OBJECTS = "state_copy_last_object_count"
M_BYTES = "state_copy_last_bytes"

_RECIPIENT = re.compile(r"\Aage1[0-9a-z]{50,100}\Z")
_RUN_ID = re.compile(r"\A[0-9]{8}T[0-9]{12}Z-[0-9a-f]{16}\Z")


class StateCopyError(Exception):
    """One bucket's copy did not complete."""


class ConfigError(Exception):
    """The configuration is unusable; nothing was attempted."""


@dataclasses.dataclass(frozen=True)
class Target:
    bucket: str
    endpoint: str
    region: str
    access_key: str
    secret_key: str


def _target(env: Mapping[str, str], prefix: str) -> Target:
    names = ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
    values = {n: env.get(f"{prefix}_{n}", "") for n in names}
    missing = [f"{prefix}_{n}" for n, v in values.items() if not v]
    if missing:
        raise ConfigError(f"missing {', '.join(missing)}")
    return Target(values["BUCKET"], values["ENDPOINT"], values["REGION"],
                  values["ACCESS_KEY_ID"], values["SECRET_ACCESS_KEY"])


@dataclasses.dataclass(frozen=True)
class Config:
    recipient: str
    dest: Target
    sources: dict[str, Target]


def parse_env_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"\A([A-Za-z_][A-Za-z0-9_]*)=(.*)\Z", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def load_config(env: Mapping[str, str]) -> Config:
    """Every copy is configured or the run is refused: a half-configured
    bucket is a typo or a half-finished rollout, never a choice. The source
    key is whatever key the file names; the code needs only get and list."""
    recipient = env.get("STATE_COPY_RECIPIENT", "")
    if not _RECIPIENT.match(recipient):
        raise ConfigError("STATE_COPY_RECIPIENT is not a single age1 recipient")
    dest = _target(env, "STATE_COPY_DEST")
    sources = {label: _target(env, f"STATE_COPY_{label.upper()}") for label in LABELS}
    if len({(t.endpoint, t.bucket) for t in [dest, *sources.values()]}) != 3:
        raise ConfigError("source and destination buckets must be three different buckets")
    return Config(recipient, dest, sources)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _kw(t: Target) -> dict:
    return dict(bucket=t.bucket, endpoint=t.endpoint, region=t.region,
                access_key=t.access_key, secret_key=t.secret_key)


def pack(objects: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for key in sorted(objects):
            info = tarfile.TarInfo(name=key)
            info.size = len(objects[key])
            info.mtime = 0
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(objects[key]))
    return buf.getvalue()


def copy_bucket(
    label: str,
    cfg: Config,
    *,
    lister=so.list_objects,
    getter=so.get_object,
    putter=so.put_object,
    run_id: str | None = None,
) -> dict:
    """Pull every current object of one state bucket, encrypt to the single
    estate recipient, put the tar and then the manifest (the completion
    marker) to copy 1. Returns the counts. Raises StateCopyError."""
    src = cfg.sources[label]
    try:
        listing = lister(**_kw(src))
        keys = sorted(item["key"] for item in listing)
        if not any(STACKS_MARKER in k for k in keys):
            raise StateCopyError(
                f"{label}: the listing holds no {STACKS_MARKER} object ({len(keys)} keys); "
                "refusing to write an empty-looking copy"
            )
        objects = {k: getter(key=k, **_kw(src)) for k in keys}
    except so.ObjectStorageError as exc:
        raise StateCopyError(f"{label}: reading the source failed: {exc}") from exc
    total = sum(len(v) for v in objects.values())
    if total > MAX_TOTAL_BYTES:
        raise StateCopyError(f"{label}: {total} bytes is past the {MAX_TOTAL_BYTES} bound")
    run_id = run_id or generate_run_id()
    tar_bytes = pack(objects)
    manifest = {
        "label": label, "run_id": run_id, "object_count": len(objects), "bytes": total,
        "tar_sha256": _sha(tar_bytes),
        "objects": [{"key": k, "size": len(v), "sha256": _sha(v)} for k, v in sorted(objects.items())],
    }
    try:
        sealed = {
            TAR_NAME: encrypt_with_age(data=tar_bytes, recipient=cfg.recipient),
            MANIFEST_NAME: encrypt_with_age(data=json.dumps(manifest).encode(), recipient=cfg.recipient),
        }
    except MediaBackupError as exc:
        raise StateCopyError(f"{label}: {exc}") from exc
    for name, blob in sealed.items():
        if count_age_recipient_stanzas(blob) != 1:
            raise StateCopyError(f"{label}: {name} does not carry exactly one recipient")
    base = f"{STATE_PREFIX}/{label}/{GENERATIONS}/{run_id}"
    try:
        # Manifest last: a generation without one is incomplete.
        for name in (TAR_NAME, MANIFEST_NAME):
            putter(key=f"{base}/{name}", data=sealed[name], **_kw(cfg.dest))
    except so.ObjectStorageError as exc:
        raise StateCopyError(f"{label}: writing copy 1 failed: {exc}") from exc
    return {"objects": len(objects), "bytes": total, "run_id": run_id}


def render_metrics(state: dict[str, dict[str, float]]) -> str:
    lines = []
    for name, help_ in (
        (M_CONFIGURED, "1 for each state bucket this job is configured to copy."),
        (M_SUCCESS, "Unix time of the last verified copy of this state bucket into copy 1."),
        (M_OBJECTS, "Objects in the last successful copy."),
        (M_BYTES, "Plaintext bytes in the last successful copy."),
    ):
        lines += [f"# HELP {name} {help_}", f"# TYPE {name} gauge"]
        for label in sorted(state):
            if name in state[label]:
                lines.append(f'{name}{{bucket="{label}"}} {state[label][name]}')
    return "\n".join(lines) + "\n"


_LINE = re.compile(r'\A(state_copy_[a-z_]+)\{bucket="([a-z]+)"\}\s+([0-9.]+)\Z')


def record_metrics(metrics_dir: str, updates: dict[str, dict[str, float]]) -> None:
    """Merge `updates` into the textfile, keeping every bucket this run did
    not touch: a failed bucket keeps its old success time and so goes stale."""
    directory = pathlib.Path(metrics_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / METRICS_FILENAME
    state: dict[str, dict[str, float]] = {}
    try:
        for line in path.read_text().splitlines():
            m = _LINE.match(line.strip())
            if m:
                state.setdefault(m.group(2), {})[m.group(1)] = float(m.group(3))
    except FileNotFoundError:
        pass
    for label, values in updates.items():
        state.setdefault(label, {}).update(values)
    fd, tmp = tempfile.mkstemp(dir=str(directory), prefix=METRICS_FILENAME + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(render_metrics(state))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def run_copy(cfg: Config, metrics_dir: str, *, now: Callable[[], float] = time.time, **hooks) -> int:
    """Every bucket is attempted; any failure makes the exit 1. The
    `configured` gauge is written first so a bucket that has never
    succeeded is still visible to the alert."""
    record_metrics(metrics_dir, {label: {M_CONFIGURED: 1.0} for label in cfg.sources})
    failed = 0
    for label in cfg.sources:
        try:
            result = copy_bucket(label, cfg, **hooks)
        except StateCopyError as exc:
            print(f"state_copy: ALERT {exc}", file=sys.stderr)
            failed += 1
            continue
        record_metrics(metrics_dir, {label: {M_SUCCESS: now(), M_OBJECTS: float(result["objects"]),
                                             M_BYTES: float(result["bytes"])}})
        print(f"state_copy: {label}: {result['objects']} objects, {result['bytes']} bytes, run {result['run_id']}")
    return 1 if failed else 0


def _safe_target(root: pathlib.Path, name: str) -> pathlib.Path:
    path = (root / name).resolve()
    if name.startswith("/") or root.resolve() not in path.parents:
        raise MediaRestoreVerificationError(f"unsafe object name in the copy: {name!r}")
    return path


def restore(
    label: str,
    cfg: Config,
    *,
    identity_path: str,
    into: pathlib.Path,
    run_id: str | None = None,
    lister=so.list_objects,
    getter=so.get_object,
) -> dict:
    """Decrypt the newest complete generation (or `run_id`), verify every
    digest, and write the objects under `into`, which must be empty."""
    if into.exists() and any(into.iterdir()):
        raise MediaRestoreVerificationError(f"{into} is not empty")
    prefix = f"{STATE_PREFIX}/{label}/{GENERATIONS}/"
    keys = [i["key"] for i in lister(prefix=prefix, **_kw(cfg.dest))]
    ids = sorted(
        k.split("/")[3] for k in keys
        if k.endswith("/" + MANIFEST_NAME) and _RUN_ID.match(k.split("/")[3])
    )
    if run_id is not None:
        if run_id not in ids:
            raise MediaRestoreVerificationError(f"no complete generation {run_id}")
    elif not ids:
        raise MediaRestoreVerificationError(f"{label}: no complete generation in copy 1")
    chosen = run_id or ids[-1]
    base = f"{prefix}{chosen}/"
    manifest = json.loads(decrypt_with_age(data=getter(key=base + MANIFEST_NAME, **_kw(cfg.dest)),
                                           identity_path=identity_path))
    tar_bytes = decrypt_with_age(data=getter(key=base + TAR_NAME, **_kw(cfg.dest)),
                                 identity_path=identity_path)
    if _sha(tar_bytes) != manifest["tar_sha256"]:
        raise MediaRestoreVerificationError("the tar does not match the manifest digest")
    if manifest["object_count"] < 1:
        raise MediaRestoreVerificationError("the manifest records no objects")
    expected = {o["key"]: o for o in manifest["objects"]}
    into.mkdir(parents=True, exist_ok=True)
    seen = 0
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r") as tar:
        for member in tar.getmembers():
            data = tar.extractfile(member).read() if member.isfile() else b""
            entry = expected.get(member.name)
            if entry is None or _sha(data) != entry["sha256"]:
                raise MediaRestoreVerificationError(f"object {member.name!r} fails its manifest digest")
            target = _safe_target(into, member.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            seen += 1
    if seen != manifest["object_count"]:
        raise MediaRestoreVerificationError("the tar holds a different number of objects than the manifest")
    return {"run_id": chosen, "objects": seen}


def _load_env() -> dict[str, str]:
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        raise ConfigError("CREDENTIALS_DIRECTORY is not set; run under the unit, or pass --env-file")
    return parse_env_text((pathlib.Path(directory) / "state-copy.env").read_text())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--env-file", help="read the configuration here instead of the unit's credential")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("copy")
    rs = sub.add_parser("restore")
    rs.add_argument("--label", choices=LABELS, required=True)
    rs.add_argument("--identity", required=True)
    rs.add_argument("--into", required=True)
    rs.add_argument("--run-id")
    args = parser.parse_args(argv)
    try:
        env = parse_env_text(pathlib.Path(args.env_file).read_text()) if args.env_file else _load_env()
        cfg = load_config(env)
    except (ConfigError, OSError) as exc:
        print(f"state_copy: refusing to run: {exc}", file=sys.stderr)
        return 2
    if args.command == "restore":
        try:
            print(json.dumps(restore(args.label, cfg, identity_path=args.identity,
                                     into=pathlib.Path(args.into), run_id=args.run_id)))
        except (MediaRestoreVerificationError, so.ObjectStorageError) as exc:
            print(f"state_copy: restore failed: {exc}", file=sys.stderr)
            return 1
        return 0
    lock_path = os.environ.get("STATE_COPY_RUN_LOCK_PATH", "/run/branchleft-state-copy/run.lock")
    try:
        lock = open(lock_path, "a+")
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        print(f"state_copy: cannot take the run lock {lock_path}: {exc}", file=sys.stderr)
        return 2
    return run_copy(cfg, os.environ.get("BACKUP_WORKER_METRICS_DIR", DEFAULT_METRICS_DIR))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
