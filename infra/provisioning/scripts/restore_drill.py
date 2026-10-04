#!/usr/bin/env python3
"""The weekly restore drill, run on the control host by
branchleft-restore-drill.timer. One run restores a tenant's newest real
backup into temporary containers, asserts that tenant's content on a drained
colour and undrains it last, checks that every backup object names exactly one
recipient, proves a throwaway tenant whose key was destroyed cannot be
restored, and exports the result for monitoring. See restore_drill.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import fcntl
import html
import http.client
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence

import backup_worker as bw
import shared_objectstorage

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_RESTORE_DRAINED_SOURCE = _REPO_ROOT / "db" / "recovery" / "restore_drained.py"
restore_drained = bw._load_module("branchleft_restore_drained", _RESTORE_DRAINED_SOURCE)

ENV_PREFIX = "BACKUP_DRILL_"
DEFAULT_TENANTS_FILE = "/etc/branchleft/backup-worker-tenants"
DEFAULT_IDENTITY_DIR = "/etc/branchleft/restore-drill/identities"
DEFAULT_WORK_DIR = "/var/lib/branchleft/restore-drill"
DEFAULT_FLAG_ROOT = "/run/branchleft-restore-drill"
DEFAULT_MAX_BACKUP_AGE_HOURS = 48.0
DEFAULT_CONTAINER_MEMORY = "1g"
IDENTITY_SUFFIX = ".key"

CONTAINER_LABEL = "branchleft.restore-drill"
DIGEST_PINNED = re.compile(r"\A[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}\Z")
OBJECT_NAME = re.compile(r"\A(\d{8}T\d{6}Z)\.sql\.age\Z")
AGE_HEADER_LINE = b"age-encryption.org/v1"
AGE_HEADER_PROBE_BYTES = 4096
NO_IDENTITY_MATCHED = "no identity matched any of the recipients"
CHILD_ENV_PASSTHROUGH = ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH")

# The synthetic tenant the erasure check encrypts and then makes
# unrecoverable. Never a real tenant's data; nothing about it is stored.
SHREDDED_TENANT_DUMP = (
    "CREATE DATABASE IF NOT EXISTS `ghost_drill_shredded`;\n"
    "USE `ghost_drill_shredded`;\n"
    "CREATE TABLE `canary` (`id` INT PRIMARY KEY, `body` VARCHAR(64));\n"
    "INSERT INTO `canary` VALUES (1,'SHREDDED_TENANT_CANARY');\n"
)

GHOST_PORT = 2368
SIDECAR_PORT = 8080
FLAG_MOUNT_DIR = "/var/run/branchleft"
FLAG_NAME = "drill.drain"

# The platform image refuses to boot without its storage adapters wired;
# these are the same values db/recovery/test-restore-drained-proof.sh uses.
GHOST_STATIC_ENV = (
    ("database__client", "mysql"),
    ("database__connection__port", "3306"),
    ("database__connection__user", "root"),
    ("privacy__useUpdateCheck", "false"),
    ("logging__transports", '["stdout"]'),
    ("BRANCHLEFT_ALLOW_LOCAL_STORAGE", "true"),
    ("storage__images__adapter", "ScanningStorageAdapter"),
    ("storage__images__wraps", "LocalImagesStorage"),
    ("storage__images__quarantinePath", "/var/lib/ghost/content/quarantine"),
    ("storage__media__adapter", "ScanningStorageAdapter"),
    ("storage__media__wraps", "LocalMediaStorage"),
    ("storage__media__quarantinePath", "/var/lib/ghost/content/quarantine"),
    ("storage__files__adapter", "ScanningStorageAdapter"),
    ("storage__files__wraps", "LocalFilesStorage"),
    ("storage__files__quarantinePath", "/var/lib/ghost/content/quarantine"),
)

METRICS_FILENAME = "restore_drill.prom"
METRIC_PREFIX = "restore_drill_"
_LAST_SUCCESS_LINE = re.compile(r"\Arestore_drill_last_success_timestamp_seconds\s+([0-9]+(?:\.[0-9]+)?)\s*\Z")


class DrillError(Exception):
    """A stage of the drill did not complete, or a check it exists for failed."""


class DrillConfigError(DrillError):
    """The drill's environment is missing or malformed; nothing was run."""


class NoBackupError(DrillError):
    """A tenant named in the tenants file has no backup object on the copy."""


class StaleBackupError(DrillError):
    """The newest backup object is older than the drill accepts."""


class RecipientAuditError(DrillError):
    """A backup object does not name exactly one X25519 recipient."""


class DecryptError(DrillError):
    """The tenant's own key did not decrypt its newest backup."""


class ContentFloorError(DrillError):
    """The restored database holds no tenant content to verify against."""


class ColourStateError(DrillError):
    """The colour's sidecar did not report the drain state the chain expects."""


class ErasureBrokenError(DrillError):
    """A backup whose key was destroyed decrypted anyway."""


class ErasureWrongReasonError(DrillError):
    """A backup whose key was destroyed failed to restore, but not because no key matched."""


@dataclasses.dataclass(frozen=True)
class DrillCopy:
    name: str
    bucket: str
    endpoint: str
    region: str
    access_key: str = dataclasses.field(repr=False)
    secret_key: str = dataclasses.field(repr=False)
    key_prefix: str = "dumps/"


@dataclasses.dataclass(frozen=True)
class Images:
    recovery: str
    mysql: str
    ghost: str
    sidecar: str


@dataclasses.dataclass(frozen=True)
class DrillConfig:
    copies: tuple[DrillCopy, ...]
    images: Images
    identity_dir: pathlib.Path
    work_dir: pathlib.Path
    flag_root: pathlib.Path
    metrics_dir: pathlib.Path
    max_backup_age_s: float
    mysql_memory: str = DEFAULT_CONTAINER_MEMORY
    ghost_memory: str = DEFAULT_CONTAINER_MEMORY


@dataclasses.dataclass(frozen=True)
class BackupObject:
    key: str
    taken_at: datetime.datetime


@dataclasses.dataclass(frozen=True)
class RestoredContent:
    database: str
    site_title: str
    users: int
    published_posts: int
    members: int
    newest_post_title: str | None
    problem: str | None = None

    def expected_strings(self) -> tuple[str, ...]:
        found = (self.site_title, self.newest_post_title)
        return tuple(text for text in found if text and text.strip())


@dataclasses.dataclass
class DrillReport:
    tenant: str
    copy: str
    ok: bool = False
    error: str | None = None
    object_key: str | None = None
    object_age_s: float | None = None
    objects_audited: int = 0
    bytes_recovered: int = 0
    restore_s: float | None = None
    verify_s: float | None = None
    content: RestoredContent | None = None
    erasure_reason: str | None = None


Runner = Callable[..., subprocess.CompletedProcess]


def _copy_from_env(environ: Mapping[str, str], *, name: str, required: bool) -> DrillCopy | None:
    """Same three outcomes as backup_worker's copy reader: every credential
    var set, none set on an optional copy, or a refusal naming what is missing."""
    prefix = f"{ENV_PREFIX}COPY_{name.upper()}_"
    var_names = [prefix + suffix for suffix in bw._COPY_CREDENTIAL_VAR_SUFFIXES]
    missing = [var for var in var_names if not environ.get(var)]
    if len(missing) == len(var_names) and not required:
        return None
    if missing:
        raise DrillConfigError(f"the {name!r} copy is missing {', '.join(sorted(missing))}")
    return DrillCopy(
        name=name,
        bucket=environ[prefix + "BUCKET"],
        endpoint=environ[prefix + "ENDPOINT"],
        region=environ[prefix + "REGION"],
        access_key=environ[prefix + "ACCESS_KEY_ID"],
        secret_key=environ[prefix + "SECRET_ACCESS_KEY"],
        key_prefix=environ.get(prefix + "OBJECT_KEY_PREFIX", "dumps/"),
    )


def copies_from_env(environ: Mapping[str, str]) -> tuple[DrillCopy, ...]:
    copies = []
    for name in bw.REQUIRED_COPY_NAMES:
        copies.append(_copy_from_env(environ, name=name, required=True))
    for name in bw.OPTIONAL_COPY_NAMES:
        copy = _copy_from_env(environ, name=name, required=False)
        if copy is not None:
            copies.append(copy)
    return tuple(copies)


def images_from_env(environ: Mapping[str, str]) -> Images:
    """Every image is pulled by digest, never by tag: a tag can move between
    the run that verified it and the run that needs it."""
    values = {}
    for field in ("recovery", "mysql", "ghost", "sidecar"):
        var = f"{ENV_PREFIX}{field.upper()}_IMAGE"
        value = environ.get(var, "")
        if not DIGEST_PINNED.match(value):
            raise DrillConfigError(f"{var} must name an image by digest (name@sha256:<64 hex>), got {value!r}")
        values[field] = value
    return Images(**values)


def config_from_env(environ: Mapping[str, str]) -> DrillConfig:
    try:
        max_age_hours = float(environ.get(f"{ENV_PREFIX}MAX_BACKUP_AGE_HOURS", DEFAULT_MAX_BACKUP_AGE_HOURS))
    except ValueError as exc:
        raise DrillConfigError(f"{ENV_PREFIX}MAX_BACKUP_AGE_HOURS is not a number: {exc}") from exc
    if max_age_hours <= 0:
        raise DrillConfigError(f"{ENV_PREFIX}MAX_BACKUP_AGE_HOURS must be positive")
    return DrillConfig(
        copies=copies_from_env(environ),
        images=images_from_env(environ),
        identity_dir=pathlib.Path(environ.get(f"{ENV_PREFIX}IDENTITY_DIR", DEFAULT_IDENTITY_DIR)),
        work_dir=pathlib.Path(environ.get(f"{ENV_PREFIX}WORK_DIR", DEFAULT_WORK_DIR)),
        flag_root=pathlib.Path(environ.get(f"{ENV_PREFIX}FLAG_ROOT", DEFAULT_FLAG_ROOT)),
        metrics_dir=pathlib.Path(environ.get(f"{ENV_PREFIX}METRICS_DIR", bw.DEFAULT_BACKUP_AGE_METRICS_DIR)),
        max_backup_age_s=max_age_hours * 3600,
        mysql_memory=environ.get(f"{ENV_PREFIX}MYSQL_MEMORY", DEFAULT_CONTAINER_MEMORY),
        ghost_memory=environ.get(f"{ENV_PREFIX}GHOST_MEMORY", DEFAULT_CONTAINER_MEMORY),
    )


def drill_week(now: datetime.datetime) -> int:
    """Whole weeks since the epoch: consecutive weekly runs always differ
    by one, which an ISO week number does not across a 53-week year."""
    return int(now.timestamp() // 86400) // 7


def choose_for_week(items: Sequence, now: datetime.datetime):
    if not items:
        raise DrillConfigError("nothing to choose from")
    return items[drill_week(now) % len(items)]


def check_single_recipient(data: bytes, what: str) -> None:
    """Reads an age header structurally: the version line, then stanzas up
    to the `--- ` MAC line. Exactly one stanza, and it must be X25519,
    or the tenant's key is not the only thing that can open this object."""
    lines = data.split(b"\n")
    if not lines or lines[0] != AGE_HEADER_LINE:
        raise RecipientAuditError(f"{what} is not an age v1 ciphertext")
    stanzas = []
    for line in lines[1:]:
        if line.startswith(b"--- "):
            break
        if line.startswith(b"-> "):
            stanzas.append(line)
    else:
        raise RecipientAuditError(
            f"{what}: no end of age header within the bytes read -- either not age, or a header "
            "far larger than one recipient makes"
        )
    if len(stanzas) != 1:
        raise RecipientAuditError(
            f"{what} names {len(stanzas)} recipients, expected exactly 1 -- a second recipient "
            "would keep this backup readable after the tenant's key is destroyed"
        )
    if not stanzas[0].startswith(b"-> X25519 "):
        raise RecipientAuditError(f"{what}'s one recipient is not an X25519 key: {stanzas[0][:24]!r}")


class ObjectStore:
    """Read-only access to one copy through the repository's one SigV4
    implementation, with the drill's Get+List credential."""

    def __init__(self, module=shared_objectstorage) -> None:
        self._s3 = module

    def _creds(self, copy: DrillCopy) -> dict[str, str]:
        return {
            "bucket": copy.bucket,
            "endpoint": copy.endpoint,
            "region": copy.region,
            "access_key": copy.access_key,
            "secret_key": copy.secret_key,
        }

    def list(self, copy: DrillCopy, prefix: str) -> list[str]:
        return [entry["key"] for entry in self._s3.list_objects(prefix=prefix, **self._creds(copy))]

    def get(self, copy: DrillCopy, key: str) -> bytes:
        return self._s3.get_object(key=key, **self._creds(copy))

    def head_bytes(self, copy: DrillCopy, key: str, length: int) -> bytes:
        status, body = self._s3.signed_request(
            method="GET", key=key, extra_headers={"range": f"bytes=0-{length - 1}"}, **self._creds(copy)
        )
        if status not in (200, 206):
            raise DrillError(f"GET {copy.bucket}/{key} (header range) failed: HTTP {status}")
        return body[:length]


def tenant_prefix(copy: DrillCopy, tenant: str) -> str:
    return f"{copy.key_prefix}{tenant}/"


def audit_recipients(store: ObjectStore, copy: DrillCopy, tenants: Sequence[str]) -> int:
    """Every backup object of every tenant on this copy, not just the one
    being restored: a second recipient on any of them is the defect."""
    audited = 0
    for tenant in tenants:
        keys = store.list(copy, tenant_prefix(copy, tenant))
        if not keys:
            raise NoBackupError(f"{tenant} has no backup object under {tenant_prefix(copy, tenant)} on {copy.name}")
        for key in keys:
            check_single_recipient(store.head_bytes(copy, key, AGE_HEADER_PROBE_BYTES), f"{copy.name}:{key}")
            audited += 1
    return audited


def newest_backup(store: ObjectStore, copy: DrillCopy, tenant: str) -> BackupObject:
    prefix = tenant_prefix(copy, tenant)
    candidates = []
    for key in store.list(copy, prefix):
        match = OBJECT_NAME.match(key[len(prefix):]) if key.startswith(prefix) else None
        if match:
            taken_at = datetime.datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(
                tzinfo=datetime.timezone.utc
            )
            candidates.append(BackupObject(key=key, taken_at=taken_at))
    if not candidates:
        raise NoBackupError(f"{tenant} has no dump object named <timestamp>.sql.age under {prefix} on {copy.name}")
    return max(candidates, key=lambda obj: obj.taken_at)


def _child_env(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    env = {name: os.environ[name] for name in CHILD_ENV_PASSTHROUGH if name in os.environ}
    env.update(extra or {})
    return env


def age_decrypt(
    *, runner: Runner, image: str, ciphertext: bytes, identity_paths: Sequence[pathlib.Path]
) -> subprocess.CompletedProcess:
    """`age --decrypt` inside the pinned recovery image, with no network,
    each identity bind-mounted read-only. Returns the completed process
    so the caller decides what a failure means."""
    argv = ["docker", "run", "--rm", "-i", "--network", "none"]
    for index, path in enumerate(identity_paths):
        argv += ["-v", f"{path}:/run/drill/id{index}:ro"]
    argv += [image, "age", "--decrypt"]
    for index in range(len(identity_paths)):
        argv += ["-i", f"/run/drill/id{index}"]
    return runner(argv, input=ciphertext, capture_output=True, check=False, env=_child_env())


def _destroy_file(path: pathlib.Path) -> None:
    try:
        size = path.stat().st_size
        with open(path, "r+b") as handle:
            handle.write(b"\0" * size)
            handle.flush()
            os.fsync(handle.fileno())
    except FileNotFoundError:
        return
    path.unlink(missing_ok=True)


def prove_erasure(*, runner: Runner, image: str, identity_dir: pathlib.Path, scratch_dir: pathlib.Path) -> str:
    """Makes a throwaway tenant, encrypts its dump to a throwaway key,
    proves that key opens it, destroys the key, then requires every key the
    drill holds to fail with age's own "no identity matched" error. Returns
    that error line."""
    keygen = runner(
        ["docker", "run", "--rm", "--network", "none", image, "age-keygen"],
        capture_output=True, check=False, env=_child_env(),
    )
    output = keygen.stdout.decode(errors="replace") if isinstance(keygen.stdout, bytes) else keygen.stdout
    recipient_match = re.search(r"public key: (age1[0-9a-z]+)", output or "")
    secret_match = re.search(r"^(AGE-SECRET-KEY-1[0-9A-Z]+)$", output or "", re.MULTILINE)
    if keygen.returncode != 0 or not recipient_match or not secret_match:
        raise DrillError("age-keygen in the recovery image did not produce a key pair")

    plaintext = SHREDDED_TENANT_DUMP.encode()
    encrypted = runner(
        ["docker", "run", "--rm", "-i", "--network", "none", image, "age", "-r", recipient_match.group(1)],
        input=plaintext, capture_output=True, check=False, env=_child_env(),
    )
    if encrypted.returncode != 0:
        raise DrillError("could not encrypt the shredded tenant's synthetic dump")
    check_single_recipient(encrypted.stdout, "the shredded tenant's synthetic dump")

    key_path = scratch_dir / f"shredded{IDENTITY_SUFFIX}"
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(secret_match.group(1) + "\n")
    try:
        before = age_decrypt(runner=runner, image=image, ciphertext=encrypted.stdout, identity_paths=[key_path])
        if before.returncode != 0 or before.stdout != plaintext:
            raise DrillError(
                "the shredded tenant's dump did not decrypt with its own key before destruction, so "
                "a failure after destruction would prove nothing"
            )
    finally:
        _destroy_file(key_path)
    if key_path.exists():
        raise DrillError(f"{key_path} still exists after destruction")

    held = held_identities(identity_dir)
    after = age_decrypt(runner=runner, image=image, ciphertext=encrypted.stdout, identity_paths=held)
    stderr = after.stderr.decode(errors="replace") if isinstance(after.stderr, bytes) else (after.stderr or "")
    if after.returncode == 0:
        raise ErasureBrokenError(
            "a backup encrypted to a key that was then destroyed decrypted with a key the drill holds -- "
            "erasure by key destruction does not hold"
        )
    if NO_IDENTITY_MATCHED not in stderr:
        raise ErasureWrongReasonError(
            f"the shredded tenant's restore failed, but not because no key matched: {stderr.strip()!r}"
        )
    return next(line for line in stderr.splitlines() if NO_IDENTITY_MATCHED in line).strip()


def container_mysql_runner(*, runner: Runner, image: str, network: str) -> Runner:
    """Adapts restore_drained's `run` so every `mysql` call it makes runs in
    the pinned recovery image on the drill's network. The password crosses
    as an environment value, never argv."""

    def run(argv, *, env, stdin=None, capture_output=False, text=False, check=False):
        docker_argv = ["docker", "run", "--rm", "--network", network]
        if stdin is not None:
            docker_argv.append("-i")
        docker_argv += ["-e", "MYSQL_PWD", image, *argv]
        return runner(
            docker_argv,
            env=_child_env({"MYSQL_PWD": env["MYSQL_PWD"]}),
            stdin=stdin,
            capture_output=capture_output,
            text=text,
            check=check,
        )

    return run


SNAPSHOT_QUERY = (
    "SELECT (SELECT `value` FROM settings WHERE `key`='title'), "
    "(SELECT COUNT(*) FROM users), "
    "(SELECT COUNT(*) FROM posts WHERE type='post' AND status='published'), "
    "(SELECT COUNT(*) FROM members), "
    "(SELECT title FROM posts WHERE type='post' AND status='published' ORDER BY published_at DESC LIMIT 1);"
)


def _unescape_batch(value: str) -> str:
    return value.replace("\\t", "\t").replace("\\n", "\n").replace("\\\\", "\\")


def snapshot_restored_content(*, run: Runner, host: str, password: str, database: str) -> RestoredContent:
    """Reads what the drill will assert from the restored database, before
    any Ghost process exists: a Ghost booted on an empty database writes
    its own defaults, so reading afterwards would assert those instead.
    A database with no Ghost schema comes back with `problem` set."""
    result = run(
        ["mysql", "--host", host, "--user", "root", "--database", database, "-N", "-B", "-e", SNAPSHOT_QUERY],
        env={"MYSQL_PWD": password}, capture_output=True, text=True, check=False,
    )
    fields = (result.stdout or "").rstrip("\n").split("\t")
    if result.returncode != 0 or len(fields) != 5:
        problem = (result.stderr or "").strip() or f"unexpected snapshot output {result.stdout!r}"
        return RestoredContent(database=database, site_title="", users=0, published_posts=0, members=0,
                               newest_post_title=None, problem=problem)
    title, users, posts, members, newest = fields
    return RestoredContent(
        database=database,
        site_title="" if title == "NULL" else _unescape_batch(title),
        users=int(users),
        published_posts=int(posts),
        members=int(members),
        newest_post_title=None if newest == "NULL" else _unescape_batch(newest),
    )


def require_tenant_content(content: RestoredContent) -> None:
    """The empty-restore control. Without it, an empty restore reaches a
    Ghost that answers 200 with nothing of the tenant's to look for."""
    if content.problem is not None:
        raise ContentFloorError(
            f"the restored database {content.database} holds no Ghost schema -- nothing was restored: "
            f"{content.problem}"
        )
    if not content.site_title.strip() or content.users < 1:
        raise ContentFloorError(
            f"the restored database {content.database} has no site title or no staff user -- a restore "
            "with nothing to assert cannot pass"
        )


def http_get(url: str, timeout_s: float) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"X-Forwarded-Proto": "https"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310 -- loopback URL built here
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
        return 0, str(exc)


def unescaping_get(get: Callable[..., tuple[int, str]]) -> Callable[..., tuple[int, str]]:
    """Ghost HTML-escapes titles; the assertion compares text, not markup."""

    def wrapped(url: str, timeout_s: float) -> tuple[int, str]:
        status, body = get(url, timeout_s)
        return status, html.unescape(body)

    return wrapped


def wait_for_status(
    *, get, url: str, want: int, timeout_s: float, sleep=time.sleep, now=time.monotonic
) -> None:
    deadline = now() + timeout_s
    last = None
    while True:
        last, _ = get(url, 5.0)
        if last == want:
            return
        if now() >= deadline:
            raise ColourStateError(f"{url} answered {last}, never {want}, within {timeout_s}s")
        sleep(1.0)


class Containers:
    """The drill's per-run containers and network, all carrying one label
    so a crashed run's leftovers are found and removed by the next."""

    def __init__(self, *, runner: Runner, run_id: str) -> None:
        self._runner = runner
        self.run_id = run_id
        self.network = f"restore-drill-{run_id}"
        self.mysql = f"restore-drill-mysql-{run_id}"
        self.ghost = f"restore-drill-ghost-{run_id}"
        self.sidecar = f"restore-drill-sidecar-{run_id}"

    def _docker(self, argv: list[str], *, env_extra: Mapping[str, str] | None = None) -> str:
        result = self._runner(
            ["docker", *argv], capture_output=True, text=True, check=False, env=_child_env(env_extra)
        )
        if result.returncode != 0:
            raise DrillError(f"docker {argv[0]} failed: {(result.stderr or '').strip()}")
        return result.stdout or ""

    def _label(self) -> list[str]:
        return ["--label", f"{CONTAINER_LABEL}={self.run_id}"]

    def sweep(self) -> None:
        """Removes every container and network any drill run left behind."""
        ids = self._docker(["ps", "-aq", "--filter", f"label={CONTAINER_LABEL}"]).split()
        if ids:
            self._docker(["rm", "-f", "-v", *ids])
        nets = self._docker(["network", "ls", "-q", "--filter", f"label={CONTAINER_LABEL}"]).split()
        if nets:
            self._docker(["network", "rm", *nets])

    def pull(self, images: Images) -> None:
        """Pulls each image unless that exact digest is already present."""
        for image in (images.recovery, images.mysql, images.ghost, images.sidecar):
            present = self._runner(
                ["docker", "image", "inspect", "--format", "{{.Id}}", image],
                capture_output=True, text=True, check=False, env=_child_env(),
            )
            if present.returncode != 0:
                self._docker(["pull", "--quiet", image])

    def start_mysql(self, *, image: str, password: str, memory: str) -> None:
        self._docker(["network", "create", *self._label(), self.network])
        self._docker(
            ["run", "-d", "--name", self.mysql, "--network", self.network, "--memory", memory, *self._label(),
             "-e", "MYSQL_ROOT_PASSWORD", image],
            env_extra={"MYSQL_ROOT_PASSWORD": password},
        )

    def start_colour(
        self, *, ghost_image: str, sidecar_image: str, database: str, password: str, memory: str, flag_dir: str
    ) -> tuple[int, int]:
        """A Ghost on the restored database and its drain sidecar sharing
        its network namespace, both published on loopback only. Returns
        the host ports of Ghost and the sidecar."""
        env_args: list[str] = []
        for name, value in GHOST_STATIC_ENV:
            env_args += ["-e", f"{name}={value}"]
        env_args += [
            "-e", f"url=http://127.0.0.1:{GHOST_PORT}",
            "-e", f"database__connection__host={self.mysql}",
            "-e", f"database__connection__database={database}",
            "-e", "database__connection__password",
        ]
        self._docker(
            ["run", "-d", "--name", self.ghost, "--network", self.network, "--memory", memory, *self._label(),
             "-p", f"127.0.0.1::{GHOST_PORT}", "-p", f"127.0.0.1::{SIDECAR_PORT}", *env_args, ghost_image],
            env_extra={"database__connection__password": password},
        )
        self._docker(
            ["run", "-d", "--name", self.sidecar, "--network", f"container:{self.ghost}", *self._label(),
             "-v", f"{flag_dir}:{FLAG_MOUNT_DIR}:ro",
             "-e", f"DRAIN_FLAG_PATH={FLAG_MOUNT_DIR}/{FLAG_NAME}",
             "-e", f"GHOST_HEALTH_URL=http://127.0.0.1:{GHOST_PORT}/",
             "-e", f"PORT={SIDECAR_PORT}", sidecar_image],
        )
        return self.host_port(GHOST_PORT), self.host_port(SIDECAR_PORT)

    def host_port(self, container_port: int) -> int:
        out = self._docker(["port", self.ghost, f"{container_port}/tcp"]).strip().splitlines()
        if not out:
            raise DrillError(f"{self.ghost} publishes nothing for {container_port}/tcp")
        return int(out[0].rsplit(":", 1)[1])

    def remove(self) -> None:
        for name in (self.sidecar, self.ghost, self.mysql):
            self._runner(["docker", "rm", "-f", "-v", name], capture_output=True, check=False, env=_child_env())
        self._runner(["docker", "network", "rm", self.network], capture_output=True, check=False, env=_child_env())


def identity_path(config: DrillConfig, tenant: str) -> pathlib.Path:
    path = config.identity_dir / f"{tenant}{IDENTITY_SUFFIX}"
    if not path.is_file():
        raise DrillConfigError(f"no identity for {tenant} at {path}")
    return path


def held_identities(identity_dir: pathlib.Path) -> list[pathlib.Path]:
    """Every key the drill holds, read at the moment it is needed."""
    held = sorted(p for p in identity_dir.glob(f"*{IDENTITY_SUFFIX}") if p.is_file())
    if not held:
        raise DrillConfigError(f"no identities in {identity_dir}")
    return held


@dataclasses.dataclass
class Hooks:
    """Every effect outside this process, so tests can replace each one."""

    runner: Runner = subprocess.run
    store: ObjectStore = dataclasses.field(default_factory=ObjectStore)
    get: Callable[..., tuple[int, str]] = http_get
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    now: Callable[[], datetime.datetime] = lambda: datetime.datetime.now(datetime.timezone.utc)
    run_id: Callable[[], str] = lambda: secrets.token_hex(4)
    content_timeout_s: float = 600.0
    sidecar_timeout_s: float = 120.0


def run_drill(
    *, config: DrillConfig, tenants: Sequence[str], hooks: Hooks,
    tenant: str | None = None, copy_name: str | None = None,
) -> DrillReport:
    """The whole drill. Never raises: every failure is recorded on the
    report, and the containers, flag and decrypted bytes are removed
    whatever happened."""
    started = hooks.now()
    chosen_tenant = tenant or choose_for_week(list(tenants), started)
    if copy_name is None:
        copy = choose_for_week(list(config.copies), started)
    else:
        named = [c for c in config.copies if c.name == copy_name]
        if not named:
            return DrillReport(tenant=chosen_tenant, copy=copy_name, error=f"no configured copy named {copy_name!r}")
        copy = named[0]
    report = DrillReport(tenant=chosen_tenant, copy=copy.name)
    containers = Containers(runner=hooks.runner, run_id=hooks.run_id())
    run_dir = config.work_dir / f"run-{containers.run_id}"
    flag_dir = config.flag_root / f"run-{containers.run_id}"
    try:
        bw.validate_tenant_name(chosen_tenant)
        own_identity = identity_path(config, chosen_tenant)
        report.objects_audited = audit_recipients(hooks.store, copy, list(tenants))
        backup = newest_backup(hooks.store, copy, chosen_tenant)
        report.object_key = backup.key
        report.object_age_s = (started - backup.taken_at).total_seconds()
        if report.object_age_s > config.max_backup_age_s:
            raise StaleBackupError(
                f"the newest backup of {chosen_tenant} on {copy.name} ({backup.key}) is "
                f"{report.object_age_s / 3600:.1f}h old; the drill accepts {config.max_backup_age_s / 3600:.1f}h"
            )
        ciphertext = hooks.store.get(copy, backup.key)
        check_single_recipient(ciphertext, f"{copy.name}:{backup.key}")

        containers.sweep()
        containers.pull(config.images)
        run_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
        flag_dir.mkdir(mode=0o755, parents=True, exist_ok=False)
        os.chmod(flag_dir, 0o755)

        report.erasure_reason = prove_erasure(
            runner=hooks.runner, image=config.images.recovery,
            identity_dir=config.identity_dir, scratch_dir=run_dir,
        )

        restore_started = hooks.clock()
        decrypted = age_decrypt(
            runner=hooks.runner, image=config.images.recovery, ciphertext=ciphertext, identity_paths=[own_identity]
        )
        if decrypted.returncode != 0:
            raise DecryptError(
                f"{chosen_tenant}'s own key did not decrypt {backup.key}: "
                f"{decrypted.stderr.decode(errors='replace').strip()}"
            )
        dump_path = run_dir / "dump.sql"
        fd = os.open(dump_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(decrypted.stdout)
        report.bytes_recovered = len(decrypted.stdout)
        del decrypted

        password = secrets.token_urlsafe(24)
        containers.start_mysql(image=config.images.mysql, password=password, memory=config.mysql_memory)
        mysql_run = container_mysql_runner(runner=hooks.runner, image=config.images.recovery, network=containers.network)
        restore_drained.restore_only(
            dump_path=str(dump_path), host=containers.mysql, port=3306, user="root", password=password,
            mysql_ready_timeout_s=180.0, run=mysql_run, sleep=hooks.sleep, now=hooks.clock,
        )
        database = bw._naming.TENANT_DB_PREFIX + bw._naming.sql_identifier(chosen_tenant)
        report.content = snapshot_restored_content(
            run=mysql_run, host=containers.mysql, password=password, database=database
        )
        require_tenant_content(report.content)
        report.restore_s = hooks.clock() - restore_started

        verify_started = hooks.clock()
        flag_path = flag_dir / FLAG_NAME
        flag_path.touch(mode=0o644)
        ghost_port, sidecar_port = containers.start_colour(
            ghost_image=config.images.ghost, sidecar_image=config.images.sidecar, database=database,
            password=password, memory=config.ghost_memory, flag_dir=str(flag_dir),
        )
        sidecar_url = f"http://127.0.0.1:{sidecar_port}/healthz"
        wait_for_status(
            get=hooks.get, url=sidecar_url, want=503, timeout_s=hooks.sidecar_timeout_s,
            sleep=hooks.sleep, now=hooks.clock,
        )
        ghost_url = f"http://127.0.0.1:{ghost_port}/"
        wait_for_status(
            get=hooks.get, url=ghost_url, want=200, timeout_s=hooks.content_timeout_s,
            sleep=hooks.sleep, now=hooks.clock,
        )
        for expected in report.content.expected_strings():
            restore_drained.verify_tenant_content(
                base_url=ghost_url, expected_post_body=expected,
                timeout_s=hooks.content_timeout_s, get=unescaping_get(hooks.get), sleep=hooks.sleep, now=hooks.clock,
            )
        restore_drained.clear_drain_flag(str(flag_path))
        wait_for_status(
            get=hooks.get, url=sidecar_url, want=200, timeout_s=hooks.sidecar_timeout_s,
            sleep=hooks.sleep, now=hooks.clock,
        )
        report.verify_s = hooks.clock() - verify_started
        report.ok = True
    except (DrillError, restore_drained.RestoreError, shared_objectstorage.ObjectStorageError,
            bw.InvalidTenantName, OSError) as exc:
        report.error = f"{type(exc).__name__}: {exc}"
    finally:
        containers.remove()
        shutil.rmtree(run_dir, ignore_errors=True)
        shutil.rmtree(flag_dir, ignore_errors=True)
    return report


def _previous_last_success(path: pathlib.Path) -> float | None:
    try:
        text = path.read_text()
    except OSError:
        return None
    for line in text.splitlines():
        match = _LAST_SUCCESS_LINE.match(line.strip())
        if match:
            return float(match.group(1))
    return None


def render_metrics(report: DrillReport, *, ran_at: float, last_success: float | None) -> str:
    labels = f'tenant="{bw._escape_label_value(report.tenant)}",copy="{bw._escape_label_value(report.copy)}"'
    gauges: list[tuple[str, str, float | None]] = [
        ("last_run_timestamp_seconds", "Unix time the drill last ran.", ran_at),
        ("last_run_success", "1 if the drill's last run passed every check, else 0.", 1.0 if report.ok else 0.0),
        ("last_success_timestamp_seconds", "Unix time the drill last passed every check.", last_success),
        ("restore_duration_seconds", "Decrypt, import and snapshot time of the last run.", report.restore_s),
        ("verify_duration_seconds", "Colour start to undrain time of the last run.", report.verify_s),
        ("bytes_recovered", "Plaintext bytes the last run decrypted.", float(report.bytes_recovered)),
        ("backup_object_age_seconds", "Age of the backup object the last run restored.", report.object_age_s),
        ("objects_audited", "Backup objects whose recipients the last run checked.", float(report.objects_audited)),
    ]
    lines = []
    for name, help_text, value in gauges:
        if value is None:
            continue
        lines += [f"# HELP {METRIC_PREFIX}{name} {help_text}", f"# TYPE {METRIC_PREFIX}{name} gauge",
                  f"{METRIC_PREFIX}{name} {value}"]
    lines += [f"# HELP {METRIC_PREFIX}last_run_info Which tenant and copy the last run drilled.",
              f"# TYPE {METRIC_PREFIX}last_run_info gauge", f"{METRIC_PREFIX}last_run_info{{{labels}}} 1"]
    return "\n".join(lines) + "\n"


def record_metrics(report: DrillReport, *, metrics_dir: pathlib.Path, ran_at: float) -> None:
    """The last-success timestamp only ever advances on a passing run, so a
    drill that fails or stops running shows as a growing age."""
    metrics_dir.mkdir(parents=True, exist_ok=True)
    path = metrics_dir / METRICS_FILENAME
    last_success = ran_at if report.ok else _previous_last_success(path)
    bw.write_textfile_atomically(path, render_metrics(report, ran_at=ran_at, last_success=last_success))


def format_report(report: DrillReport) -> list[str]:
    lines = [f"restore_drill: tenant={report.tenant} copy={report.copy} object={report.object_key}"]
    lines.append(f"restore_drill: recipients checked on {report.objects_audited} object(s)")
    if report.erasure_reason:
        lines.append(f"restore_drill: shredded tenant refused, for the right reason: {report.erasure_reason}")
    if report.content:
        c = report.content
        lines.append(
            f"restore_drill: restored {report.bytes_recovered} bytes; title={c.site_title!r} users={c.users} "
            f"published_posts={c.published_posts} members={c.members} newest_post={c.newest_post_title!r}"
        )
    if report.ok:
        lines.append(
            f"restore_drill: PASS restore={report.restore_s:.1f}s verify={report.verify_s:.1f}s "
            f"object_age={report.object_age_s / 3600:.1f}h"
        )
    else:
        lines.append(f"restore_drill: FAIL {report.error}")
    return lines


def main(argv: Sequence[str] | None = None, *, hooks: Hooks | None = None,
         environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenants-file", default=DEFAULT_TENANTS_FILE)
    parser.add_argument("--tenant", help="drill this tenant instead of this week's choice")
    parser.add_argument("--copy", dest="copy_name", help="restore from this copy instead of this week's choice")
    args = parser.parse_args(argv)
    hooks = hooks or Hooks()
    environ = os.environ if environ is None else environ
    try:
        config = config_from_env(environ)
        tenants = read_tenants(args.tenants_file)
    except (DrillConfigError, OSError) as exc:
        print(f"restore_drill: {exc}", file=sys.stderr)
        return 2
    if not tenants:
        print(f"restore_drill: {args.tenants_file} names no tenant", file=sys.stderr)
        return 2
    try:
        config.flag_root.mkdir(mode=0o755, parents=True, exist_ok=True)
        lock = open(config.flag_root / "drill.lock", "w")  # noqa: SIM115 -- held for the whole run
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        print(f"restore_drill: another drill run holds the lock, or it cannot be taken: {exc}", file=sys.stderr)
        return 2
    with lock:
        report = run_drill(
            config=config, tenants=tenants, hooks=hooks, tenant=args.tenant, copy_name=args.copy_name
        )
    for line in format_report(report):
        print(line, file=sys.stdout if report.ok else sys.stderr)
    try:
        record_metrics(report, metrics_dir=config.metrics_dir, ran_at=hooks.now().timestamp())
    except OSError as exc:
        print(f"restore_drill: could not export the result: {exc}", file=sys.stderr)
        return 1
    return 0 if report.ok else 1


def read_tenants(path: str) -> list[str]:
    names = []
    for line in pathlib.Path(path).read_text().splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and stripped not in names:
            names.append(stripped)
    return names


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
