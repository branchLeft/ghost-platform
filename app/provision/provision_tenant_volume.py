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
   overwritten by that copy-up. So this script seeds the content volume with a
   marker file: a non-empty volume is never copied into, the image's `1777`
   never lands, and Ghost's own entrypoint still seeds `content.orig`
   afterwards -- it tests each sub-path individually (`[ ! -e "$target" ]`),
   not the directory as a whole.
2. **The tenant's UID is host state, so the uniqueness check reads the host.**
   Nothing in a config file can answer "is 30001 already somebody's" for a host
   that several tenant repos deploy to independently. The claim is recorded in
   the volume and read back out of it.
3. **A UID change on a provisioned volume is a data loss, not an update.** The
   content is `0700` to the old UID; re-owning it under a different tenant
   hands one tenant another's data, and re-owning it under the same tenant with
   a new number is a migration with a copy step. Either way it is refused here
   rather than performed silently.

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

# Written into the content volume. Two jobs: it makes the volume non-empty so
# Docker's copy-up never fires, and it is the host-readable record of which
# tenant holds which UID.
CLAIM_FILE = ".branchleft-tenant"

# Sentinel for "this slug holds a volume whose claim cannot be read". Not
# `None`, which would be indistinguishable from "this slug is free".
UNREADABLE_CLAIM = -1

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


def existing_claims(*, run=subprocess.run, read_text=None) -> dict[str, int]:
    """Every UID currently claimed on this host, keyed by tenant slug.

    A content volume with no readable claim file is reported under its own slug
    with `UNREADABLE_CLAIM` rather than skipped, so `assert_uid_available` can still
    see that the slug is taken; what it cannot see is which UID, and that is
    surfaced as a refusal at the point it matters rather than silently here.
    """
    if read_text is None:

        def read_text(path: str) -> str:
            with open(path, encoding="utf-8") as handle:
                return handle.read()

    claims: dict[str, int] = {}
    for volume in list_content_volumes(run=run):
        slug = slug_from_content_volume(volume)
        try:
            text = read_text(os.path.join(volume_mountpoint(volume, run=run), CLAIM_FILE))
        except (OSError, ProvisionError):
            claims[slug] = UNREADABLE_CLAIM
            continue
        try:
            claimed_slug, uid = parse_claim(text)
        except ProvisionError:
            claims[slug] = UNREADABLE_CLAIM
            continue
        # The volume name is the authority on which tenant it belongs to; a
        # claim naming a different slug means the volume was renamed or copied,
        # which is exactly the state that must not be provisioned over.
        claims[claimed_slug if claimed_slug == slug else slug] = uid
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
    if existing == UNREADABLE_CLAIM:
        raise ProvisionError(
            f"tenant {slug!r} already has a content volume on this host whose claim file "
            f"({CLAIM_FILE}) is missing or unreadable, so the uid it was provisioned with "
            "cannot be established. Read the volume's ownership on the host and restore the "
            "claim by hand; re-provisioning over it could hand this volume to a different uid."
        )
    if existing is not None and existing != uid:
        raise ProvisionError(
            f"tenant {slug!r} already holds uid {existing} on this host, not {uid}. "
            "Its content volume is mode 0700 to that uid, so changing the number here would "
            "lock the tenant out of its own data; a uid change is a migration with a copy "
            "step, not a re-run of this script."
        )


def provision_tenant_volumes(
    slug: str,
    uid: int,
    *,
    run=subprocess.run,
    read_text=None,
    write_text=None,
    chown=os.chown,
    chmod=os.chmod,
) -> list[str]:
    """Create and own this tenant's volumes. Returns a list of actions taken."""
    validate_slug(slug)
    validate_uid(uid)

    if write_text is None:

        def write_text(path: str, text: str) -> None:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)

    assert_uid_available(slug, uid, existing_claims(run=run, read_text=read_text))

    actions: list[str] = []
    content = content_volume_name(slug)
    adapters = adapters_volume_name(slug)

    for name in (content, adapters):
        if volume_exists(name, run=run):
            actions.append(f"volume {name} already existed")
        else:
            _docker(["volume", "create", name], run=run)
            actions.append(f"created volume {name}")

    content_path = volume_mountpoint(content, run=run)
    claim_path = os.path.join(content_path, CLAIM_FILE)
    # Written before the ownership calls below so that a partially-completed
    # run still leaves the volume non-empty, and therefore still immune to
    # Docker's copy-up. A re-run then finishes the ownership.
    write_text(claim_path, render_claim(slug, uid))
    chown(claim_path, uid, uid)
    chmod(claim_path, 0o600)
    chown(content_path, uid, uid)
    chmod(content_path, CONTENT_MODE)
    actions.append(f"{content} owned by {uid}:{uid} at {oct(CONTENT_MODE)}")

    adapters_path = volume_mountpoint(adapters, run=run)
    chown(adapters_path, 0, 0)
    chmod(adapters_path, ADAPTERS_MODE)
    actions.append(f"{adapters} owned by 0:0 at {oct(ADAPTERS_MODE)}")

    return actions


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("slug")
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument(
        "--list-claims",
        action="store_true",
        help="print the UID every tenant holds on this host and exit",
    )
    args = parser.parse_args(argv)

    if os.geteuid() != 0:
        print("provision_tenant_volume: must run as root.", file=sys.stderr)
        return 1

    try:
        if args.list_claims:
            for slug, uid in sorted(existing_claims().items()):
                print(f"{slug}={uid}")
            return 0
        for action in provision_tenant_volumes(args.slug, args.uid):
            print(action)
    except ProvisionError as exc:
        print(f"provision_tenant_volume: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
