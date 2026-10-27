#!/usr/bin/env python3
"""Enrols one tenant in backups from the control host: mints the tenant's own
age key pair, keeps the private half in exactly two places (an age-encrypted
spare in a private bucket, and the identity file the restore drill reads),
lists the tenant for the backup worker, and checks the tenant's first dump
opens with its own key and with no other identity. Run as root, fail closed,
in a fixed order. This process never takes a dump itself: the first dump runs
as the backup worker's service account in its own systemd unit, so no
run-lock or metrics file is ever created by root. See enrol_tenant_backup.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import hashlib
import hmac
import os
import pathlib
import re
import stat
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "control" / "provision"))

import backup_recipients as br  # noqa: E402
import backup_worker as bw  # noqa: E402
import install_backup_worker as ibw  # noqa: E402
import media_backup_restore as mbr  # noqa: E402
import restore_drill as rd  # noqa: E402
import shared_objectstorage  # noqa: E402

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_USAGE = 2
EXIT_HALF_ENROLLED = 3
EXIT_WRONG_KEY = 4
EXIT_FIRST_DUMP = 5
EXIT_ROLLBACK_INCOMPLETE = 6

DEFAULT_SPARE_CONFIG = "/etc/branchleft/enrol-tenant-backup.env"
DEFAULT_WORKER_ENV = str(ibw.Paths().env_file)
DEFAULT_DRILL_ENV = "/etc/branchleft/restore-drill.env"
DEFAULT_TENANTS_FILE = str(ibw.Paths().tenants_file)
DEFAULT_RECIPIENTS_FILE = br.DEFAULT_RECIPIENTS_FILE
DEFAULT_IDENTITY_DIR = rd.DEFAULT_IDENTITY_DIR
DEFAULT_LOCK_PATH = "/run/branchleft-enrol-tenant-backup.lock"

SPARE_ENV_PREFIX = "ENROL_BACKUP_SPARE_"
SPARE_CREDENTIAL_NAMES = tuple(
    SPARE_ENV_PREFIX + suffix for suffix in ("BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
)
WRAPPING_RECIPIENT_ENV = SPARE_ENV_PREFIX + "WRAPPING_RECIPIENT"
WRAPPING_SHA256_ENV = WRAPPING_RECIPIENT_ENV + "_SHA256"
SPARE_REQUIRED_NAMES = (*SPARE_CREDENTIAL_NAMES, WRAPPING_RECIPIENT_ENV, WRAPPING_SHA256_ENV)

SPARE_KEY_PREFIX = "spares/"
SPARE_KEY_SUFFIX = ".key.age"

NIGHTLY_UNIT = "branchleft-backup-worker.service"
FIRST_DUMP_UNIT = "branchleft-backup-worker-first-dump@{tenant}.service"
BUSY_STATES = frozenset({"active", "activating", "reloading"})
# The unit's own TimeoutStartSec is two hours; the client waits a little longer.
FIRST_DUMP_TIMEOUT_S = 2 * 3600 + 600

MAX_CONFIG_BYTES = 256 * 1024
_ENV_LINE = re.compile(r"\A([A-Za-z_][A-Za-z0-9_]*)=(.*)\Z")
_STACK_SLUG_LINE = re.compile(r"\A[ \t]+[A-Za-z0-9][A-Za-z0-9._-]*-infra:slug:[ \t]*(\S.*?)[ \t]*\Z")
_SECRET_KEY_LINE = re.compile(rb"^AGE-SECRET-KEY-1[A-Z0-9]+$", re.M)
_PUBLIC_KEY_COMMENT = re.compile(rb"^# public key: (age1[a-z0-9]+)$", re.M)
_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

Runner = Callable[..., subprocess.CompletedProcess]


class Refusal(Exception):
    """The enrolment stops here with the given exit code; whatever this run
    created has already been removed, or nothing had been created yet."""

    def __init__(self, message: str, code: int = EXIT_REFUSED) -> None:
        super().__init__(message)
        self.code = code


class RollbackIncomplete(Refusal):
    """A failure left something this run created behind."""

    def __init__(self, message: str) -> None:
        super().__init__(message, EXIT_ROLLBACK_INCOMPLETE)


def _say(message: str) -> None:
    print(f"enrol_tenant_backup: {message}")


def _alert(message: str) -> None:
    print(f"enrol_tenant_backup: ALERT: {message}", file=sys.stderr)


@dataclasses.dataclass(frozen=True)
class Paths:
    spare_config: str = DEFAULT_SPARE_CONFIG
    worker_env: str = DEFAULT_WORKER_ENV
    drill_env: str = DEFAULT_DRILL_ENV
    tenants_file: str = DEFAULT_TENANTS_FILE
    recipients_file: str = DEFAULT_RECIPIENTS_FILE
    identity_dir: str = DEFAULT_IDENTITY_DIR
    lock_path: str = DEFAULT_LOCK_PATH


@dataclasses.dataclass(frozen=True)
class SpareConfig:
    bucket: str
    endpoint: str
    region: str
    access_key: str = dataclasses.field(repr=False)
    secret_key: str = dataclasses.field(repr=False)
    wrapping_recipient: str
    wrapping_sha256: str


class SpareStore(Protocol):
    """Where the age-encrypted spare of each tenant's identity is kept."""

    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...


class S3SpareStore:
    """The spare bucket, through the repository's one SigV4 implementation."""

    def __init__(self, config: SpareConfig, module=shared_objectstorage) -> None:
        self._s3 = module
        self._config = config

    def _creds(self) -> dict[str, str]:
        return {
            "bucket": self._config.bucket,
            "endpoint": self._config.endpoint,
            "region": self._config.region,
            "access_key": self._config.access_key,
            "secret_key": self._config.secret_key,
        }

    def put(self, key: str, data: bytes) -> None:
        self._s3.put_object(key=key, data=data, **self._creds())

    def get(self, key: str) -> bytes:
        return self._s3.get_object(key=key, **self._creds())

    def exists(self, key: str) -> bool:
        return any(entry["key"] == key for entry in self._s3.list_objects(prefix=key, **self._creds()))

    def delete(self, key: str) -> None:
        self._s3.delete_object(key=key, **self._creds())


class DumpReader(Protocol):
    """Read access to the dump copies, with the restore drill's Get+List credential."""

    def list(self, copy: rd.DrillCopy, prefix: str) -> list[str]: ...

    def get(self, copy: rd.DrillCopy, key: str) -> bytes: ...


def make_run(runner: Runner) -> Runner:
    """Every child gets an explicit minimal environment, never this process's."""

    def run(argv, **kwargs):
        kwargs.setdefault("env", {"PATH": os.environ.get("PATH", _DEFAULT_PATH), "LC_ALL": "C"})
        return runner(argv, **kwargs)

    return run


def spare_key_for(tenant: str) -> str:
    return f"{SPARE_KEY_PREFIX}{tenant}{SPARE_KEY_SUFFIX}"


# ---------------------------------------------------------------------------
# Reading configuration
# ---------------------------------------------------------------------------


def _read_regular_file(path: str, *, what: str) -> tuple[os.stat_result, bytes]:
    """Reads a file without following a symlink; returns the stat of exactly
    what was read."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise Refusal(f"{what} cannot be read: {exc.strerror}; nothing changed") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Refusal(f"{what} is not a regular file; nothing changed")
        chunks = []
        size = 0
        while chunk := os.read(fd, 65536):
            size += len(chunk)
            if size > MAX_CONFIG_BYTES:
                raise Refusal(f"{what} is larger than {MAX_CONFIG_BYTES} bytes; nothing changed")
            chunks.append(chunk)
        return info, b"".join(chunks)
    finally:
        os.close(fd)


def read_env_file(path: str, *, owner_uid: int, what: str) -> dict[str, str]:
    """A root-owned 0600 file of NAME=VALUE lines. Values are never printed."""
    info, raw = _read_regular_file(path, what=what)
    if info.st_uid != owner_uid:
        raise Refusal(f"{what} must be owned by uid {owner_uid}; nothing changed")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise Refusal(f"{what} must be mode 0600 -- it holds credentials; nothing changed")
    values: dict[str, str] = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ENV_LINE.match(stripped)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def load_spare_config(path: str, *, owner_uid: int) -> SpareConfig:
    values = read_env_file(path, owner_uid=owner_uid, what="the spare configuration")
    missing = [name for name in SPARE_REQUIRED_NAMES if not values.get(name)]
    if missing:
        raise Refusal(f"the spare configuration does not set {', '.join(missing)}; nothing changed")
    return SpareConfig(
        bucket=values[SPARE_ENV_PREFIX + "BUCKET"],
        endpoint=values[SPARE_ENV_PREFIX + "ENDPOINT"],
        region=values[SPARE_ENV_PREFIX + "REGION"],
        access_key=values[SPARE_ENV_PREFIX + "ACCESS_KEY_ID"],
        secret_key=values[SPARE_ENV_PREFIX + "SECRET_ACCESS_KEY"],
        wrapping_recipient=values[WRAPPING_RECIPIENT_ENV],
        wrapping_sha256=values[WRAPPING_SHA256_ENV],
    )


def stack_slug(raw: bytes) -> str:
    found = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        match = _STACK_SLUG_LINE.match(line)
        if match:
            found.append(match.group(1).strip("'\""))
    if len(found) != 1:
        raise Refusal(f"the tenant configuration holds {len(found)} slug lines, expected exactly one; nothing changed")
    return found[0]


@dataclasses.dataclass(frozen=True)
class CopyIdentity:
    label: str
    bucket: str
    key_id: str = dataclasses.field(repr=False)


def worker_copy_identities(env: Mapping[str, str]) -> list[CopyIdentity]:
    """Bucket and access key id of every dump copy the worker writes to."""
    found = []
    for name, required in [(n, True) for n in bw.REQUIRED_COPY_NAMES] + [(n, False) for n in bw.OPTIONAL_COPY_NAMES]:
        prefix = f"BACKUP_WORKER_COPY_{name.upper()}_"
        present = {suffix: env.get(prefix + suffix, "") for suffix in bw._COPY_CREDENTIAL_VAR_SUFFIXES}
        if not any(present.values()) and not required:
            continue
        if not all(present.values()):
            raise Refusal(f"the worker's {name} copy is not fully configured; nothing changed")
        found.append(CopyIdentity(f"worker {name}", present["BUCKET"], present["ACCESS_KEY_ID"]))
    return found


def refuse_if_spare_is_a_dump_copy(spare: SpareConfig, copies: Sequence[CopyIdentity]) -> None:
    for copy in copies:
        if spare.bucket == copy.bucket:
            raise Refusal(f"the spare bucket is the same bucket as the {copy.label} dump copy; nothing changed")
        if spare.access_key == copy.key_id:
            raise Refusal(f"the spare access key is the same key as the {copy.label} dump copy; nothing changed")


def check_wrapping_recipient(spare: SpareConfig, tenant_recipients: Mapping[str, str]) -> str:
    """The pinned wrapping recipient: valid age, nobody's tenant key, and the
    one the owner fingerprinted. Prints its SHA256 on every run."""
    try:
        br.parse_recipients(f"wrapping {spare.wrapping_recipient}\n")
    except br.RecipientError:
        raise Refusal("the spare wrapping recipient is not one age public key; nothing changed") from None
    fingerprint = hashlib.sha256(spare.wrapping_recipient.encode("utf-8")).hexdigest()
    _say(f"spare wrapping recipient sha256: {fingerprint}")
    if not hmac.compare_digest(fingerprint, spare.wrapping_sha256.strip().lower()):
        raise Refusal("the spare wrapping recipient does not match its pinned sha256; nothing changed")
    if spare.wrapping_recipient in tenant_recipients.values():
        raise Refusal("the spare wrapping recipient is a tenant's own recipient; nothing changed")
    return fingerprint


def check_identity_dir(path: str, *, owner_uid: int) -> None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise Refusal(f"the identity directory cannot be opened: {exc.strerror}; nothing changed") from None
    try:
        info = os.fstat(fd)
    finally:
        os.close(fd)
    if info.st_uid != owner_uid:
        raise Refusal(f"the identity directory must be owned by uid {owner_uid}; nothing changed")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise Refusal("the identity directory must be mode 0700; nothing changed")


def tenant_names(raw: bytes) -> list[str]:
    return [
        line.strip()
        for line in raw.decode("utf-8", errors="replace").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def list_file_problems(paths: Paths, *, owner_uid: int, group_gid: int | None, tenants: Sequence[str]) -> list[str]:
    """The installer's own checks of the two lists. An empty tenants file is
    the state before the first enrolment, not a defect."""
    problems = [
        problem
        for problem in ibw.tenants_file_problems(
            pathlib.Path(paths.tenants_file), owner_uid=owner_uid, group_gid=group_gid
        )
        if not problem.endswith("names no tenant")
    ]
    problems += ibw.recipients_file_problems(
        pathlib.Path(paths.recipients_file), tenants, owner_uid=owner_uid, group_gid=group_gid
    )
    return problems


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class State:
    identity: bool
    identity_tmp: bool
    spare: bool
    recipient: bool
    tenant: bool

    def present(self) -> list[str]:
        names = [
            ("an identity file", self.identity),
            ("an identity temp file", self.identity_tmp),
            ("a spare object", self.spare),
            ("a recipients-file line", self.recipient),
            ("a tenants-file line", self.tenant),
        ]
        return [name for name, here in names if here]

    @property
    def nothing(self) -> bool:
        return not self.present()

    @property
    def complete(self) -> bool:
        return self.identity and self.spare and self.recipient and self.tenant and not self.identity_tmp


def identity_path(identity_dir: str, tenant: str) -> str:
    return os.path.join(identity_dir, f"{tenant}{rd.IDENTITY_SUFFIX}")


def identity_tmp_path(identity_dir: str, tenant: str) -> str:
    # A leading dot keeps it outside the drill's `*.key` glob.
    return os.path.join(identity_dir, f".{tenant}{rd.IDENTITY_SUFFIX}.tmp")


def _lexists(path: str) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return False
    return True


def classify(
    tenant: str, *, paths: Paths, store: SpareStore, recipients: Mapping[str, str], tenants: Sequence[str]
) -> State:
    return State(
        identity=_lexists(identity_path(paths.identity_dir, tenant)),
        identity_tmp=_lexists(identity_tmp_path(paths.identity_dir, tenant)),
        spare=store.exists(spare_key_for(tenant)),
        recipient=tenant in recipients,
        tenant=tenant in tenants,
    )


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Snapshot:
    path: str
    info: os.stat_result
    data: bytes


def snapshot(path: str, *, what: str) -> Snapshot:
    info, data = _read_regular_file(path, what=what)
    return Snapshot(path=path, info=info, data=data)


def _fsync_directory(directory: str) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def replace_atomically(path: str, data: bytes, like: os.stat_result) -> None:
    """Write to a temp file beside `path`, give it `like`'s owner, group and
    mode, then rename it into place."""
    directory = os.path.dirname(path)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchown(handle.fileno(), like.st_uid, like.st_gid)
            os.fchmod(handle.fileno(), stat.S_IMODE(like.st_mode))
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise
    _fsync_directory(directory)


def with_line(data: bytes, line: str) -> bytes:
    text = data.decode("utf-8", errors="strict")
    if text and not text.endswith("\n"):
        text += "\n"
    return (text + line + "\n").encode("utf-8")


def without_tenant(data: bytes, tenant: str) -> bytes:
    kept = []
    for raw in data.decode("utf-8", errors="strict").splitlines(keepends=True):
        fields = raw.split()
        if fields and not fields[0].startswith("#") and fields[0] == tenant:
            continue
        kept.append(raw)
    return "".join(kept).encode("utf-8")


def write_identity_file(identity_dir: str, tenant: str, identity: bytes, ledger: "Ledger") -> str:
    """Exclusive 0600 temp outside the drill's glob, then a hard link to the
    final name, which fails rather than overwrite, then the temp is removed."""
    tmp = identity_tmp_path(identity_dir, tenant)
    final = identity_path(identity_dir, tenant)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    ledger.identity_tmp = tmp
    with os.fdopen(fd, "wb") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(identity)
        handle.flush()
        os.fsync(handle.fileno())
    os.link(tmp, final)
    ledger.identity_file = final
    os.unlink(tmp)
    ledger.identity_tmp = None
    _fsync_directory(identity_dir)
    return final


def read_back_identity_file(path: str, identity: bytes) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        data = b""
        while chunk := os.read(fd, 65536):
            data += chunk
    finally:
        os.close(fd)
    if stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid():
        raise Refusal("the identity file read back with the wrong owner or mode")
    if not hmac.compare_digest(data, identity):
        raise Refusal("the identity file read back with different bytes")


@dataclasses.dataclass
class Ledger:
    """What this run created, so a failure can remove exactly that."""

    spare_key: str | None = None
    identity_tmp: str | None = None
    identity_file: str | None = None
    tenants_before: Snapshot | None = None
    recipients_before: Snapshot | None = None


def roll_back(ledger: Ledger, store: SpareStore) -> list[str]:
    """Undoes the ledger, lists first so no recipient outlives its keys.
    Returns what could not be undone."""
    leftovers: list[str] = []
    for before, name in ((ledger.tenants_before, "the tenants file"), (ledger.recipients_before, "the recipients file")):
        if before is not None:
            try:
                replace_atomically(before.path, before.data, before.info)
            except Exception:  # noqa: BLE001 -- every undo is attempted, each failure is named
                leftovers.append(f"{name} may still list the tenant")
    for path in (ledger.identity_tmp, ledger.identity_file):
        if path is not None:
            try:
                pathlib.Path(path).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                leftovers.append(f"identity file {os.path.basename(path)}")
    if ledger.spare_key is not None:
        try:
            store.delete(ledger.spare_key)
        except Exception:  # noqa: BLE001
            leftovers.append(f"spare object {ledger.spare_key}")
    return leftovers


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------


def default_keygen(run: Runner) -> bytes:
    """`age-keygen` writes the identity to a pipe held in memory."""
    result = run(["age-keygen"], capture_output=True, check=False)
    if result.returncode != 0:
        raise Refusal(f"age-keygen failed (exit {result.returncode})")
    return result.stdout


def public_half(identity: bytes, run: Runner) -> str:
    """The recipient, derived over stdin and required to agree with the
    identity's own `# public key:` comment."""
    if len(_SECRET_KEY_LINE.findall(identity)) != 1:
        raise Refusal("age-keygen did not produce exactly one identity")
    result = run(["age-keygen", "-y"], input=identity, capture_output=True, check=False)
    if result.returncode != 0:
        raise Refusal(f"age-keygen -y failed (exit {result.returncode})")
    recipient = result.stdout.decode("utf-8", errors="replace").strip()
    comment = _PUBLIC_KEY_COMMENT.search(identity)
    if comment is None or comment.group(1).decode("ascii") != recipient:
        raise Refusal("the recipient derived from the identity does not match its own public key comment")
    return recipient


def wrap_for_spare(identity: bytes, wrapping_recipient: str, run: Runner) -> bytes:
    try:
        ciphertext = mbr.encrypt_with_age(data=identity, recipient=wrapping_recipient, run=run)
    except mbr.MediaBackupError:
        raise Refusal("age refused to wrap the spare") from None
    if mbr.count_age_recipient_stanzas(ciphertext) != 1 or b"AGE-SECRET-KEY-" in ciphertext:
        raise Refusal("the wrapped spare is not a single-recipient age ciphertext")
    return ciphertext


def put_spare_and_read_back(store: SpareStore, key: str, ciphertext: bytes, ledger: Ledger) -> None:
    ledger.spare_key = key
    store.put(key, ciphertext)
    stored = store.get(key)
    if not hmac.compare_digest(stored, ciphertext):
        raise Refusal("the spare read back with different bytes")
    try:
        rd.check_single_recipient(stored, "the spare")
    except rd.RecipientAuditError as exc:
        raise Refusal(str(exc)) from None


# ---------------------------------------------------------------------------
# First dump
# ---------------------------------------------------------------------------


def systemctl_start_first_dump(tenant: str, run: Runner) -> int:
    """Starts the templated oneshot unit, which runs the dump as the service
    account in its own runtime directory, and waits for it to finish."""
    unit = FIRST_DUMP_UNIT.format(tenant=tenant)
    result = run(["systemctl", "start", "--wait", unit], capture_output=True, check=False, timeout=FIRST_DUMP_TIMEOUT_S)
    return result.returncode


def nightly_is_busy(run: Runner) -> bool:
    result = run(["systemctl", "is-active", NIGHTLY_UNIT], capture_output=True, check=False)
    return result.stdout.decode("utf-8", errors="replace").strip() in BUSY_STATES


def list_dump_keys(reader: DumpReader, copies: Sequence[rd.DrillCopy], tenant: str) -> dict[str, set[str]]:
    return {copy.name: set(reader.list(copy, rd.tenant_prefix(copy, tenant))) for copy in copies}


def newest_new_dump(copy: rd.DrillCopy, tenant: str, before: set[str], after: set[str]) -> str | None:
    prefix = rd.tenant_prefix(copy, tenant)
    fresh = [
        key for key in after - before if key.startswith(prefix) and rd.OBJECT_NAME.match(key[len(prefix) :])
    ]
    return max(fresh) if fresh else None


def verify_dump(
    *,
    data: bytes,
    what: str,
    tenant: str,
    identity_dir: str,
    run: Runner,
) -> None:
    """One stanza; the tenant's own identity opens it; no other identity in
    the directory does. Raises Refusal(EXIT_WRONG_KEY) otherwise."""
    try:
        rd.check_single_recipient(data, what)
    except rd.RecipientAuditError as exc:
        raise Refusal(str(exc), EXIT_WRONG_KEY) from None
    own = identity_path(identity_dir, tenant)
    opened = run(["age", "-d", "-i", own, "-o", os.devnull], input=data, capture_output=True, check=False)
    if opened.returncode != 0:
        raise Refusal(f"{what} does not open with the tenant's own identity", EXIT_WRONG_KEY)
    own_name = os.path.basename(own)
    others = sorted(
        path
        for path in pathlib.Path(identity_dir).glob(f"*{rd.IDENTITY_SUFFIX}")
        if path.is_file() and path.name != own_name
    )
    for other in others:
        attempt = run(["age", "-d", "-i", str(other), "-o", os.devnull], input=data, capture_output=True, check=False)
        if attempt.returncode == 0:
            raise Refusal(f"{what} also opens with the identity of {other.stem}", EXIT_WRONG_KEY)
        if rd.NO_IDENTITY_MATCHED not in attempt.stderr.decode("utf-8", errors="replace"):
            raise Refusal(f"could not prove that the identity of {other.stem} does not open {what}", EXIT_WRONG_KEY)


def retract_listing(paths: Paths, tenant: str) -> list[str]:
    """Removes the tenant's lines from both lists; keeps both key copies."""
    leftovers = []
    for path, name in ((paths.recipients_file, "recipients file"), (paths.tenants_file, "tenants file")):
        try:
            current = snapshot(path, what=name)
            replace_atomically(path, without_tenant(current.data, tenant), current.info)
        except Exception:  # noqa: BLE001 -- each file is attempted, each failure named
            leftovers.append(f"the {name} may still list the tenant")
    return leftovers


def first_dump_and_verify(
    *,
    tenant: str,
    paths: Paths,
    copies: Sequence[rd.DrillCopy],
    reader: DumpReader,
    run: Runner,
    start_dump: Callable[[str], int],
) -> int:
    before = list_dump_keys(reader, copies, tenant)
    if nightly_is_busy(run):
        _alert(f"{tenant} is enrolled but its first dump is deferred: the nightly run is active and will dump it")
        return EXIT_FIRST_DUMP
    timed_out = False
    try:
        unit_exit = start_dump(tenant)
    except subprocess.TimeoutExpired:
        timed_out = True
        unit_exit = None
    after = list_dump_keys(reader, copies, tenant)

    fresh: list[tuple[rd.DrillCopy, str]] = []
    for copy in copies:
        key = newest_new_dump(copy, tenant, before[copy.name], after[copy.name])
        if key is not None:
            fresh.append((copy, key))
    for copy, key in fresh:
        what = f"{copy.name}:{key}"
        try:
            verify_dump(data=reader.get(copy, key), what=what, tenant=tenant, identity_dir=paths.identity_dir, run=run)
        except Refusal as exc:
            if exc.code != EXIT_WRONG_KEY:
                raise
            leftovers = retract_listing(paths, tenant)
            if leftovers:
                raise RollbackIncomplete(f"{exc}; retracting the listing also failed: {', '.join(leftovers)}") from None
            _alert(f"{exc}; {tenant} is no longer listed, both key copies are kept, nothing will dump it until resolved")
            return EXIT_WRONG_KEY

    if timed_out:
        _alert(f"{tenant} is enrolled but its first dump timed out; the nightly run will retry")
        return EXIT_FIRST_DUMP
    if unit_exit != 0:
        _alert(f"{tenant} is enrolled but its first dump unit failed (exit {unit_exit}); the nightly run will retry")
        return EXIT_FIRST_DUMP
    missing = [copy.name for copy in copies if copy.name not in {c.name for c, _ in fresh}]
    if missing:
        _alert(f"{tenant} is enrolled but no new dump appeared on {', '.join(missing)}; the nightly run will retry")
        return EXIT_FIRST_DUMP
    for copy, key in fresh:
        _say(f"first dump {copy.name}:{key} opens with the tenant's own key and with no other identity")
    return EXIT_OK


# ---------------------------------------------------------------------------
# The enrolment
# ---------------------------------------------------------------------------


class _EnrolLock:
    """Non-blocking and exclusive: a second enrolment is refused, not queued."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._fd: int | None = None

    def __enter__(self) -> "_EnrolLock":
        try:
            fd = os.open(self._path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except OSError as exc:
            raise Refusal(f"the enrolment lock cannot be opened: {exc.strerror}; nothing changed") from None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise Refusal("another enrolment is running; nothing changed") from None
        self._fd = fd
        return self

    def __exit__(self, *exc_info: object) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None


def _enrol(
    *,
    tenant: str,
    tenant_config: str,
    paths: Paths,
    euid: int,
    owner_uid: int,
    group_gid: int | None,
    store: SpareStore | None,
    keygen: Callable[[], bytes] | None,
    run: Runner,
    start_dump: Callable[[str], int] | None,
    dump_reader: DumpReader | None,
) -> int:
    # 1. Root, and a slug the shared rule accepts.
    if euid != 0:
        raise Refusal("must run as root; nothing changed")
    try:
        bw.validate_tenant_name(tenant)
    except bw.InvalidTenantName as exc:
        raise Refusal(f"{exc}; nothing changed") from None

    with _EnrolLock(paths.lock_path):
        # 2. The slug is the one in the tenant's own configuration.
        _, raw_stack = _read_regular_file(tenant_config, what="the tenant configuration")
        configured = stack_slug(raw_stack)
        try:
            bw.validate_tenant_name(configured)
        except bw.InvalidTenantName:
            raise Refusal("the slug in the tenant configuration is not a valid tenant name; nothing changed") from None
        if configured != tenant:
            raise Refusal("the slug in the tenant configuration is not the one asked for; nothing changed")

        # 3. Configuration, the lists, the pinned wrapping recipient.
        spare = load_spare_config(paths.spare_config, owner_uid=owner_uid)
        worker_env = read_env_file(paths.worker_env, owner_uid=owner_uid, what="the worker environment")
        drill_env = read_env_file(paths.drill_env, owner_uid=owner_uid, what="the restore drill environment")
        try:
            copies = rd.copies_from_env(drill_env)
        except rd.DrillConfigError as exc:
            raise Refusal(f"{exc}; nothing changed") from None
        check_identity_dir(paths.identity_dir, owner_uid=owner_uid)

        current_recipients = snapshot(paths.recipients_file, what="the recipients file")
        current_tenants = snapshot(paths.tenants_file, what="the tenants file")
        try:
            recipients = br.parse_recipients(current_recipients.data.decode("utf-8", errors="replace"))
        except br.RecipientError as exc:
            raise Refusal(f"the recipients file is not usable: {exc}; nothing changed") from None
        listed = tenant_names(current_tenants.data)
        problems = list_file_problems(paths, owner_uid=owner_uid, group_gid=group_gid, tenants=[])
        if problems:
            raise Refusal(f"{'; '.join(problems)}; nothing changed")

        check_wrapping_recipient(spare, recipients)
        dump_copies = worker_copy_identities(worker_env)
        dump_copies += [CopyIdentity(f"drill {copy.name}", copy.bucket, copy.access_key) for copy in copies]
        refuse_if_spare_is_a_dump_copy(spare, dump_copies)

        reader = dump_reader if dump_reader is not None else rd.ObjectStore()
        try:
            list_dump_keys(reader, copies, tenant)
        except Exception as exc:  # noqa: BLE001 -- the credential is probed before any key exists
            raise Refusal(
                f"the drill credential cannot list the dump copies ({type(exc).__name__}); nothing changed"
            ) from None

        spare_store = store if store is not None else S3SpareStore(spare)

        # 4. What is already there.
        state = classify(tenant, paths=paths, store=spare_store, recipients=recipients, tenants=listed)
        if state.complete:
            _say(f"{tenant} is already enrolled; nothing changed")
            return EXIT_OK
        if not state.nothing:
            raise Refusal(
                f"{tenant} is half enrolled: present are {', '.join(state.present())}; "
                "refusing to repair or overwrite by guessing; nothing changed",
                EXIT_HALF_ENROLLED,
            )

        # 5-9. Mint and place the key. Anything that fails here undoes this run.
        ledger = Ledger()
        recipient = ""
        try:
            identity = keygen() if keygen is not None else default_keygen(run)
            recipient = public_half(identity, run)

            spare_ciphertext = wrap_for_spare(identity, spare.wrapping_recipient, run)
            put_spare_and_read_back(spare_store, spare_key_for(tenant), spare_ciphertext, ledger)

            final = write_identity_file(paths.identity_dir, tenant, identity, ledger)
            read_back_identity_file(final, identity)

            new_recipients = with_line(current_recipients.data, f"{tenant} {recipient}")
            try:
                parsed = br.parse_recipients(new_recipients.decode("utf-8"))
            except br.RecipientError as exc:
                raise Refusal(f"the recipients file would not be valid: {exc}") from None
            if parsed.get(tenant) != recipient:
                raise Refusal("the recipients file would not list the new recipient")
            new_tenants = with_line(current_tenants.data, tenant)

            ledger.recipients_before = current_recipients
            replace_atomically(paths.recipients_file, new_recipients, current_recipients.info)
            ledger.tenants_before = current_tenants
            replace_atomically(paths.tenants_file, new_tenants, current_tenants.info)

            after_recipients = br.load_recipients(paths.recipients_file)
            if after_recipients.get(tenant) != recipient:
                raise Refusal("the recipients file read back without the new recipient")
            after_tenants = tenant_names(snapshot(paths.tenants_file, what="the tenants file").data)
            if tenant not in after_tenants:
                raise Refusal("the tenants file read back without the tenant")
            problems = list_file_problems(paths, owner_uid=owner_uid, group_gid=group_gid, tenants=after_tenants)
            if problems:
                raise Refusal("; ".join(problems))
        except Exception as exc:
            leftovers = roll_back(ledger, spare_store)
            if leftovers:
                raise RollbackIncomplete(
                    f"rollback incomplete after a failed enrolment; leftover: {'; '.join(leftovers)}"
                ) from None
            if isinstance(exc, Refusal):
                raise Refusal(f"{exc}; nothing changed", exc.code) from None
            raise

        _say(f"{tenant}: key placed in the spare store and the identity directory, and listed for the backup worker")

        # 10. First dump, as the service account, then check it.
        try:
            return first_dump_and_verify(
                tenant=tenant,
                paths=paths,
                copies=copies,
                reader=reader,
                run=run,
                start_dump=start_dump or (lambda name: systemctl_start_first_dump(name, run)),
            )
        except RollbackIncomplete:
            raise
        except Refusal as exc:
            _alert(f"{tenant} is enrolled but its first dump could not be checked: {exc}")
            return EXIT_FIRST_DUMP
        except Exception as exc:  # noqa: BLE001 -- the tenant stays enrolled; the class is enough to start from
            _alert(
                f"{tenant} is enrolled but its first dump could not be checked ({type(exc).__name__}); "
                "the nightly run will retry"
            )
            return EXIT_FIRST_DUMP


def enrol(
    *,
    tenant: str,
    tenant_config: str,
    paths: Paths | None = None,
    euid: int | None = None,
    owner_uid: int = 0,
    group_gid: Callable[[], int | None] = ibw._service_gid,
    store: SpareStore | None = None,
    keygen: Callable[[], bytes] | None = None,
    runner: Runner = subprocess.run,
    start_dump: Callable[[str], int] | None = None,
    dump_reader: DumpReader | None = None,
) -> int:
    """The whole enrolment; returns the exit code. The keyword arguments after
    `paths` are the seams CI uses to run it without root, a bucket or systemd."""
    run = make_run(runner)
    try:
        return _enrol(
            tenant=tenant,
            tenant_config=tenant_config,
            paths=paths or Paths(),
            euid=os.geteuid() if euid is None else euid,
            owner_uid=owner_uid,
            group_gid=group_gid(),
            store=store,
            keygen=keygen,
            run=run,
            start_dump=start_dump,
            dump_reader=dump_reader,
        )
    except RollbackIncomplete as exc:
        _alert(str(exc))
        return exc.code
    except Refusal as exc:
        print(f"enrol_tenant_backup: refused: {exc}", file=sys.stderr)
        return exc.code
    except Exception as exc:  # noqa: BLE001 -- the class name only: a message could carry key material
        print(
            f"enrol_tenant_backup: failed unexpectedly ({type(exc).__name__}); anything this run created was removed",
            file=sys.stderr,
        )
        return EXIT_REFUSED


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tenant", required=True, help="the tenant slug")
    parser.add_argument("--tenant-config", required=True, help="the tenant's own stack file, which names its slug")
    parser.add_argument("--spare-config", default=DEFAULT_SPARE_CONFIG)
    parser.add_argument("--worker-env-file", default=DEFAULT_WORKER_ENV)
    parser.add_argument("--drill-env-file", default=DEFAULT_DRILL_ENV)
    parser.add_argument("--tenants-file", default=DEFAULT_TENANTS_FILE)
    parser.add_argument("--recipients-file", default=DEFAULT_RECIPIENTS_FILE)
    parser.add_argument("--identity-dir", default=DEFAULT_IDENTITY_DIR)
    parser.add_argument("--lock-path", default=DEFAULT_LOCK_PATH)
    args = parser.parse_args(argv)
    paths = Paths(
        spare_config=args.spare_config,
        worker_env=args.worker_env_file,
        drill_env=args.drill_env_file,
        tenants_file=args.tenants_file,
        recipients_file=args.recipients_file,
        identity_dir=args.identity_dir,
        lock_path=args.lock_path,
    )
    return enrol(tenant=args.tenant, tenant_config=args.tenant_config, paths=paths)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
