#!/usr/bin/env python3
"""Unit tests for backup_manifest.py, and for the backup worker carrying the
manifest inside the one ciphertext it stores. Real `age`."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest

import backup_manifest as bm

DUMP = b"""-- MySQL dump 10.13
CREATE TABLE `settings` (
  `id` varchar(24) NOT NULL,
  `group` varchar(50) NOT NULL,
  `key` varchar(50) NOT NULL,
  `value` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `settings` VALUES ('1','core','db_hash','abc'),('2','site','title','Tom\\'s \\"Site\\", (draft); \\\\ \\n'),('3','site','description',NULL);
CREATE TABLE `users` (
  `id` varchar(24) NOT NULL,
  `name` varchar(191) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `users` VALUES ('u1','Owner'),('u2','Editor');
CREATE TABLE `posts` (
  `id` varchar(24) NOT NULL,
  `title` varchar(2000) NOT NULL,
  `slug` varchar(191) NOT NULL,
  `body` longtext,
  `type` varchar(50) NOT NULL,
  `status` varchar(50) NOT NULL,
  `published_at` datetime DEFAULT NULL,
  `featured` tinyint(1) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `posts` VALUES ('p1','Coming soon','coming-soon','x),(y','post','published','2026-01-01 00:00:00',0),('p2','Newest','newest',_binary 'b\\0','post','published','2026-03-01 10:00:00',1),('p3','Draft','draft',NULL,'post','draft',NULL,0),('p4','About','about','','page','published','2026-04-01 00:00:00',0);
CREATE TABLE `members` (
  `id` varchar(24) NOT NULL,
  `email` varchar(191) NOT NULL
) ENGINE=InnoDB;
INSERT INTO `members` VALUES ('m1','a@example.test');
INSERT INTO `members` VALUES ('m2','b@example.test');
CREATE TABLE `tags` (
  `id` varchar(24) NOT NULL
) ENGINE=InnoDB;
INSERT INTO `tags` VALUES ('t1');
-- Dump completed
"""


def _watch(data: bytes) -> bm.Manifest:
    watcher = bm.ManifestWatcher()
    for line in data.splitlines(keepends=True):
        watcher.observe(line)
    return watcher.manifest()


class WatcherTests(unittest.TestCase):
    def test_reads_title_counts_and_newest_post(self):
        manifest = _watch(DUMP)
        self.assertEqual(manifest.site_title, 'Tom\'s "Site", (draft); \\ \n')
        self.assertEqual((manifest.users, manifest.published_posts, manifest.members), (2, 2, 2))
        self.assertEqual((manifest.newest_post_title, manifest.newest_post_slug), ("Newest", "newest"))
        self.assertIsNone(manifest.error)

    def test_an_empty_dump_records_nothing(self):
        manifest = _watch(b"")
        self.assertEqual((manifest.site_title, manifest.users, manifest.newest_post_title), (None, 0, None))

    def test_insert_before_create_is_recorded_not_raised(self):
        manifest = _watch(b"INSERT INTO `users` VALUES ('u1');\n")
        self.assertIn("before its CREATE TABLE", manifest.error)

    def test_a_malformed_insert_is_recorded_and_stops_watching(self):
        bad = DUMP.replace(b"('u1','Owner')", b"('u1','Owner' 'x')")
        manifest = _watch(bad)
        self.assertIn("ManifestError", manifest.error)

    def test_column_count_mismatch_is_recorded(self):
        bad = DUMP.replace(b"('u1','Owner')", b"('u1')")
        self.assertIn("ValueError", _watch(bad).error)

    def test_doubled_quote_and_bare_tokens(self):
        rows = bm.parse_insert_values("INSERT INTO `t` VALUES ('a''b',-1.5,NULL,b'1')")
        self.assertEqual(rows, [["a'b", "-1.5", None, "b'1'"]])

    def test_garbage_after_values_raises(self):
        with self.assertRaises(bm.ManifestError):
            bm.parse_insert_values("INSERT INTO `t` VALUES x")


class TrailerTests(unittest.TestCase):
    def test_round_trip_and_last_wins(self):
        first = bm.Manifest("A", 1, 0, 0, None, None)
        second = _watch(DUMP)
        trailer = second.to_trailer()
        self.assertTrue(trailer.startswith(bm.TRAILER_PREFIX) and trailer.endswith(b"\n"))
        for forbidden in (b"'", b"\\", b";", b'"'):
            self.assertNotIn(forbidden, trailer[len(bm.TRAILER_PREFIX):])
        self.assertEqual(bm.parse_trailer(DUMP + first.to_trailer() + trailer), second)

    def test_missing_trailer(self):
        with self.assertRaisesRegex(bm.ManifestError, "carries no manifest"):
            bm.parse_trailer(DUMP)

    def test_unreadable_trailer(self):
        with self.assertRaisesRegex(bm.ManifestError, "unreadable"):
            bm.parse_trailer(bm.TRAILER_PREFIX + b"!!!\n")
        with self.assertRaisesRegex(bm.ManifestError, "unreadable"):
            bm.parse_trailer(bm.TRAILER_PREFIX + b"e30=\n")


@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "needs the age binary")
class WorkerCarriesTheManifestTests(unittest.TestCase):
    """run_tenant_dump stores one ciphertext whose plaintext ends with the
    manifest of exactly the bytes it dumped."""

    def test_stored_dump_ends_with_its_manifest(self):
        import backup_worker as bw
        from pull_encrypt_store import CopyTarget

        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        key = os.path.join(directory, "k")
        recipient = subprocess.run(["age-keygen", "-o", key], capture_output=True, text=True,
                                   check=True).stderr.strip().rsplit(" ", 1)[-1]

        class Transport:
            def run(self, *, command, env, stdout):
                for line in DUMP.splitlines(keepends=True):
                    stdout.write(line)
                return 0

        stored: list[bytes] = []
        result = bw.run_tenant_dump(
            tenant="blog", transport=Transport(), mysql_pwd="pw", age_recipient=recipient,
            copies=[CopyTarget(name="primary", put=stored.append)], dump_tenant_path="unused",
        )
        self.assertTrue(result.ok, result.error)
        plaintext = subprocess.run(["age", "--decrypt", "-i", key], input=stored[0], capture_output=True,
                                   check=True).stdout
        self.assertTrue(plaintext.startswith(DUMP))
        self.assertEqual(bm.parse_trailer(plaintext), _watch(DUMP))


if __name__ == "__main__":
    unittest.main()
