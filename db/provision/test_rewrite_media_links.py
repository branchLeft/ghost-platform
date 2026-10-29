#!/usr/bin/env python3
"""Unit tests for rewrite_media_links.py.

See rewrite_media_links.md for what the tool does and what these prove.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

import rewrite_media_links as rml

OLD = "https://storage.example.invalid/BUCKET_NAME/"
NEW = "https://media.example.invalid/TENANT_FOLDER/"
LINKS = rml.LinkMap(OLD, NEW)

IMG_A = OLD + "2026/10/IMAGE_A.png"
IMG_B = OLD + "2026/10/IMAGE_B.png"
IMG_C = OLD + "2026/11/IMAGE_C.png"
# Same host and a bucket that merely starts with the old bucket's name.
LOOKALIKE = "https://storage.example.invalid/BUCKET_NAME2/2026/10/OTHER.png"


def _schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE posts (id VARCHAR(24) PRIMARY KEY, title VARCHAR(255), html LONGTEXT,
                            lexical LONGTEXT, feature_image VARCHAR(2000));
        CREATE TABLE posts_meta (id VARCHAR(24) PRIMARY KEY, og_image VARCHAR(2000));
        CREATE TABLE settings (id VARCHAR(24) PRIMARY KEY, "key" VARCHAR(50), value TEXT);
        CREATE TABLE users (id VARCHAR(24) PRIMARY KEY, profile_image VARCHAR(2000),
                            cover_image VARCHAR(2000));
        CREATE TABLE posts_tags (post_id VARCHAR(24), tag_id VARCHAR(24), PRIMARY KEY (post_id, tag_id));
        CREATE TABLE counters (n INTEGER PRIMARY KEY, label VARCHAR(20));
        """
    )


def _seed(conn: sqlite3.Connection) -> None:
    _schema(conn)
    conn.executemany(
        "INSERT INTO posts VALUES (?,?,?,?,?)",
        [
            ("p1", "TITLE_ONE", f'<p><img src="{IMG_A}"> and <img src="{IMG_B}"></p>',
             json.dumps({"src": IMG_A}), IMG_A),
            ("p2", "TITLE_é中", f"<p>{LOOKALIKE}</p>", None, None),
            ("p3", "TITLE_THREE", "<p>no media here</p>",
             json.dumps({"src": OLD.replace("/", "\\/") + "2026/10/ESC.png"}).replace("\\\\", "\\"), None),
        ],
    )
    conn.execute("INSERT INTO posts_meta VALUES ('m1', ?)", (IMG_C,))
    conn.executemany(
        "INSERT INTO settings VALUES (?,?,?)",
        [("s1", "logo", IMG_A), ("s2", "title", "SITE_TITLE"), ("s3", "cover_image", None)],
    )
    conn.execute("INSERT INTO users VALUES ('u1', ?, ?)", (IMG_B, None))
    conn.execute("INSERT INTO posts_tags VALUES ('p1', 't1')")
    conn.execute("INSERT INTO counters VALUES (1, 'LABEL')")
    conn.commit()


def _dump(conn: sqlite3.Connection) -> list[str]:
    return list(conn.iterdump())


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.backup = pathlib.Path(self.tmp.name) / "backup.jsonl"
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        _seed(self.conn)
        self.store = rml.SqliteStore(self.conn)


class RewriteValueTests(unittest.TestCase):
    def test_rewrites_every_occurrence(self) -> None:
        out = rml.rewrite_value(f"{IMG_A} {IMG_B}", LINKS)
        self.assertEqual(out, f"{NEW}2026/10/IMAGE_A.png {NEW}2026/10/IMAGE_B.png")

    def test_rewrites_json_escaped_form(self) -> None:
        esc_old = OLD.replace("/", "\\/")
        esc_new = NEW.replace("/", "\\/")
        self.assertEqual(rml.rewrite_value(esc_old + "x.png", LINKS), esc_new + "x.png")

    def test_leaves_a_bucket_that_only_shares_a_prefix(self) -> None:
        self.assertEqual(rml.rewrite_value(LOOKALIKE, LINKS), LOOKALIKE)

    def test_is_idempotent(self) -> None:
        once = rml.rewrite_value(IMG_A, LINKS)
        self.assertEqual(rml.rewrite_value(once, LINKS), once)

    def test_non_ascii_survives(self) -> None:
        text = f"é中 {IMG_A} \U0001f600"
        self.assertEqual(rml.rewrite_value(text, LINKS), text.replace(OLD, NEW))


class LinkMapTests(unittest.TestCase):
    def test_refuses_new_address_containing_old(self) -> None:
        with self.assertRaises(rml.RewriteError):
            rml.LinkMap(OLD, OLD + "FOLDER/")

    def test_refuses_old_address_containing_new(self) -> None:
        with self.assertRaises(rml.RewriteError):
            rml.LinkMap(NEW + "deeper/", NEW)

    def test_refuses_identical(self) -> None:
        with self.assertRaises(rml.RewriteError):
            rml.LinkMap(OLD, OLD)

    def test_requires_https_and_trailing_slash(self) -> None:
        for old, new in (("http://a.example.invalid/b/", NEW), ("https://a.example.invalid/b", NEW),
                         (OLD, "https://m.example.invalid/f"), (OLD, "ftp://m.example.invalid/f/")):
            with self.subTest(old=old, new=new), self.assertRaises(rml.RewriteError):
                rml.LinkMap(old, new)


class PlanTests(Fixture):
    def test_dry_run_reports_every_link_and_writes_nothing(self) -> None:
        before = _dump(self.conn)
        changes = rml.plan(self.store, LINKS)
        self.assertEqual(_dump(self.conn), before)
        reported = sorted(link for change in changes for link in change.links)
        self.assertEqual(
            reported,
            sorted([IMG_A, IMG_B, IMG_A, IMG_A, IMG_B, IMG_C, IMG_A,
                    OLD.replace("/", "\\/") + "2026/10/ESC.png"]),
        )

    def test_dry_run_leaves_lookalike_and_nulls_out(self) -> None:
        touched = {(c.table, c.column) for c in rml.plan(self.store, LINKS)}
        self.assertNotIn(("posts", "html"), {(c.table, c.column) for c in rml.plan(self.store, LINKS) if c.pk == ("p2",)})
        self.assertNotIn(("counters", "label"), touched)
        self.assertIn(("posts_meta", "og_image"), touched)
        self.assertIn(("users", "profile_image"), touched)


class ApplyTests(Fixture):
    def test_no_old_links_remain_after_apply(self) -> None:
        rml.apply(self.store, LINKS, self.backup)
        self.assertEqual(rml.remaining(self.store, LINKS), [])
        html = self.conn.execute("SELECT html FROM posts WHERE id='p1'").fetchone()[0]
        self.assertIn(NEW + "2026/10/IMAGE_A.png", html)

    def test_untouched_rows_are_untouched(self) -> None:
        rml.apply(self.store, LINKS, self.backup)
        row = self.conn.execute("SELECT title, html FROM posts WHERE id='p2'").fetchone()
        self.assertEqual(row, ("TITLE_é中", f"<p>{LOOKALIKE}</p>"))
        self.assertEqual(self.conn.execute("SELECT label FROM counters").fetchone()[0], "LABEL")

    def test_apply_twice_is_a_no_op_and_keeps_the_backup(self) -> None:
        rml.apply(self.store, LINKS, self.backup)
        after_first = _dump(self.conn)
        backup_bytes = self.backup.read_bytes()
        second = rml.apply(self.store, LINKS, self.backup)
        self.assertEqual(second, [])
        self.assertEqual(_dump(self.conn), after_first)
        self.assertEqual(self.backup.read_bytes(), backup_bytes)

    def test_refuses_to_overwrite_an_existing_backup(self) -> None:
        self.backup.write_text("PRIOR\n", encoding="utf-8")
        before = _dump(self.conn)
        with self.assertRaises(rml.RewriteError):
            rml.apply(self.store, LINKS, self.backup)
        self.assertEqual(_dump(self.conn), before)
        self.assertEqual(self.backup.read_text(encoding="utf-8"), "PRIOR\n")

    def test_table_without_primary_key_holding_a_link_is_refused(self) -> None:
        self.conn.execute("CREATE TABLE loose (note TEXT)")
        self.conn.execute("INSERT INTO loose VALUES (?)", (IMG_A,))
        before = _dump(self.conn)
        with self.assertRaisesRegex(rml.RewriteError, "loose"):
            rml.apply(self.store, LINKS, self.backup)
        self.assertEqual(_dump(self.conn), before)
        self.assertFalse(self.backup.exists())

    def test_json_typed_column_holding_a_link_is_refused(self) -> None:
        self.conn.execute("CREATE TABLE jsoncol (id INTEGER PRIMARY KEY, doc JSON)")
        self.conn.execute("INSERT INTO jsoncol VALUES (1, ?)", (json.dumps({"a": IMG_A}),))
        with self.assertRaisesRegex(rml.RewriteError, "jsoncol"):
            rml.apply(self.store, LINKS, self.backup)
        self.assertFalse(self.backup.exists())

    def test_failure_part_way_rolls_everything_back(self) -> None:
        before = _dump(self.conn)
        real = self.store.update
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 3:
                raise sqlite3.OperationalError("simulated failure")
            return real(*args, **kwargs)

        self.store.update = flaky  # type: ignore[method-assign]
        with self.assertRaises(sqlite3.OperationalError):
            rml.apply(self.store, LINKS, self.backup)
        self.assertEqual(_dump(self.conn), before)


class ReverseTests(Fixture):
    def test_reverse_restores_the_original_byte_for_byte(self) -> None:
        original = _dump(self.conn)
        rml.apply(self.store, LINKS, self.backup)
        self.assertNotEqual(_dump(self.conn), original)
        rml.reverse(self.store, self.backup)
        self.assertEqual(_dump(self.conn), original)

    def test_reverse_twice_is_a_no_op(self) -> None:
        original = _dump(self.conn)
        rml.apply(self.store, LINKS, self.backup)
        rml.reverse(self.store, self.backup)
        self.assertEqual(rml.reverse(self.store, self.backup), 0)
        self.assertEqual(_dump(self.conn), original)

    def test_reverse_refuses_a_row_edited_since_and_writes_nothing(self) -> None:
        rml.apply(self.store, LINKS, self.backup)
        self.conn.execute("UPDATE posts SET html='EDITED_BY_AN_EDITOR' WHERE id='p1'")
        self.conn.commit()
        state = _dump(self.conn)
        with self.assertRaisesRegex(rml.RewriteError, "posts"):
            rml.reverse(self.store, self.backup)
        self.assertEqual(_dump(self.conn), state)

    def test_reverse_refuses_a_backup_that_is_not_ours(self) -> None:
        self.backup.write_text('{"kind": "something-else"}\n', encoding="utf-8")
        with self.assertRaises(rml.RewriteError):
            rml.reverse(self.store, self.backup)

    def test_backup_records_before_and_after_for_each_touched_value(self) -> None:
        rml.apply(self.store, LINKS, self.backup)
        lines = [json.loads(x) for x in self.backup.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(lines[0]["kind"], "media-link-rewrite-backup")
        rows = lines[1:]
        self.assertTrue(rows)
        for row in rows:
            self.assertIn(OLD.replace("/", "\\/") if "\\/" in row["before"] else OLD, row["before"])
            self.assertNotIn(OLD, row["after"])


class MainTests(Fixture):
    def _run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rml.main(list(argv), store=self.store)
        return code, out.getvalue(), err.getvalue()

    def test_default_is_a_dry_run(self) -> None:
        before = _dump(self.conn)
        code, out, _ = self._run("--old", OLD, "--new", NEW, "--backup", str(self.backup))
        self.assertEqual(code, 0)
        self.assertEqual(_dump(self.conn), before)
        self.assertIn(IMG_A, out)
        self.assertFalse(self.backup.exists())

    def test_apply_needs_the_drained_confirmation(self) -> None:
        before = _dump(self.conn)
        code, _, err = self._run("--old", OLD, "--new", NEW, "--backup", str(self.backup), "--apply")
        self.assertEqual(code, 2)
        self.assertIn("drained", err)
        self.assertEqual(_dump(self.conn), before)

    def test_apply_then_reverse_through_main(self) -> None:
        original = _dump(self.conn)
        args = ("--old", OLD, "--new", NEW, "--backup", str(self.backup))
        self.assertEqual(self._run(*args, "--apply", "--confirm-drained")[0], 0)
        self.assertEqual(rml.remaining(self.store, LINKS), [])
        self.assertEqual(self._run(*args, "--reverse", "--confirm-drained")[0], 0)
        self.assertEqual(_dump(self.conn), original)

    def test_reports_failure_when_an_old_link_remains(self) -> None:
        self.conn.execute("CREATE TABLE loose (note TEXT)")
        self.conn.execute("INSERT INTO loose VALUES (?)", (IMG_A,))
        code, _, err = self._run("--old", OLD, "--new", NEW, "--backup", str(self.backup),
                                 "--apply", "--confirm-drained")
        self.assertEqual(code, 1)
        self.assertIn("loose", err)


class MysqlStoreTests(unittest.TestCase):
    """The mysql adapter is exercised through an injected runner: the SQL
    it sends and the environment it hands the child, never a live server."""

    def _store(self, replies: list[str]):
        calls: list[dict] = []

        def run(argv, input=None, env=None, capture_output=None, text=None, check=None):
            calls.append({"argv": argv, "input": input, "env": env})
            out = replies.pop(0) if replies else ""
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

        store = rml.MysqlStore(database="ghost_example", socket_path="/run/x.sock", user="U",
                               password="PW_VALUE", run=run)
        return store, calls

    def test_password_travels_in_the_environment_only(self) -> None:
        store, calls = self._store(["posts\thtml\tlongtext\n"])
        store.columns()
        call = calls[0]
        self.assertEqual(call["env"]["MYSQL_PWD"], "PW_VALUE")
        self.assertNotIn("PW_VALUE", " ".join(call["argv"]))
        self.assertNotIn("PW_VALUE", call["input"])
        self.assertEqual(sorted(call["env"]), ["MYSQL_PWD", "PATH"] if "PATH" in os.environ else ["MYSQL_PWD"])

    def test_update_is_byte_exact_and_transactional(self) -> None:
        store, calls = self._store([""])
        with store.transaction():
            store.update("posts", ["id"], ("p1",), "html", "café")
        sql = calls[0]["input"]
        self.assertIn("START TRANSACTION", sql)
        self.assertIn("CONVERT(UNHEX('636166c3a9') USING utf8mb4)", sql)
        self.assertIn("COMMIT", sql)
        self.assertLess(sql.index("START TRANSACTION"), sql.index("UPDATE"))

    def test_hostile_identifiers_and_keys_are_refused(self) -> None:
        store, _ = self._store([])
        with self.assertRaises(rml.RewriteError):
            store.update("posts`; DROP TABLE x; --", ["id"], ("p1",), "html", "v")
        with self.assertRaises(rml.RewriteError):
            store.update("posts", ["id"], ("p1' OR '1'='1",), "html", "v")


if __name__ == "__main__":
    unittest.main()
