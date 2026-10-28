#!/usr/bin/env python3
"""Rewrite one tenant database's stored media links from the old storage
address to our own media address, once and reversibly.

Dry run by default. An apply writes a backup of every touched value first,
runs in one transaction, then re-scans the whole database for the old
address. The reverse restores the recorded originals. Run it only against a
drained colour. See rewrite_media_links.md.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import os
import re
import sqlite3
import subprocess
import sys
from typing import Iterator, Protocol

BACKUP_KIND = "media-link-rewrite-backup"
TEXT_TYPES = ("char", "varchar", "tinytext", "text", "mediumtext", "longtext")
IDENTIFIER = re.compile(r"\A[A-Za-z0-9_]{1,64}\Z")
KEY_VALUE = re.compile(r"\A[A-Za-z0-9_.\-]{1,64}\Z")
DEFAULT_SOCKET = "/opt/branchleft/db/run/mysqld/mysqld.sock"


class RewriteError(Exception):
    """The run was refused or could not be verified; nothing half-applied."""


def _escaped(prefix: str) -> str:
    return prefix.replace("/", "\\/")


@dataclasses.dataclass(frozen=True)
class LinkMap:
    old: str
    new: str

    def __post_init__(self) -> None:
        for name, value in (("old", self.old), ("new", self.new)):
            if not value.startswith("https://") or not value.endswith("/"):
                raise RewriteError(f"{name} address {value!r} must start with https:// and end with /")
        # Either containing the other would let a second run rewrite its own
        # output, which is what makes "once" a property rather than a hope.
        if self.old in self.new or self.new in self.old:
            raise RewriteError("old and new addresses must not contain one another")

    @property
    def pairs(self) -> tuple[tuple[str, str], ...]:
        return ((self.old, self.new), (_escaped(self.old), _escaped(self.new)))


@dataclasses.dataclass(frozen=True)
class Column:
    table: str
    name: str
    kind: str  # "text" or "json"


@dataclasses.dataclass(frozen=True)
class Change:
    table: str
    column: str
    pk_cols: tuple[str, ...]
    pk: tuple
    before: str
    after: str
    links: tuple[str, ...]


class Store(Protocol):
    def columns(self) -> list[Column]: ...
    def primary_key(self, table: str) -> list[str]: ...
    def rows(self, table: str, pk_cols: list[str], column: str) -> Iterator[tuple[tuple, str]]: ...
    def get(self, table: str, pk_cols: list[str], pk: tuple, column: str) -> str | None: ...
    def update(self, table: str, pk_cols: list[str], pk: tuple, column: str, value: str) -> None: ...
    def transaction(self) -> contextlib.AbstractContextManager: ...


def rewrite_value(value: str, links: LinkMap) -> str:
    for old, new in links.pairs:
        value = value.replace(old, new)
    return value


def find_links(value: str, links: LinkMap) -> list[str]:
    found: list[str] = []
    for old, _ in links.pairs:
        found += re.findall(re.escape(old) + r"(?:\\/|[^\s\"'<>)(,\\])*", value)
    return found


def has_old(value: str, links: LinkMap) -> bool:
    return any(old in value for old, _ in links.pairs)


def rewrite_targets(store: Store) -> list[Column]:
    return [c for c in store.columns() if c.kind == "text"]


def blockers(store: Store, links: LinkMap) -> list[str]:
    """Places holding an old link that this tool cannot rewrite safely."""
    problems: list[str] = []
    keyed: dict[str, bool] = {}
    for col in store.columns():
        pk = keyed.setdefault(col.table, bool(store.primary_key(col.table)))
        holds = any(has_old(v, links) for _, v in store.rows(col.table, store.primary_key(col.table), col.name))
        if holds and col.kind == "json":
            problems.append(f"{col.table}.{col.name}: json column holds an old link; rewriting would reformat it")
        elif holds and not pk:
            problems.append(f"{col.table}.{col.name}: table has no primary key, so the row cannot be addressed")
    return problems


def plan(store: Store, links: LinkMap) -> list[Change]:
    changes: list[Change] = []
    for col in rewrite_targets(store):
        pk_cols = store.primary_key(col.table)
        if not pk_cols:
            continue
        for pk, value in store.rows(col.table, pk_cols, col.name):
            after = rewrite_value(value, links)
            if after != value:
                changes.append(Change(col.table, col.name, tuple(pk_cols), tuple(pk), value, after,
                                      tuple(find_links(value, links))))
    return changes


def remaining(store: Store, links: LinkMap) -> list[tuple[str, str]]:
    """Every (table, column) still holding an old link, over all text and
    json columns regardless of what apply chose to rewrite."""
    left: list[tuple[str, str]] = []
    for col in store.columns():
        if any(has_old(v, links) for _, v in store.rows(col.table, store.primary_key(col.table), col.name)):
            left.append((col.table, col.name))
    return left


def apply(store: Store, links: LinkMap, backup_path) -> list[Change]:
    problems = blockers(store, links)
    if problems:
        raise RewriteError("refusing to apply: " + "; ".join(problems))
    changes = plan(store, links)
    if not changes:
        return []
    try:
        handle = open(backup_path, "x", encoding="utf-8")
    except FileExistsError:
        raise RewriteError(f"backup {backup_path} already exists; refusing to overwrite it") from None
    try:
        with handle:
            handle.write(json.dumps({"kind": BACKUP_KIND, "version": 1, "old": links.old, "new": links.new}) + "\n")
            for c in changes:
                handle.write(json.dumps({"table": c.table, "column": c.column, "pk_cols": list(c.pk_cols),
                                         "pk": list(c.pk), "before": c.before, "after": c.after}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        with store.transaction():
            for c in changes:
                store.update(c.table, list(c.pk_cols), c.pk, c.column, c.after)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(backup_path)
        raise
    return changes


def reverse(store: Store, backup_path) -> int:
    with open(backup_path, encoding="utf-8") as handle:
        lines = [json.loads(line) for line in handle if line.strip()]
    if not lines or lines[0].get("kind") != BACKUP_KIND:
        raise RewriteError(f"{backup_path} is not a media-link rewrite backup")
    todo, conflicts = [], []
    for row in lines[1:]:
        current = store.get(row["table"], row["pk_cols"], tuple(row["pk"]), row["column"])
        if current == row["before"]:
            continue
        if current == row["after"]:
            todo.append(row)
        else:
            conflicts.append(f"{row['table']}.{row['column']} {row['pk']}")
    if conflicts:
        raise RewriteError("changed since the rewrite, nothing restored: " + "; ".join(conflicts))
    if todo:
        with store.transaction():
            for row in todo:
                store.update(row["table"], row["pk_cols"], tuple(row["pk"]), row["column"], row["before"])
    return len(todo)


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class SqliteStore:
    """A copy of a database as a SQLite file; also what the tests run on."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def _tables(self) -> list[str]:
        cur = self.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        return [r[0] for r in cur.fetchall()]

    def columns(self) -> list[Column]:
        out = []
        for table in self._tables():
            for _, name, ctype, *_ in self.conn.execute(f"PRAGMA table_info({_q(table)})"):
                t = (ctype or "").upper()
                if "JSON" in t:
                    out.append(Column(table, name, "json"))
                elif any(x in t for x in ("CHAR", "TEXT", "CLOB")):
                    out.append(Column(table, name, "text"))
        return out

    def primary_key(self, table: str) -> list[str]:
        info = [(r[5], r[1]) for r in self.conn.execute(f"PRAGMA table_info({_q(table)})") if r[5]]
        return [name for _, name in sorted(info)]

    def rows(self, table, pk_cols, column):
        cols = ", ".join(_q(c) for c in pk_cols) or "NULL"
        sql = f"SELECT {cols}, {_q(column)} FROM {_q(table)} WHERE {_q(column)} IS NOT NULL"
        for row in self.conn.execute(sql).fetchall():
            yield tuple(row[:-1]) if pk_cols else (), row[-1]

    def get(self, table, pk_cols, pk, column):
        where = " AND ".join(f"{_q(c)} = ?" for c in pk_cols)
        row = self.conn.execute(f"SELECT {_q(column)} FROM {_q(table)} WHERE {where}", tuple(pk)).fetchone()
        return row[0] if row else None

    def update(self, table, pk_cols, pk, column, value):
        where = " AND ".join(f"{_q(c)} = ?" for c in pk_cols)
        self.conn.execute(f"UPDATE {_q(table)} SET {_q(column)} = ? WHERE {where}", (value, *pk))

    @contextlib.contextmanager
    def transaction(self):
        self.conn.commit()
        self.conn.execute("BEGIN")
        try:
            yield
        except BaseException:
            self.conn.rollback()
            raise
        self.conn.commit()


class MysqlStore:
    """The `mysql` client over the host socket. Values travel as hex both
    ways so bytes are exact, and the password only in the child's
    environment. Not usable on a live colour: the caller drains first."""

    def __init__(self, *, database: str, socket_path: str, user: str, password: str, run=subprocess.run) -> None:
        if not IDENTIFIER.match(database):
            raise RewriteError(f"database name {database!r} is not a plain identifier")
        self.database, self.socket_path, self.user, self.password, self._run = database, socket_path, user, password, run
        self._buffer: list[str] | None = None

    def _exec(self, sql: str) -> str:
        env = {"MYSQL_PWD": self.password}
        if "PATH" in os.environ:
            env["PATH"] = os.environ["PATH"]
        result = self._run(["mysql", "--socket", self.socket_path, "--user", self.user, "--batch", "--raw", "-N"],
                           input=sql, env=env, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RewriteError(f"mysql exited {result.returncode}: {result.stderr.strip()}")
        return result.stdout

    @staticmethod
    def _ident(name: str) -> str:
        if not IDENTIFIER.match(name):
            raise RewriteError(f"identifier {name!r} is not a plain identifier")
        return f"`{name}`"

    @staticmethod
    def _key(value) -> str:
        text = str(value)
        if not KEY_VALUE.match(text):
            raise RewriteError(f"key value {text!r} is outside the accepted charset")
        return f"'{text}'"

    def _where(self, pk_cols, pk) -> str:
        return " AND ".join(f"{self._ident(c)} = {self._key(v)}" for c, v in zip(pk_cols, pk, strict=True))

    def columns(self) -> list[Column]:
        types = ",".join(f"'{t}'" for t in (*TEXT_TYPES, "json"))
        sql = ("SELECT table_name, column_name, data_type FROM information_schema.columns "
               f"WHERE table_schema = '{self.database}' AND data_type IN ({types}) "
               "ORDER BY table_name, ordinal_position;\n")
        return [Column(t, c, "json" if d == "json" else "text")
                for t, c, d in (line.split("\t") for line in self._exec(sql).splitlines() if line)]

    def primary_key(self, table: str) -> list[str]:
        sql = ("SELECT column_name FROM information_schema.key_column_usage "
               f"WHERE table_schema = '{self.database}' AND table_name = '{self._ident(table)[1:-1]}' "
               "AND constraint_name = 'PRIMARY' ORDER BY ordinal_position;\n")
        return [line for line in self._exec(sql).splitlines() if line]

    def rows(self, table, pk_cols, column):
        keys = "".join(f"{self._ident(c)}, " for c in pk_cols)
        sql = (f"SELECT {keys}HEX({self._ident(column)}) FROM {self._ident(self.database)}.{self._ident(table)} "
               f"WHERE {self._ident(column)} IS NOT NULL;\n")
        for line in self._exec(sql).splitlines():
            *pk, hexed = line.split("\t")
            yield tuple(pk) if pk_cols else (), bytes.fromhex(hexed).decode("utf-8")

    def get(self, table, pk_cols, pk, column):
        sql = (f"SELECT HEX({self._ident(column)}) FROM {self._ident(self.database)}.{self._ident(table)} "
               f"WHERE {self._where(pk_cols, pk)};\n")
        out = self._exec(sql).strip()
        return bytes.fromhex(out).decode("utf-8") if out else None

    def update(self, table, pk_cols, pk, column, value):
        if self._buffer is None:
            raise RewriteError("update outside a transaction")
        hexed = value.encode("utf-8").hex()
        self._buffer.append(
            f"UPDATE {self._ident(self.database)}.{self._ident(table)} SET {self._ident(column)} = "
            f"CONVERT(UNHEX('{hexed}') USING utf8mb4) WHERE {self._where(pk_cols, pk)};")

    @contextlib.contextmanager
    def transaction(self):
        self._buffer = []
        try:
            yield
            script = "START TRANSACTION;\n" + "\n".join(self._buffer) + "\nCOMMIT;\n"
            self._exec(script)
        finally:
            self._buffer = None


def main(argv: list[str], *, store: Store | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--old", required=True, help="old address prefix, https://.../BUCKET/")
    parser.add_argument("--new", required=True, help="new address prefix, https://.../TENANT_FOLDER/")
    parser.add_argument("--backup", required=True, help="path of the backup file")
    parser.add_argument("--database", help="tenant database, e.g. ghost_blog")
    parser.add_argument("--socket", default=DEFAULT_SOCKET)
    parser.add_argument("--user", default="rewrite")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--reverse", action="store_true")
    parser.add_argument("--confirm-drained", action="store_true",
                        help="assert this colour is drained; required to write")
    args = parser.parse_args(argv)

    try:
        links = LinkMap(args.old, args.new)
        if (args.apply or args.reverse) and not args.confirm_drained:
            print("rewrite_media_links: writing needs --confirm-drained; run only on a drained colour", file=sys.stderr)
            return 2
        if store is None:
            password = os.environ.get("DB_REWRITE_MYSQL_PWD")
            if not password or not args.database:
                raise RewriteError("--database and DB_REWRITE_MYSQL_PWD are required")
            store = MysqlStore(database=args.database, socket_path=args.socket, user=args.user, password=password)
        if args.reverse:
            print(f"rewrite_media_links: restored {reverse(store, args.backup)} value(s)")
            return 0
        if args.apply:
            changes = apply(store, links, args.backup)
            left = remaining(store, links)
            if left:
                raise RewriteError("old links remain in " + ", ".join(f"{t}.{c}" for t, c in left))
            print(f"rewrite_media_links: rewrote {len(changes)} value(s)")
            return 0
        problems = blockers(store, links)
        for c in plan(store, links):
            for link in c.links:
                print(f"{c.table}.{c.column} {list(c.pk)}: {link}")
        for problem in problems:
            print(f"BLOCKER {problem}", file=sys.stderr)
        return 1 if problems else 0
    except RewriteError as exc:
        print(f"rewrite_media_links: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
