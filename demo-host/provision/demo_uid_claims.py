#!/usr/bin/env python3
"""Records the demo host's seven fixed slot uids in the tenant uid register.

Run by hand at demo-host build, as root, before any slot account or unit is
created. Runs alone: it imports nothing from this repository, so one file
copied to the host is the whole install. See demo_uid_claims.md for why the
demo host writes into the same register a tenant's volume provisioning
reads, and what each refusal means.

Exit 0 on success, 1 on any refusal or failure.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import stat
import sys
from typing import Callable, Iterable, Sequence

# The slot table and uid base, duplicated from `render_slot_sudoers.py` and
# `branchleft_slot.py` so this file needs nothing beside it on the host.
# `test_demo_uid_claims.py` imports both and fails if either copy drifts.
UID_BASE = 30001
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))

PASSWD_PATH = "/etc/passwd"

# Mirrors `app/provision/provision_tenant_volume.py`'s register. Duplicated
# rather than imported, for the same reason as the slot table above.
# `test_demo_uid_claims.py` imports the tenant-side module and fails if either
# copy drifts from the other.
CLAIM_DIR = "/etc/branchleft/tenant-uids"
CLAIM_DIR_MODE = 0o700
CLAIM_MODE = 0o600
TENANT_UID_MIN = 30000
TENANT_UID_MAX = 30999


class ClaimError(Exception):
    """Raised for anything the register's integrity depends on refusing.
    Never masked: a demo host built over a register it could not read is a
    host whose uids another allocation can silently reuse."""


def claim_slug(slot: str) -> str:
    return f"demo-{slot}"


def slot_uid(slot: str) -> int:
    return UID_BASE + int(slot)


def render_claim(slug: str, uid: int) -> str:
    return f"slug={slug}\nuid={uid}\n"


def parse_claim(text: str) -> tuple[str, int]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise ClaimError(f"malformed claim line: {line!r}")
        fields[key.strip()] = value.strip()
    if "slug" not in fields or "uid" not in fields:
        raise ClaimError(f"claim is missing slug or uid: {text!r}")
    try:
        return fields["slug"], int(fields["uid"])
    except ValueError as exc:
        raise ClaimError(f"claim uid is not an integer: {fields['uid']!r}") from exc


def ensure_claim_dir(path: str, *, owner_uid: int) -> None:
    """Creates the register directory root-owned 0700, or verifies an
    existing one already is. A directory someone else can write to is a
    register whose claims that someone can delete, so a wrong shape is
    refused rather than quietly corrected under existing claims."""
    try:
        os.mkdir(path, CLAIM_DIR_MODE)
        os.chmod(path, CLAIM_DIR_MODE)
    except FileExistsError:
        pass
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise ClaimError(f"{path} exists and is not a directory")
    if st.st_uid != owner_uid:
        raise ClaimError(f"{path} is owned by uid {st.st_uid}, expected {owner_uid}")
    if stat.S_IMODE(st.st_mode) != CLAIM_DIR_MODE:
        raise ClaimError(
            f"{path} has mode {oct(stat.S_IMODE(st.st_mode))}, expected {oct(CLAIM_DIR_MODE)}"
        )


def read_passwd_uids(path: str = PASSWD_PATH) -> set[int]:
    """Every uid the host's passwd file already assigns. Read from the file,
    not through NSS, so the answer is the local account database and nothing
    a network directory could change underneath the run. A line that cannot
    be read as an entry aborts: an unparsed account is an unchecked uid."""
    uids: set[int] = set()
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            fields = line.rstrip("\n").split(":")
            if len(fields) < 3:
                raise ClaimError(f"{path} line {number} is not a passwd entry")
            try:
                uids.add(int(fields[2]))
            except ValueError as exc:
                raise ClaimError(f"{path} line {number} has a non-numeric uid") from exc
    return uids


def clear_stale_temp(path: str, slug: str, *, owner_uid: int) -> bool:
    """Removes the temporary file a crashed run left for one of this
    script's own slugs. Only called under the register lock, so nothing else
    of ours is writing it. Anything that is not a plain file owned by the
    register's owner is refused instead: a symlink or foreign file under a
    name only this script writes is evidence of something else at work."""
    tmp = os.path.join(path, f"{slug}.tmp")
    try:
        st = os.lstat(tmp)
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(st.st_mode) or st.st_uid != owner_uid:
        raise ClaimError(f"{tmp} is not a regular file owned by uid {owner_uid}; remove it by hand")
    os.unlink(tmp)
    return True


def lock_register(path: str) -> int:
    """Takes an exclusive, non-blocking lock on the register directory and
    returns the descriptor that holds it; closing that descriptor releases
    it. The lock sits on the directory itself because any file added to the
    register would be read as a claim. A second concurrent run is refused
    rather than queued: the check-then-write below is only sound serially."""
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        raise ClaimError(f"another run holds the lock on {path}; refusing to run alongside it") from exc
    return fd


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_register(path: str) -> dict[str, int]:
    """Every claim in the register, keyed by slug. Any entry that cannot be
    read, or whose filename disagrees with its own slug, aborts the run."""
    claims: dict[str, int] = {}
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        try:
            fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as exc:
            raise ClaimError(f"claim {full!r} is unreadable ({exc})") from exc
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ClaimError(f"claim {full!r} is not a regular file")
            with os.fdopen(fd, "r", closefd=False) as handle:
                slug, uid = parse_claim(handle.read())
        finally:
            os.close(fd)
        if slug != name:
            raise ClaimError(
                f"claim file {name!r} names slug {slug!r}; the register was edited by hand"
            )
        claims[slug] = uid
    return claims


def _write_new(path: str, content: str) -> None:
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, CLAIM_MODE)
    try:
        os.fchmod(fd, CLAIM_MODE)
        os.write(fd, content.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path))


def record_demo_claims(
    claim_dir: str = CLAIM_DIR,
    slots: Sequence[str] = SLOT_NAMES,
    *,
    owner_uid: int = 0,
    passwd_uids: Callable[[], Iterable[int]] = read_passwd_uids,
    log: Callable[[str], None] = lambda message: None,
) -> list[str]:
    """Idempotent. Returns the slugs newly claimed. Refuses, writing
    nothing, when any wanted uid is outside the tenant range, claimed by a
    different slug, or when a demo slug is already claimed at another uid;
    when a slug it would newly claim has a uid the host's passwd already
    assigns; or when another run holds the register lock. A temporary file
    left by a crashed run, for one of this script's own slugs, is removed
    and reported through `log`."""
    wanted = {claim_slug(slot): slot_uid(slot) for slot in slots}
    for slug, uid in wanted.items():
        if not TENANT_UID_MIN <= uid <= TENANT_UID_MAX:
            raise ClaimError(
                f"uid {uid} for {slug} is outside the reserved range "
                f"{TENANT_UID_MIN}-{TENANT_UID_MAX}"
            )

    ensure_claim_dir(claim_dir, owner_uid=owner_uid)
    lock_fd = lock_register(claim_dir)
    try:
        for slug in wanted:
            if clear_stale_temp(claim_dir, slug, owner_uid=owner_uid):
                log(f"removed stale {slug}.tmp left by an interrupted run")
        existing = read_register(claim_dir)

        holders = {uid: slug for slug, uid in existing.items()}
        for slug, uid in wanted.items():
            if slug in existing and existing[slug] != uid:
                raise ClaimError(
                    f"{slug} is already claimed at uid {existing[slug]}, not {uid}; "
                    "changing a uid on a provisioned slot is a migration, not an update"
                )
            holder = holders.get(uid)
            if holder is not None and holder != slug:
                raise ClaimError(f"uid {uid} is already claimed by {holder!r}")

        # A slug already in the register is not re-checked: its slot account
        # is expected to exist by then. A new claim over a uid some other
        # account already has would make that account the slot's owner.
        taken = set(passwd_uids())
        for slug, uid in wanted.items():
            if slug not in existing and uid in taken:
                raise ClaimError(
                    f"uid {uid} for {slug} already belongs to an account on this host"
                )

        created: list[str] = []
        for slug, uid in wanted.items():
            if slug in existing:
                continue
            _write_new(os.path.join(claim_dir, slug), render_claim(slug, uid))
            created.append(slug)
        return created
    finally:
        os.close(lock_fd)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claim-dir", default=CLAIM_DIR)
    args = parser.parse_args(argv)
    try:
        created = record_demo_claims(
            args.claim_dir, log=lambda message: print(message, file=sys.stderr)
        )
    except (ClaimError, OSError) as exc:
        print(f"demo_uid_claims: {exc}", file=sys.stderr)
        return 1
    print(f"recorded {len(created)} new claim(s) in {args.claim_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
