#!/usr/bin/env python3
"""Per-tenant age recipients for the backup worker.

Each tenant's dump is encrypted to exactly one recipient, that tenant's own,
so destroying that tenant's private key makes only that tenant's backups
unreadable. A tenant with no recipient is refused, never given another
tenant's key or a shared one. See backup_recipients.md.
"""

from __future__ import annotations

import os
import re
import stat
from collections.abc import Mapping

DEFAULT_RECIPIENTS_FILE = "/etc/branchleft/backup-worker-recipients"
RECIPIENTS_FILE_ENV = "BACKUP_WORKER_RECIPIENTS_FILE"

# A native age X25519 recipient: the bech32 human-readable part, the separator,
# then 58 data characters.
_AGE_RECIPIENT = re.compile(r"\Aage1[a-z0-9]{58}\Z")
_TENANT = re.compile(r"\A[a-z][a-z0-9-]*[a-z0-9]\Z")


class RecipientError(Exception):
    """The recipients file cannot be trusted; no tenant may be dumped from it."""


class MissingRecipient(RecipientError):
    """The named tenant has no recipient of its own."""


def parse_recipients(text: str) -> dict[str, str]:
    """`tenant recipient` per line; blank lines and #-comments ignored.

    Refuses a malformed line, a repeated tenant, a recipient that is not a
    single age public key, and one recipient shared by two tenants -- any of
    which would let one tenant's key open another tenant's dump.
    """
    recipients: dict[str, str] = {}
    owner_of: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) != 2:
            raise RecipientError(f"line {number}: expected exactly `tenant recipient`")
        tenant, recipient = fields
        if not _TENANT.match(tenant):
            raise RecipientError(f"line {number}: {tenant!r} is not a valid tenant name")
        if not _AGE_RECIPIENT.match(recipient):
            raise RecipientError(f"line {number}: tenant {tenant!r} has a value that is not one age public key")
        if tenant in recipients:
            raise RecipientError(f"line {number}: tenant {tenant!r} is listed more than once")
        if recipient in owner_of:
            raise RecipientError(
                f"line {number}: tenants {owner_of[recipient]!r} and {tenant!r} share one recipient; "
                "each tenant needs its own"
            )
        recipients[tenant] = recipient
        owner_of[recipient] = tenant
    return recipients


def load_recipients(path: str) -> dict[str, str]:
    """Reads and parses the file without following a symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise RecipientError(f"{path} cannot be read: {exc.strerror}") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RecipientError(f"{path} is not a regular file")
        chunks = []
        while chunk := os.read(fd, 65536):
            chunks.append(chunk)
    finally:
        os.close(fd)
    return parse_recipients(b"".join(chunks).decode("utf-8", errors="replace"))


def recipient_for(tenant: str, recipients: Mapping[str, str]) -> str:
    """The tenant's own recipient, or MissingRecipient. There is no default."""
    try:
        return recipients[tenant]
    except KeyError:
        raise MissingRecipient(
            f"{tenant}: no age recipient of its own is configured; refusing to dump it "
            "under another tenant's key or a shared one"
        ) from None
