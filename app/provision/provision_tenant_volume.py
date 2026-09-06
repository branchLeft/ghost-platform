#!/usr/bin/env python3
"""Idempotent create of one tenant's Docker volumes, owned by its own UID.

Run by hand on the app host itself (as root, once per tenant onboarded, before
that tenant's `branchleft-compose@<slug>` unit is enabled):

    provision_tenant_volume.py --uid 30001 blog

The app-host analogue of `db/provision/provision_tenant_db.py`, and the one
step in the tenant path whose absence is invisible at runtime. Everything else
in the runtime posture announces a mistake: a wrong capability set crashes the
boot, a missing writable path fails an upload. This one does not. Without it a
tenant container still starts, still serves, and still runs as its own UID --
on a volume Docker seeded from the image, which the official Ghost image
leaves world-writable (`chmod 1777` on the content directory, because it is
built for one site per host). Every co-tenant UID on the host can then read and
write that tenant's content the moment anything escapes its mount namespace.

Three mechanics this script exists to get right, none of them discoverable
late:

1. **Docker re-applies the image path's ownership and mode to a volume it
   populates itself.** Ownership asserted before a first start is silently
   overwritten by that copy-up, which fires on any *empty* volume. So this
   script drops a seed file in the content volume: a non-empty volume is never
   copied into, the image's `1777` never lands, and Ghost's own entrypoint
   still seeds `content.orig` afterwards -- it tests each sub-path
   individually (`[ ! -e "$target" ]`), not the directory as a whole. Declaring
   the volumes `external` in the rendered stack is a separate control and only
   stops Compose *creating* one; it does nothing about copy-up.

2. **The UID register lives where the tenant cannot write.** `/etc/branchleft/
   tenant-uids/<slug>`, root-owned `0700` directory, `0600` files. It is not in
   the content volume, because unlink permission is governed by the containing
   directory rather than the file mode, and that volume is `0700` owned by the
   tenant -- a claim stored there is a claim its own subject can delete, and a
   deleted claim reads as "unclaimed", which never compares equal to a real
   UID. The register is cross-checked against the volumes Docker holds, and a
   volume with no register entry is a refusal rather than a free UID.

3. **A UID change on a provisioned volume is a data loss, not an update.** The
   content is `0700` to the old UID; re-owning it under a different tenant
   hands one tenant another's data, and re-owning it under the same tenant with
   a new number is a migration with a copy step. Either way it is refused here
   rather than performed silently.

**Residual, stated rather than implied.** A tenant can delete the seed file in
its own volume -- it owns that directory -- which re-arms copy-up on that one
volume and would restore the image's world-writable mode there at the next
start. It cannot free a UID, cannot reach another tenant's volume, and cannot
touch the register. Closing the remainder needs a change to the ownership shape
the runtime posture records, which is a decision rather than a fix.

Exit 0 on success, 1 on any refusal or failure, 2 on usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# Mirrors `infra/tenant/naming.ts`. Both sides derive these names; neither
# reconstructs Compose's `<project>_<volume>` prefixing, which is why the
# rendered stack declares its volumes `external` with explicit names.
VOLUME_NAME_PREFIX = "ghost-"
CONTENT_VOLUME_SUFFIX = "-content"
ADAPTERS_VOLUME_SUFFIX = "-adapters"

# Mirrors `infra/tenant/runtime.ts`.
TENANT_UID_MIN = 30000
TENANT_UID_MAX = 30999

# Mirrors `infra/tenant/naming.ts`'s slug rules, including the reserved names:
# a tenant slugged `website` would collide with the marketing site's stack.
SLUG_PATTERN = re.compile(r"\A[a-z][a-z0-9-]*\Z")
MAX_SLUG_LENGTH = 26
RESERVED_STACK_NAMES = ("website", "edge", "db", "monitoring")

# The UID register: one file per tenant, in a root-owned 0700 directory on the
# host. Deliberately NOT inside the tenant's content volume, which an earlier
# form of this script used.
#
# Unlink permission is governed by the containing directory, not the file's own
# mode, and the content volume is 0700 *owned by the tenant* -- so a claim
# stored there is a claim the tenant can delete. That is not a theoretical
# reach: deleting it makes this script read the slug as unclaimed, and a
# missing claim never compares equal to a real UID, so the next tenant
# provisioned on that number would have been accepted onto it. The register
# has to sit where the subject of the check cannot write.
CLAIM_DIR = "/etc/branchleft/tenant-uids"
CLAIM_DIR_MODE = 0o700
CLAIM_MODE = 0o600

# Written inside the content volume, and doing one job only: keeping the volume
# non-empty so Docker's copy-up never populates it from the image path and
# re-applies that path's `node:node` 1777 over the ownership set below. It is
# not a security record -- the tenant owns the directory it sits in and can
# delete it, which re-arms copy-up on that tenant's own volume. That residual
# is real and is tracked; what it can no longer do is free a UID.
SEED_FILE = ".branchleft-seed"

CONTENT_MODE = 0o700
# Read-only for the tenant and unwritable by anyone but root. The rendered
# stack also mounts it `:ro`; this is the half that still holds if that mount
# option is ever lost.
ADAPTERS_MODE = 0o555


class ProvisionError(Exception):
    """Raised for anything a caller could have avoided, or that the host refused."""


def content_volume_name(slug: str) -> str:
    return f"{VOLUME_NAME_PREFIX}{slug}{CONTENT_VOLUME_SUFFIX}"


def adapters_volume_name(slug: str) -> str:
    return f"{VOLUME_NAME_PREFIX}{slug}{ADAPTERS_VOLUME_SUFFIX}"


def validate_slug(slug: str) -> None:
    if not SLUG_PATTERN.match(slug):
        raise ProvisionError(
            f"tenant slug {slug!r} must start with a lowercase letter and contain only "
            "lowercase letters, digits and hyphens"
        )
    if len(slug) > MAX_SLUG_LENGTH:
        raise ProvisionError(
            f"tenant slug {slug!r} is {len(slug)} characters; must be at most {MAX_SLUG_LENGTH}"
        )
    if slug in RESERVED_STACK_NAMES:
        raise ProvisionError(
            f"tenant slug {slug!r} is reserved for a non-tenant stack on this host "
            f"({', '.join(RESERVED_STACK_NAMES)})"
        )


def validate_uid(uid: int) -> None:
    if not TENANT_UID_MIN <= uid <= TENANT_UID_MAX:
        raise ProvisionError(
            f"uid {uid} is outside the reserved tenant range {TENANT_UID_MIN}-{TENANT_UID_MAX}"
        )


def claim_path(slug: str, claim_dir: str = CLAIM_DIR) -> str:
    return os.path.join(claim_dir, slug)


def render_claim(slug: str, uid: int) -> str:
    return f"slug={slug}\nuid={uid}\n"


def parse_claim(text: str) -> tuple[str, int]:
    """Return (slug, uid) from a claim file, raising on anything unreadable.

    Refuses rather than guessing: a claim file that cannot be parsed means the
    host's UID allocation cannot be established, and continuing would risk
    handing one tenant another's volume.
    """
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise ProvisionError(f"malformed claim line: {line!r}")
        fields[key.strip()] = value.strip()
    if "slug" not in fields or "uid" not in fields:
        raise ProvisionError(f"claim is missing slug or uid: {text!r}")
    try:
        uid = int(fields["uid"])
    except ValueError as exc:
        raise ProvisionError(f"claim uid is not an integer: {fields['uid']!r}") from exc
    return fields["slug"], uid


def _docker(args: list[str], *, run=subprocess.run) -> str:
    result = run(
        ["docker", *args], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise ProvisionError(f"docker {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def list_content_volumes(*, run=subprocess.run) -> list[str]:
    out = _docker(["volume", "ls", "--quiet"], run=run)
    return [
        name
        for name in (line.strip() for line in out.splitlines())
        if name.startswith(VOLUME_NAME_PREFIX) and name.endswith(CONTENT_VOLUME_SUFFIX)
    ]


def volume_mountpoint(name: str, *, run=subprocess.run) -> str:
    out = _docker(["volume", "inspect", name, "--format", "{{json .Mountpoint}}"], run=run)
    mountpoint = json.loads(out.strip())
    if not isinstance(mountpoint, str) or not mountpoint:
        raise ProvisionError(f"volume {name} reports no mountpoint")
    return mountpoint


def volume_exists(name: str, *, run=subprocess.run) -> bool:
    out = _docker(["volume", "ls", "--quiet", "--filter", f"name=^{name}$"], run=run)
    return name in [line.strip() for line in out.splitlines()]


def slug_from_content_volume(volume: str) -> str:
    return volume[len(VOLUME_NAME_PREFIX) : -len(CONTENT_VOLUME_SUFFIX)]


def existing_claims(*, run=subprocess.run, claim_dir: str = CLAIM_DIR, fs=None) -> dict[str, int]:
    """Every UID claimed on this host, keyed by tenant slug.

    Read from the root-owned register, then cross-checked against the volumes
    Docker actually holds. Either source alone fails open in its own direction:
    the register alone cannot see a tenant provisioned before it existed, and
    the volumes alone are inside a directory the tenant owns. A content volume
    with no register entry raises rather than being reported as free, because
    "I could not establish this UID" and "this UID is available" must never
    share a return value.
    """
    fs = fs or _RealFs()

    claims: dict[str, int] = {}
    for name in sorted(fs.listdir(claim_dir)):
        try:
            claimed_slug, uid = parse_claim(fs.read_text(os.path.join(claim_dir, name)))
        except (OSError, ProvisionError) as exc:
            raise ProvisionError(
                f"claim {os.path.join(claim_dir, name)!r} is unreadable ({exc}). The host's UID "
                "allocation cannot be established, and provisioning a tenant against an unknown "
                "allocation could hand two tenants the same UID. Restore it by hand."
            ) from exc
        if claimed_slug != name:
            raise ProvisionError(
                f"claim file {name!r} names slug {claimed_slug!r}. A claim and its filename "
                "disagreeing means the register was edited by hand; reconcile it before "
                "provisioning anything."
            )
        claims[claimed_slug] = uid

    for volume in list_content_volumes(run=run):
        slug = slug_from_content_volume(volume)
        if slug not in claims:
            raise ProvisionError(
                f"volume {volume!r} exists on this host but has no entry in {claim_dir}. The UID "
                "it was provisioned with cannot be established from the register. Read the "
                "volume's ownership on the host (`docker volume inspect` then `stat`) and write "
                "the claim by hand before provisioning anything else."
            )
    return claims


def assert_uid_available(slug: str, uid: int, claims: dict[str, int]) -> None:
    for other_slug, other_uid in claims.items():
        if other_slug == slug:
            continue
        if other_uid == uid:
            raise ProvisionError(
                f"uid {uid} is already claimed on this host by tenant {other_slug!r}. "
                "Tenant UIDs are distinct per host and are never reused -- allocate a free one."
            )
    existing = claims.get(slug)
    if existing is not None and existing != uid:
        raise ProvisionError(
            f"tenant {slug!r} already holds uid {existing} on this host, not {uid}. "
            "Its content volume is mode 0700 to that uid, so changing the number here would "
            "lock the tenant out of its own data; a uid change is a migration with a copy "
            "step, not a re-run of this script."
        )


class _RealFs:
    """The filesystem operations this script performs, in one injectable place.

    `write_text` opens with `O_NOFOLLOW`: the seed file is created inside a
    directory the tenant owns, so a symlink planted at that path would
    otherwise be followed by a root-run write.
    """

    def listdir(self, path: str) -> list[str]:
        try:
            return os.listdir(path)
        except FileNotFoundError:
            return []

    def read_text(self, path: str) -> str:
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def write_text(self, path: str, text: str, mode: int) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
        fd = os.open(path, flags, mode)
        try:
            os.write(fd, text.encode("utf-8"))
        finally:
            os.close(fd)

    def makedirs(self, path: str, mode: int) -> None:
        os.makedirs(path, mode=mode, exist_ok=True)

    def chown(self, path: str, uid: int, gid: int) -> None:
        os.chown(path, uid, gid)

    def chmod(self, path: str, mode: int) -> None:
        os.chmod(path, mode)


def provision_tenant_volumes(
    slug: str,
    uid: int,
    *,
    run=subprocess.run,
    claim_dir: str = CLAIM_DIR,
    fs=None,
) -> list[str]:
    """Create and own this tenant's volumes. Returns a list of actions taken."""
    validate_slug(slug)
    validate_uid(uid)
    fs = fs or _RealFs()

    assert_uid_available(slug, uid, existing_claims(run=run, claim_dir=claim_dir, fs=fs))

    actions: list[str] = []
    content = content_volume_name(slug)
    adapters = adapters_volume_name(slug)

    for name in (content, adapters):
        if volume_exists(name, run=run):
            actions.append(f"volume {name} already existed")
        else:
            _docker(["volume", "create", name], run=run)
            actions.append(f"created volume {name}")

    # The register entry is written before the volumes are owned, so a run that
    # dies halfway leaves the UID claimed rather than apparently free. The
    # ownership is what a re-run finishes; a lost claim is what it cannot.
    fs.makedirs(claim_dir, CLAIM_DIR_MODE)
    fs.chown(claim_dir, 0, 0)
    fs.chmod(claim_dir, CLAIM_DIR_MODE)
    entry = claim_path(slug, claim_dir)
    fs.write_text(entry, render_claim(slug, uid), CLAIM_MODE)
    fs.chown(entry, 0, 0)
    fs.chmod(entry, CLAIM_MODE)
    actions.append(f"claimed uid {uid} for {slug} in {claim_dir}")

    content_path = volume_mountpoint(content, run=run)
    # Written before the ownership calls below so a partially-completed run
    # still leaves the volume non-empty, and therefore still immune to Docker's
    # copy-up. Owned by the tenant because it sits in the tenant's own
    # directory and root-owned files there buy nothing -- the tenant owns the
    # directory, so it can unlink either way.
    seed = os.path.join(content_path, SEED_FILE)
    fs.write_text(seed, f"{slug}\n", 0o600)
    fs.chown(seed, uid, uid)
    fs.chmod(seed, 0o600)
    fs.chown(content_path, uid, uid)
    fs.chmod(content_path, CONTENT_MODE)
    actions.append(f"{content} owned by {uid}:{uid} at {oct(CONTENT_MODE)}")

    adapters_path = volume_mountpoint(adapters, run=run)
    fs.chown(adapters_path, 0, 0)
    fs.chmod(adapters_path, ADAPTERS_MODE)
    actions.append(f"{adapters} owned by 0:0 at {oct(ADAPTERS_MODE)}")

    return actions


def main(argv: list[str], *, geteuid=os.geteuid, run=subprocess.run, fs=None, out=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # Optional so that `--list-claims` is answerable. It reports which UIDs are
    # taken, so requiring a UID to ask would mean already knowing the answer.
    parser.add_argument("slug", nargs="?")
    parser.add_argument("--uid", type=int)
    parser.add_argument(
        "--list-claims",
        action="store_true",
        help="print the UID every tenant holds on this host and exit",
    )
    args = parser.parse_args(argv)
    emit = out or (lambda line: print(line))

    if geteuid() != 0:
        print("provision_tenant_volume: must run as root.", file=sys.stderr)
        return 1

    try:
        if args.list_claims:
            if args.slug is not None or args.uid is not None:
                raise ProvisionError("--list-claims takes no slug and no --uid")
            for slug, uid in sorted(existing_claims(run=run, fs=fs).items()):
                emit(f"{slug}={uid}")
            return 0

        if args.slug is None or args.uid is None:
            raise ProvisionError("a slug and --uid are both required unless --list-claims is given")

        for action in provision_tenant_volumes(args.slug, args.uid, run=run, fs=fs):
            emit(action)
    except ProvisionError as exc:
        print(f"provision_tenant_volume: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
