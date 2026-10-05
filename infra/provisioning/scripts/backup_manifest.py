#!/usr/bin/env python3
"""What a tenant's backup should restore to, recorded at backup time from the
dump stream itself, and carried inside the encrypted dump as one trailing SQL
comment line. The restore drill compares a restore against this, never against
the restored database alone. See backup_manifest.md.
"""

from __future__ import annotations

import base64
import dataclasses
import json

TRAILER_PREFIX = b"-- branchleft-backup-manifest v1 "
WATCHED_TABLES = ("settings", "posts", "users", "members")


class ManifestError(Exception):
    """A manifest is missing, unreadable, or was not recorded cleanly."""


@dataclasses.dataclass(frozen=True)
class Manifest:
    site_title: str | None
    users: int
    published_posts: int
    members: int
    newest_post_title: str | None
    newest_post_slug: str | None
    error: str | None = None

    def to_trailer(self) -> bytes:
        """One SQL comment line. The JSON is base64-encoded so the line holds
        no quote, backslash or semicolon for the mysql client to act on."""
        payload = base64.b64encode(json.dumps(dataclasses.asdict(self), sort_keys=True).encode()).decode()
        return TRAILER_PREFIX + payload.encode() + b"\n"


def parse_trailer(data: bytes) -> Manifest:
    """Finds the manifest line in a decrypted dump. The last one wins."""
    found = None
    for line in data.splitlines():
        if line.startswith(TRAILER_PREFIX):
            found = line[len(TRAILER_PREFIX):]
    if found is None:
        raise ManifestError("the backup carries no manifest -- it was not written by the backup worker, or is empty")
    try:
        fields = json.loads(base64.b64decode(found, validate=True))
        return Manifest(**fields)
    except (ValueError, TypeError) as exc:
        raise ManifestError(f"the backup's manifest is unreadable: {exc}") from exc


_ESCAPES = {"0": "\0", "b": "\b", "n": "\n", "r": "\r", "t": "\t", "Z": "\x1a"}


def parse_insert_values(text: str) -> list[list[str | None]]:
    """The value tuples of one mysqldump extended INSERT, from the first `(`
    after `VALUES`. Strings, NULL, numbers and `_binary` strings; anything
    else raises rather than guessing."""
    index = text.index(" VALUES ") + len(" VALUES ")
    rows: list[list[str | None]] = []
    length = len(text)
    while index < length:
        if text[index] != "(":
            raise ManifestError(f"expected '(' at {index}")
        index += 1
        row: list[str | None] = []
        while True:
            if text.startswith("_binary ", index):
                index += len("_binary ")
            char = text[index]
            if char == "'":
                index += 1
                parts = []
                while True:
                    char = text[index]
                    if char == "\\":
                        parts.append(_ESCAPES.get(text[index + 1], text[index + 1]))
                        index += 2
                    elif char == "'":
                        if text.startswith("''", index):
                            parts.append("'")
                            index += 2
                        else:
                            index += 1
                            break
                    else:
                        parts.append(char)
                        index += 1
                row.append("".join(parts))
            else:
                end = index
                while text[end] not in ",)":
                    end += 1
                token = text[index:end]
                row.append(None if token == "NULL" else token)
                index = end
            if text[index] == ",":
                index += 1
                continue
            if text[index] == ")":
                index += 1
                break
            raise ManifestError(f"unexpected {text[index]!r} at {index}")
        rows.append(row)
        if index < length and text[index] == ",":
            index += 1
            continue
        break
    return rows


class ManifestWatcher:
    """Watches the plaintext dump go past, line by line, on its way into
    `age`. Learns each watched table's column order from its CREATE TABLE,
    then reads that table's INSERTs. Never raises: a line it cannot read is
    recorded on the manifest, so a parsing defect fails the drill, never
    the backup."""

    def __init__(self) -> None:
        self._columns: dict[str, list[str]] = {}
        self._table: str | None = None
        self._pending: list[str] = []
        self.site_title: str | None = None
        self.users = 0
        self.published_posts = 0
        self.members = 0
        self._newest: tuple[str, str | None, str | None] | None = None
        self.error: str | None = None

    def observe(self, line: bytes) -> None:
        if self.error is not None:
            return
        try:
            self._observe(line)
        except (ManifestError, ValueError, IndexError, KeyError) as exc:
            self.error = f"{type(exc).__name__}: {exc}"

    def _observe(self, line: bytes) -> None:
        if line.startswith(b"CREATE TABLE `"):
            name = line.split(b"`")[1].decode()
            self._table = name if name in WATCHED_TABLES else None
            self._pending = []
        elif self._table is not None and line.startswith(b"  `"):
            self._pending.append(line.split(b"`")[1].decode())
        elif self._table is not None and line.startswith(b")"):
            self._columns[self._table] = self._pending
            self._table = None
        elif line.startswith(b"INSERT INTO `"):
            name = line.split(b"`")[1].decode()
            if name in WATCHED_TABLES:
                if name not in self._columns:
                    raise ManifestError(f"INSERT INTO {name} before its CREATE TABLE")
                columns = self._columns[name]
                for values in parse_insert_values(line.decode("utf-8", errors="replace").rstrip("\n;")):
                    self._row(name, dict(zip(columns, values, strict=True)))

    def _row(self, table: str, row: dict[str, str | None]) -> None:
        if table == "settings" and row.get("key") == "title":
            self.site_title = row.get("value")
        elif table == "users":
            self.users += 1
        elif table == "members":
            self.members += 1
        elif table == "posts" and row.get("type") == "post" and row.get("status") == "published":
            self.published_posts += 1
            stamp = row.get("published_at") or ""
            if self._newest is None or stamp > self._newest[0]:
                self._newest = (stamp, row.get("title"), row.get("slug"))

    def manifest(self) -> Manifest:
        return Manifest(
            site_title=self.site_title,
            users=self.users,
            published_posts=self.published_posts,
            members=self.members,
            newest_post_title=self._newest[1] if self._newest else None,
            newest_post_slug=self._newest[2] if self._newest else None,
            error=self.error,
        )
