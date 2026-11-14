#!/usr/bin/env python3
"""Unit tests for percona_snapshot_probe.py, no Docker. Each control is judged
by a pure verdict function; each is asserted here against a sabotage fixture
that must FAIL and a healthy one that must PASS, so a verdict that quietly
stopped judging turns this suite red. The Docker run is
prove-percona-snapshot.sh, run in snapshot-proof-ci.yml."""

from __future__ import annotations

import inspect
import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest
from unittest import mock

import extract_tenant_binlog
import gtid_snapshot
import percona_pin
import percona_snapshot_probe as psp
import snapshot_probe as sp

_PROVISION = pathlib.Path(__file__).resolve().parent
_REPO = _PROVISION.parents[1]
_CI = (_REPO / ".github" / "workflows" / "snapshot-proof-ci.yml").read_text(encoding="utf-8")
_WRAPPER = _PROVISION / "prove-percona-snapshot.sh"
_WRAPPER_TEXT = _WRAPPER.read_text(encoding="utf-8")
_IMAGES = json.loads((_REPO / ".github" / "image-mirror" / "images.json").read_text(encoding="utf-8"))
_FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = context ]; then echo "$FAKE_DOCKER_CONTEXT"; fi
exit 1
"""

# What Percona Server 8.0.46-37's mysqldump --source-data=2 wrote when this
# proof was built (percona_snapshot_probe.md, control 6).
PERCONA_COMMENT = "-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1461;"
NEW_SPELLING = "-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000004', SOURCE_LOG_POS=157;"
SETTINGS = {"log_bin": "1", "binlog_format": "ROW", "sync_binlog": "1", "gtid_mode": "ON", "enforce_gtid_consistency": "ON"}


class SabotageFixturesTests(unittest.TestCase):
    def test_every_canned_case_behaves(self) -> None:
        self.assertEqual(psp.self_test(), [])

    def test_each_verdict_has_a_red_and_a_green_case(self) -> None:
        by_verdict: dict[str, set[bool]] = {}
        for label, expected, _ in psp.SELF_TEST_CASES:
            by_verdict.setdefault(label.split(":")[0], set()).add(expected)
        self.assertEqual(set(by_verdict), {"variables", "gtid_oracle", "latency", "dump_lock", "grant", "snapshot_coordinate", "comment"})
        for name, outcomes in by_verdict.items():
            self.assertEqual(outcomes, {True, False}, f"{name} needs both a sabotage and a healthy fixture")


class ChecksumSabotageTests(unittest.TestCase):
    """The control the commit-before-coordinates sabotage rests on: a replica
    that diverged must fail, one that matches must pass. The Docker run of
    that sabotage is in snapshot-proof-ci.yml."""

    SOURCE = {"posts": (301, 111), "emails": (1, 5)}

    def test_a_replica_missing_the_forced_commit_diverges(self) -> None:
        verdict = sp.checksum_verdict(self.SOURCE, {"posts": (300, 999), "emails": (1, 5)})
        self.assertFalse(verdict.passed)
        self.assertIn("posts (source 301 rows, replica 300 rows)", verdict.reason)

    def test_a_replica_that_matches_passes(self) -> None:
        self.assertTrue(sp.checksum_verdict(self.SOURCE, dict(self.SOURCE)).passed)

    def test_the_forced_commit_adds_a_row_to_every_table_of_a_tenant(self) -> None:
        sql = psp.inject_sql("forced-t1")
        for table in sp.BLOG_TABLES:
            self.assertIn(f"INSERT INTO {table} ", sql, table)
        self.assertTrue(sql.startswith("START TRANSACTION;") and sql.endswith("COMMIT;"))


class VerdictTests(unittest.TestCase):
    def test_a_stock_server_has_no_snapshot_variables(self) -> None:
        verdict = psp.variables_verdict({}, SETTINGS)
        self.assertFalse(verdict.passed)
        self.assertIn("Binlog_snapshot_file", verdict.reason)

    def test_statement_format_fails_the_variable_check(self) -> None:
        verdict = psp.variables_verdict(dict.fromkeys(psp.SNAPSHOT_STATUS, ""), {**SETTINGS, "binlog_format": "STATEMENT"})
        self.assertFalse(verdict.passed)
        self.assertIn("binlog_format", verdict.reason)

    def test_a_server_without_gtid_mode_fails_the_variable_check(self) -> None:
        status = dict.fromkeys(psp.SNAPSHOT_STATUS, "")
        for name in ("gtid_mode", "enforce_gtid_consistency"):
            verdict = psp.variables_verdict(status, {**SETTINGS, name: "OFF"})
            self.assertFalse(verdict.passed, name)
            self.assertIn(f"@@{name}", verdict.reason)
        self.assertTrue(psp.variables_verdict(status, SETTINGS).passed)

    def test_one_tenant_stalling_fails_the_whole_run_and_names_it(self) -> None:
        verdict = psp.latency_verdict({"t1": [0.004], "t2": [0.004, 0.2], "t3": [0.004]}, psp.LATENCY_LIMIT_SECONDS)
        self.assertFalse(verdict.passed)
        self.assertIn("t2", verdict.reason)
        self.assertNotIn("t1:", verdict.reason)

    def test_a_tenant_nobody_measured_is_never_a_pass(self) -> None:
        self.assertFalse(psp.latency_verdict({"t1": [0.004], "t2": []}, psp.LATENCY_LIMIT_SECONDS).passed)
        self.assertFalse(psp.latency_verdict({}, psp.LATENCY_LIMIT_SECONDS).passed)

    def test_a_noisy_baseline_is_named_but_never_loosens_the_limit(self) -> None:
        samples = {"t1": [0.004, 0.2], "t2": [0.004], "t3": [0.004]}
        quiet = psp.latency_verdict(samples, psp.LATENCY_LIMIT_SECONDS, {"t1": 0.03, "t2": 0.02, "t3": 0.02})
        noisy = psp.latency_verdict(samples, psp.LATENCY_LIMIT_SECONDS, {"t1": 0.15, "t2": 0.02, "t3": 0.02})
        self.assertFalse(quiet.passed)
        self.assertNotIn("host's own commit latency", quiet.reason)
        self.assertFalse(noisy.passed)
        self.assertIn("host's own commit latency", noisy.reason)
        self.assertIn("['t1']", noisy.reason)

    def test_the_latency_limit_is_the_ticket_bodys_100_ms(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)

    def test_a_global_lock_fails_even_beside_the_shared_read_lock(self) -> None:
        verdict = psp.dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("GLOBAL", "SHARED", "GRANTED")])
        self.assertFalse(verdict.passed)
        self.assertIn("GLOBAL/SHARED/GRANTED", verdict.reason)

    def test_a_commit_lock_fails(self) -> None:
        self.assertFalse(psp.dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("COMMIT", "SHARED", "GRANTED")]).passed)

    def test_each_write_blocking_table_lock_fails(self) -> None:
        for lock in sorted(psp.WRITE_BLOCKING_TABLE_LOCKS):
            verdict = psp.dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("TABLE", lock, "GRANTED")])
            self.assertFalse(verdict.passed, lock)
            self.assertIn(lock, verdict.reason)

    def test_the_shared_read_lock_a_snapshot_holds_is_not_a_blocking_lock(self) -> None:
        self.assertNotIn("SHARED_READ", psp.WRITE_BLOCKING_TABLE_LOCKS)
        self.assertTrue(psp.dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("TABLE", "SHARED_READ", "PENDING")]).passed)

    def test_a_sampler_that_never_saw_a_table_lock_was_blind(self) -> None:
        self.assertFalse(psp.dump_lock_verdict([("SCHEMA", "INTENTION_EXCLUSIVE", "GRANTED")]).passed)
        self.assertFalse(psp.dump_lock_verdict([("TABLE", "SHARED_READ", "PENDING")]).passed)

    def test_an_accepted_flush_tables_with_read_lock_fails_the_grant_control(self) -> None:
        verdict = psp.grant_verdict(errno_ftwrl=0, errno_lock_tables=1044, global_privileges=[], grant_lines=[], dumps_succeeded=[True])
        self.assertFalse(verdict.passed)
        self.assertIn("FLUSH TABLES WITH READ LOCK gave error 0", verdict.reason)

    def test_an_accepted_lock_tables_fails_the_grant_control(self) -> None:
        verdict = psp.grant_verdict(errno_ftwrl=1227, errno_lock_tables=0, global_privileges=[], grant_lines=[], dumps_succeeded=[True])
        self.assertFalse(verdict.passed)
        self.assertIn("LOCK TABLES gave error 0", verdict.reason)

    def test_reload_in_the_grants_fails_the_grant_control(self) -> None:
        verdict = psp.grant_verdict(
            errno_ftwrl=1227,
            errno_lock_tables=1044,
            global_privileges=["RELOAD", "REPLICATION CLIENT"],
            grant_lines=["GRANT RELOAD, REPLICATION CLIENT ON *.* TO `d`@`localhost`"],
            dumps_succeeded=[True],
        )
        self.assertFalse(verdict.passed)
        self.assertIn("RELOAD", verdict.reason)

    def test_a_dump_that_needed_a_privilege_it_lacks_fails(self) -> None:
        verdict = psp.grant_verdict(errno_ftwrl=1227, errno_lock_tables=1044, global_privileges=[], grant_lines=[], dumps_succeeded=[True, False, True])
        self.assertFalse(verdict.passed)
        self.assertIn("1 of 3 dumps failed", verdict.reason)

    def test_coordinates_that_followed_the_commit_fail_the_discrimination(self) -> None:
        moved = ("mysql-bin.000003", 1700)
        verdict = psp.snapshot_coordinate_verdict(
            opened=("mysql-bin.000003", 1461),
            live_before=("mysql-bin.000003", 1461),
            inside_after=moved,
            live_after=moved,
            log_status_after=moved,
            rows_before=10,
            rows_inside=10,
        )
        self.assertFalse(verdict.passed)
        self.assertIn("moved", verdict.reason)

    def test_log_status_not_moving_means_the_commit_was_not_seen(self) -> None:
        stuck = ("mysql-bin.000003", 1461)
        verdict = psp.snapshot_coordinate_verdict(
            opened=stuck, live_before=stuck, inside_after=stuck, live_after=stuck, log_status_after=stuck, rows_before=10, rows_inside=10
        )
        self.assertFalse(verdict.passed)

    def test_a_snapshot_that_saw_the_forced_row_fails(self) -> None:
        opened, later = ("mysql-bin.000003", 1461), ("mysql-bin.000003", 1700)
        verdict = psp.snapshot_coordinate_verdict(
            opened=opened, live_before=opened, inside_after=opened, live_after=later, log_status_after=later, rows_before=10, rows_inside=11
        )
        self.assertFalse(verdict.passed)

    def test_binlog_order_crosses_a_rotation(self) -> None:
        self.assertLess(psp.binlog_order(("mysql-bin.000003", 9000)), psp.binlog_order(("mysql-bin.000004", 157)))
        self.assertLess(psp.binlog_order(("mysql-bin.000009", 100)), psp.binlog_order(("mysql-bin.000010", 100)))


class CommentFindingTests(unittest.TestCase):
    def test_the_form_percona_wrote_is_read_by_the_extractors_pattern(self) -> None:
        finding = psp.comment_finding(f"-- MySQL dump\n\n{PERCONA_COMMENT}\n")
        self.assertEqual(finding.form, "MASTER")
        self.assertEqual(finding.coordinates, ("mysql-bin.000003", 1461))
        self.assertTrue(finding.parsed_by_extractor)
        self.assertIsNotNone(extract_tenant_binlog.SOURCE_DATA_PATTERN.match(PERCONA_COMMENT))

    def test_the_newer_spelling_is_read_here_but_not_by_the_extractor(self) -> None:
        finding = psp.comment_finding(NEW_SPELLING)
        self.assertEqual(finding.form, "REPLICATION SOURCE")
        self.assertEqual(finding.coordinates, ("mysql-bin.000004", 157))
        self.assertFalse(finding.parsed_by_extractor)
        self.assertIn("does NOT parse", finding.text)
        self.assertTrue(psp.comment_verdict(finding).passed)

    def test_a_dump_without_coordinates_cannot_record_the_finding(self) -> None:
        finding = psp.comment_finding("-- MySQL dump\nCREATE TABLE t (id INT);\n")
        self.assertIsNone(finding.form)
        self.assertFalse(psp.comment_verdict(finding).passed)


UUID_A = "11111111-2222-3333-4444-555555555555"
UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class GtidSetTests(unittest.TestCase):
    def test_a_set_is_parsed_merged_and_formatted_back(self) -> None:
        parsed = psp.parse_gtid_set(f"{UUID_A}:1-5:6-9:12,{UUID_B}:3")
        self.assertEqual(parsed, {UUID_A: [(1, 9), (12, 12)], UUID_B: [(3, 3)]})
        self.assertEqual(psp.format_gtid_set(parsed), f"{UUID_A}:1-9:12,{UUID_B}:3")

    def test_line_breaks_in_a_dump_or_a_batch_row_are_ignored(self) -> None:
        text = f"{UUID_A}:1-5,\n{UUID_B}:3"
        self.assertEqual(psp.parse_gtid_set(text), psp.parse_gtid_set(f"{UUID_A}:1-5,{UUID_B}:3"))
        self.assertEqual(psp.normalize_gtid_set(f"{UUID_A}:1-5,\\n{UUID_B}:3"), f"{UUID_A}:1-5,{UUID_B}:3")

    def test_the_empty_set_is_a_set(self) -> None:
        self.assertEqual(psp.parse_gtid_set(""), {})

    def test_text_that_is_not_a_set_is_refused(self) -> None:
        for bad in ("1-5", f"{UUID_A}", f"{UUID_A}:1-5'; DROP DATABASE t1; --", "not-a-uuid:1"):
            with self.assertRaises(ValueError, msg=bad):
                psp.normalize_gtid_set(bad)

    def test_membership_is_by_uuid_and_sequence(self) -> None:
        parsed = psp.parse_gtid_set(f"{UUID_A}:1-5:9")
        self.assertTrue(psp.gtid_contains(parsed, UUID_A.upper(), 5))
        self.assertTrue(psp.gtid_contains(parsed, UUID_A, 9))
        self.assertFalse(psp.gtid_contains(parsed, UUID_A, 6))
        self.assertFalse(psp.gtid_contains(parsed, UUID_B, 1))

    def test_taking_one_transaction_out_splits_the_interval(self) -> None:
        self.assertEqual(psp.gtid_without(f"{UUID_A}:1-9", UUID_A, 5), f"{UUID_A}:1-4:6-9")
        self.assertEqual(psp.gtid_without(f"{UUID_A}:1-9", UUID_A, 9), f"{UUID_A}:1-8")
        self.assertEqual(psp.gtid_without(f"{UUID_A}:1-9", UUID_A, 1), f"{UUID_A}:2-9")
        self.assertEqual(psp.gtid_without(f"{UUID_A}:4", UUID_A, 4), "")

    def test_adding_one_transaction_merges_with_its_neighbours(self) -> None:
        self.assertEqual(psp.gtid_with(f"{UUID_A}:1-4:6-9", UUID_A, 5), f"{UUID_A}:1-9")
        self.assertEqual(psp.gtid_with(f"{UUID_A}:1-4", UUID_A, 7), f"{UUID_A}:1-4:7")

    def test_each_change_is_exactly_one_transaction(self) -> None:
        base = f"{UUID_A}:1-20"
        dropped = psp.parse_gtid_set(psp.gtid_without(base, UUID_A, 11))
        self.assertEqual(sum(last - first + 1 for first, last in dropped[UUID_A]), 19)

    def test_sets_compare_by_content_not_spelling(self) -> None:
        self.assertTrue(psp.same_gtid_set(f"{UUID_A}:1-3:4-9", f"{UUID_A.upper()}:1-9"))
        self.assertFalse(psp.same_gtid_set(f"{UUID_A}:1-9", f"{UUID_A}:1-8"))

    def test_the_dump_says_which_set_its_snapshot_holds(self) -> None:
        dump = f"-- GTID state at the beginning of the backup\n\nSET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{UUID_A}:1-123';\n"
        self.assertEqual(psp.dump_gtid_set(dump), f"{UUID_A}:1-123")
        self.assertEqual(psp.dump_gtid_set(f"SET @@GLOBAL.GTID_PURGED='{UUID_A}:1-5,\n{UUID_B}:1-2';"), f"{UUID_A}:1-5,{UUID_B}:1-2")
        self.assertIsNone(psp.dump_gtid_set("-- MySQL dump\nCREATE TABLE t (id INT);\n"))

    def test_replacing_the_dumps_set_changes_only_that_set(self) -> None:
        dump = f"x\nSET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{UUID_A}:1-123';\ny\n"
        replaced = psp.replace_dump_gtid_set(dump, f"{UUID_A}:1-122")
        self.assertEqual(replaced, f"x\nSET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{UUID_A}:1-122';\ny\n")
        with self.assertRaises(ValueError):
            psp.replace_dump_gtid_set("no set here", f"{UUID_A}:1-2")

    def test_a_dump_holds_the_writers_rows_only(self) -> None:
        dump = "INSERT INTO `posts` VALUES (1,'seed 1','seed-1'),(2,'w3-17','w3-17'),(3,'forced-t1-9','forced-t1-9');"
        self.assertEqual(psp.dump_slugs(dump), frozenset({"w3-17"}))


class BinlogPlacementTests(unittest.TestCase):
    """The source's own binary log, as mysqlbinlog prints it, says which GTID
    committed each posts row."""

    H = "###"  # the prefix mysqlbinlog gives a decoded row
    DECODED = f"""\
SET @@SESSION.GTID_NEXT= '{UUID_A}:7'/*!*/;
BEGIN
/*!*/;
{H} INSERT INTO `t1`.`posts`
{H} SET
{H}   @1=301 /* INT meta=0 nullable=0 is_null=0 */
{H}   @2='w1-7' /* VARSTRING(1020) meta=1020 nullable=0 is_null=0 */
{H}   @3='w1-7' /* VARSTRING(764) meta=764 nullable=0 is_null=0 */
{H} UPDATE `t1`.`posts`
{H} WHERE
{H}   @1=301 /* INT meta=0 nullable=0 is_null=0 */
{H}   @3='w1-7' /* VARSTRING(764) meta=764 nullable=0 is_null=0 */
{H} INSERT INTO `t1`.`emails`
{H} SET
{H}   @1=9 /* INT meta=0 nullable=0 is_null=0 */
COMMIT/*!*/;
SET @@SESSION.GTID_NEXT= '{UUID_A}:8'/*!*/;
BEGIN
{H} INSERT INTO `t2`.`posts`
{H} SET
{H}   @1=12 /* INT meta=0 nullable=0 is_null=0 */
{H}   @2='w2-1' /* VARSTRING(1020) meta=1020 nullable=0 is_null=0 */
{H}   @3='w2-1' /* VARSTRING(764) meta=764 nullable=0 is_null=0 */
COMMIT/*!*/;
SET @@SESSION.GTID_NEXT= 'AUTOMATIC' /* added by mysqlbinlog */ /*!*/;
"""

    def test_each_row_is_placed_at_its_transactions_gtid(self) -> None:
        placements = psp.binlog_placements(self.DECODED)
        self.assertEqual(placements["w1-7"], psp.Placement("t1", UUID_A, 7))
        self.assertEqual(placements["w2-1"], psp.Placement("t2", UUID_A, 8))

    def test_an_updated_row_is_not_a_placement(self) -> None:
        self.assertEqual(sorted(psp.binlog_placements(self.DECODED)), ["w1-7", "w2-1"])

    def test_a_log_with_no_posts_insert_places_nothing(self) -> None:
        self.assertEqual(psp.binlog_placements(f"SET @@SESSION.GTID_NEXT= '{UUID_A}:1'/*!*/;\n### INSERT INTO `t1`.`emails`\n"), {})


class OracleTests(unittest.TestCase):
    """The oracle of control 1: every committed row is in the snapshot or
    after the set the replica is seeded with, and exactly one of the two."""

    PLACED = {
        "w1-1": psp.Placement("t1", UUID_A, 5),
        "w1-2": psp.Placement("t1", UUID_A, 7),
        "w1-3": psp.Placement("t1", UUID_A, 9),
        "w2-1": psp.Placement("t2", UUID_A, 8),
    }
    ROWS = frozenset({"w1-1"})

    def judge(self, rows: frozenset[str], gtid_set: str) -> psp.OracleCount:
        return psp.gtid_oracle(tenant="t1", rows=rows, gtid_set=gtid_set, committed=["w1-1", "w1-2", "w1-3"], placements=self.PLACED)

    def test_a_snapshot_and_its_own_set_are_consistent(self) -> None:
        count = self.judge(frozenset({"w1-1"}), f"{UUID_A}:1-6")
        self.assertEqual((count.lost, count.duplicated, count.unplaced), (0, 0, 0))
        self.assertEqual((count.in_snapshot, count.after_set), (1, 2))
        self.assertTrue(psp.oracle_verdict(count).passed)

    def test_a_row_the_set_holds_but_the_snapshot_lacks_is_lost(self) -> None:
        count = self.judge(frozenset({"w1-1"}), f"{UUID_A}:1-8")
        self.assertEqual(count.lost, 1)
        verdict = psp.oracle_verdict(count)
        self.assertFalse(verdict.passed)
        self.assertIn("LOST t1 w1-2", verdict.reason)

    def test_a_row_the_snapshot_holds_but_the_set_lacks_is_duplicated(self) -> None:
        count = self.judge(frozenset({"w1-1", "w1-2"}), f"{UUID_A}:1-6")
        self.assertEqual(count.duplicated, 1)
        verdict = psp.oracle_verdict(count)
        self.assertFalse(verdict.passed)
        self.assertIn("DUPLICATED t1 w1-2", verdict.reason)

    def test_a_row_the_binary_log_never_placed_blinds_the_oracle(self) -> None:
        count = psp.gtid_oracle(tenant="t1", rows=self.ROWS, gtid_set=f"{UUID_A}:1-6", committed=["w1-1", "w1-9"], placements=self.PLACED)
        self.assertEqual(count.unplaced, 1)
        self.assertFalse(psp.oracle_verdict(count).passed)

    def test_an_oracle_that_saw_one_region_only_proves_nothing(self) -> None:
        nothing_after = self.judge(frozenset({"w1-1", "w1-2", "w1-3"}), f"{UUID_A}:1-10")
        self.assertFalse(psp.oracle_verdict(nothing_after).passed)
        nothing_in_snapshot = self.judge(frozenset(), f"{UUID_A}:1-4")
        self.assertFalse(psp.oracle_verdict(nothing_in_snapshot).passed)
        self.assertFalse(psp.oracle_verdict(psp.OracleCount()).passed)

    def test_counts_add_across_snapshots_and_keep_a_few_examples(self) -> None:
        bad = self.judge(frozenset({"w1-1"}), f"{UUID_A}:1-8")
        total = bad + bad + bad + bad
        self.assertEqual((total.snapshots, total.lost), (4, 4))
        self.assertLessEqual(len(total.examples), psp.ORACLE_EXAMPLES)

    def test_a_gap_in_the_set_is_a_row_after_it(self) -> None:
        # w1-2 (7) sits in the gap of 1-6:8-9: a commit the snapshot could not see yet.
        count = self.judge(frozenset({"w1-1", "w1-3"}), f"{UUID_A}:1-6:8-9")
        self.assertEqual((count.lost, count.duplicated, count.after_set), (0, 0, 1))


class MutationTests(unittest.TestCase):
    """The sabotages change the seeding set by exactly one of a tenant's
    transactions, and the oracle must go red on each."""

    PLACED = {
        "w1-1": psp.Placement("t1", UUID_A, 5),
        "w1-2": psp.Placement("t1", UUID_A, 7),
        "w1-3": psp.Placement("t1", UUID_A, 9),
        "w1-4": psp.Placement("t1", UUID_A, 11),
        "w2-1": psp.Placement("t2", UUID_A, 6),
        "w2-2": psp.Placement("t2", UUID_A, 8),
        "seed-1": psp.Placement("t1", UUID_A, 2),
    }
    ROWS = frozenset({"w1-1", "w1-2", "w1-3"})
    SET = f"{UUID_A}:1-10"
    COMMITTED = ["w1-1", "w1-2", "w1-3", "w1-4"]

    def oracle(self, rows: frozenset[str], gtid_set: str) -> psp.Verdict:
        return psp.oracle_verdict(psp.gtid_oracle(tenant="t1", rows=rows, gtid_set=gtid_set, committed=self.COMMITTED, placements=self.PLACED))

    def test_the_healthy_case_is_green_so_the_red_ones_mean_something(self) -> None:
        self.assertTrue(self.oracle(self.ROWS, self.SET).passed)

    def test_dropping_one_transaction_takes_the_tenants_latest_held_one_and_goes_red(self) -> None:
        changed = psp.mutate_gtid_set("drop", "t1", self.ROWS, self.SET, self.PLACED)
        assert changed is not None
        new_set, what = changed
        self.assertEqual(new_set, f"{UUID_A}:1-8:10")
        self.assertIn(f"{UUID_A}:9", what)
        verdict = self.oracle(self.ROWS, new_set)
        self.assertFalse(verdict.passed)
        self.assertIn("DUPLICATED t1 w1-3", verdict.reason)

    def test_adding_one_transaction_takes_the_tenants_earliest_unheld_one_and_goes_red(self) -> None:
        changed = psp.mutate_gtid_set("extra", "t1", self.ROWS, self.SET, self.PLACED)
        assert changed is not None
        new_set, what = changed
        self.assertEqual(new_set, f"{UUID_A}:1-11")
        self.assertIn(f"{UUID_A}:11", what)
        verdict = self.oracle(self.ROWS, new_set)
        self.assertFalse(verdict.passed)
        self.assertIn("LOST t1 w1-4", verdict.reason)

    def test_another_tenants_transactions_and_the_seed_are_never_chosen(self) -> None:
        drop = psp.mutate_gtid_set("drop", "t1", self.ROWS, self.SET, self.PLACED)
        assert drop is not None
        self.assertNotIn(f"{UUID_A}:6", drop[1])
        self.assertNotIn(f"{UUID_A}:8", drop[1])
        self.assertNotIn(f"{UUID_A}:2)", drop[1])

    def test_a_tenant_with_nothing_to_change_is_left_alone(self) -> None:
        self.assertIsNone(psp.mutate_gtid_set("drop", "t3", self.ROWS, self.SET, self.PLACED))
        self.assertIsNone(psp.mutate_gtid_set("extra", "t1", self.ROWS | {"w1-4"}, self.SET, self.PLACED))

    def test_an_unknown_mutation_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            psp.mutate_gtid_set("shuffle", "t1", self.ROWS, self.SET, self.PLACED)

    def test_every_gtid_sabotage_names_a_mutation_the_function_knows(self) -> None:
        for name, kind in psp.GTID_MUTATIONS.items():
            self.assertIn(name, psp.SABOTAGE_TARGETS)
            self.assertIsNotNone(psp.mutate_gtid_set(kind, "t1", self.ROWS, self.SET, self.PLACED), name)


class StatusParsingTests(unittest.TestCase):
    def test_show_status_rows_become_a_mapping(self) -> None:
        status = psp.parse_status(["Binlog_snapshot_file\tmysql-bin.000003", "Binlog_snapshot_position\t1461", "Binlog_snapshot_gtid_executed\t"])
        self.assertEqual(status["Binlog_snapshot_file"], "mysql-bin.000003")
        self.assertEqual(status["Binlog_snapshot_gtid_executed"], "")

    def test_read_coordinates_takes_the_file_and_position(self) -> None:
        self.assertEqual(psp.read_coordinates(["Binlog_snapshot_file\tmysql-bin.000003", "Binlog_snapshot_position\t1461"]), ("mysql-bin.000003", 1461))


class PlanTests(unittest.TestCase):
    def test_every_sabotage_has_a_plan_a_mode_and_a_seeding_choice(self) -> None:
        for name in psp.SABOTAGE_TARGETS:
            self.assertIn(name, psp.PLANS)
            self.assertIn(name, psp.DUMP_MODES)
            self.assertIn(name, psp.SEEDING)

    def test_every_target_is_a_gating_control_that_exists(self) -> None:
        for name, targets in psp.SABOTAGE_TARGETS.items():
            self.assertTrue(set(targets) <= set(psp.CONTROLS), name)
            self.assertTrue(set(targets) <= set(sp.GATING_CONTROLS), name)

    def test_the_ticket_bodys_sabotage_is_a_checksum_case_without_a_lock(self) -> None:
        self.assertEqual(psp.SABOTAGE_TARGETS["commit-before-coordinates"], (1,))
        self.assertTrue(psp.SEEDING["commit-before-coordinates"])
        self.assertEqual(psp.DUMP_MODES["commit-before-coordinates"], "commit-before-coordinates")

    def test_the_global_lock_case_covers_the_latency_and_lock_controls(self) -> None:
        self.assertEqual(psp.SABOTAGE_TARGETS["global-lock"], (2, 3))
        self.assertFalse(psp.SEEDING["global-lock"])

    def test_the_stock_sabotages_run_on_the_stock_source_and_the_gtid_ones_on_percona(self) -> None:
        self.assertEqual(set(psp.SABOTAGE_SOURCES), set(psp.SABOTAGE_TARGETS))
        self.assertTrue(set(psp.SABOTAGE_SOURCES.values()) <= set(psp.SOURCE_KINDS))
        self.assertEqual(psp.SABOTAGE_SOURCES["commit-before-coordinates"], "stock")
        self.assertEqual(psp.SABOTAGE_SOURCES["global-lock"], "stock")
        for name in psp.GTID_MUTATIONS:
            self.assertEqual(psp.SABOTAGE_SOURCES[name], "percona", name)

    def test_the_gtid_sabotages_target_control_one_and_seed_a_replica(self) -> None:
        for name in psp.GTID_MUTATIONS:
            self.assertEqual(psp.SABOTAGE_TARGETS[name], (1,))
            self.assertTrue(psp.SEEDING[name])
            self.assertEqual(psp.DUMP_MODES[name], "percona")

    def test_the_default_run_is_one_long_round_with_the_long_transaction_then_short_ones(self) -> None:
        plan = psp.PLANS[None]
        self.assertEqual(plan[0], psp.RoundSpec(long_round=True, long_transaction=True))
        self.assertTrue(all(not spec.long_round for spec in plan[1:]))
        self.assertGreaterEqual(len(plan), 5)

    def test_three_writers_per_tenant_run_in_every_round(self) -> None:
        self.assertEqual(psp.WRITERS_PER_TENANT, 3)

    def test_the_long_reader_sleeps_sixty_seconds_on_three_tenants_schemas(self) -> None:
        self.assertEqual(psp.SLEEP_SECONDS, 60)
        self.assertEqual(len(psp.TENANTS), 3)
        self.assertIn(psp.LONG_TENANT, psp.TENANTS)

    def test_exit_codes_follow_snapshot_probe(self) -> None:
        self.assertEqual(psp.exit_code({1: True, 2: True, 3: True, 4: True, 5: True, 6: True}, sabotaged=False), 0)
        self.assertEqual(psp.exit_code({1: False, 2: False}, sabotaged=True), 1)
        self.assertEqual(psp.exit_code({1: True}, sabotaged=True), 2)
        self.assertEqual(psp.exit_code({1: False, 2: True}, sabotaged=False), 3)

    @staticmethod
    def _run(sabotage: str | None) -> psp.Run:
        ctx = sp.Ctx(
            source=sp.Server("snapshot-proof-s", "x"),
            replica=sp.Server("snapshot-proof-r", "x"),
            workdir=pathlib.Path("."),
            passwords=sp.Passwords("a", "b", "c", "d"),
            sabotage=sabotage,
        )
        return psp.Run(ctx, "p")

    @staticmethod
    def dump_argv(sabotage: str | None, *, coordinates: bool = False) -> list[str]:
        return psp.dump_argv(PlanTests._run(sabotage), "t1", coordinates=coordinates)

    def test_a_passing_dump_asks_for_the_gtid_set_and_never_for_file_and_position(self) -> None:
        for name in (None, *psp.GTID_MUTATIONS):
            argv = psp.dump_argv(self._run(name), "t1")
            self.assertIn("--single-transaction", argv)
            self.assertIn("--set-gtid-purged=ON", argv, name)
            self.assertNotIn("--source-data=2", argv, name)
            self.assertEqual(argv[-2:], ["--databases", "t1"])
            self.assertFalse({"--lock-tables", "--lock-all-tables", "--master-data"} & set(argv))

    def test_only_the_recorded_finding_and_the_retired_path_ask_for_file_and_position(self) -> None:
        self.assertIn("--source-data=2", psp.dump_argv(self._run(None), "t1", coordinates=True))
        self.assertIn("--source-data=2", psp.dump_argv(self._run("global-lock"), "t1"))
        self.assertNotIn("--source-data=2", psp.dump_argv(self._run("commit-before-coordinates"), "t1"))
        self.assertNotIn("--set-gtid-purged=ON", psp.dump_argv(self._run("commit-before-coordinates"), "t1"))

    def test_the_seeding_path_never_uses_file_and_position(self) -> None:
        for function in (psp.reseed, psp.start_replication_by_gtid, psp.seed_and_compare, psp.run_round):
            source = inspect.getsource(function)
            self.assertNotIn("MASTER_LOG", source, function.__name__)
            self.assertNotIn("SOURCE_LOG", source, function.__name__)
            self.assertNotIn("read_log_status", source, function.__name__)
        self.assertIn("SOURCE_AUTO_POSITION=1", inspect.getsource(psp.start_replication_by_gtid))


class ProductionFlagsTests(unittest.TestCase):
    """The proof dumps with the production command, called and not copied."""

    @staticmethod
    def _argv(sabotage: str | None, *, coordinates: bool = False) -> list[str]:
        return PlanTests.dump_argv(sabotage, coordinates=coordinates)

    def test_the_percona_dump_is_the_production_command_with_the_account(self) -> None:
        for name in (None, *psp.GTID_MUTATIONS):
            self.assertEqual(self._argv(name), ["mysqldump", "--user=dump_t1", *gtid_snapshot.dump_args("t1")], name)

    def test_a_change_to_the_production_flags_changes_what_the_proof_dumps_with(self) -> None:
        changed = [*gtid_snapshot.dump_args("t1")[:-2], "--hex-blob", "--databases", "t1"]
        with mock.patch.object(gtid_snapshot, "dump_args", return_value=changed):
            self.assertIn("--hex-blob", self._argv(None))
            self.assertIn("--hex-blob", self._argv("global-lock"))
            self.assertIn("--hex-blob", self._argv("commit-before-coordinates"))

    def test_the_stock_cases_differ_from_production_only_where_they_must(self) -> None:
        production = gtid_snapshot.dump_args("t1")
        no_lock = self._argv("commit-before-coordinates")[2:]
        self.assertEqual(no_lock, [("--set-gtid-purged=OFF" if arg == gtid_snapshot.GTID_OPTION else arg) for arg in production])
        retired = self._argv("global-lock")[2:]
        self.assertEqual([arg for arg in retired if arg != "--source-data=2"], no_lock)
        self.assertEqual(retired[-3:], ["--source-data=2", "--databases", "t1"])

    def test_a_production_command_that_lost_its_database_tail_is_refused(self) -> None:
        with mock.patch.object(gtid_snapshot, "dump_args", return_value=["--single-transaction"]):
            with self.assertRaises(sp.ProofError):
                self._argv(None)

    def test_the_workflow_reruns_the_proof_when_the_production_flags_change(self) -> None:
        self.assertEqual(_CI.count("'db/provision/gtid_snapshot.py'"), 2)


class LockSamplerTests(unittest.TestCase):
    """The additive parameter this proof gave snapshot_probe.LockSampler."""

    def test_the_default_account_keeps_the_class_query(self) -> None:
        sampler = sp.LockSampler(sp.Server("snapshot-proof-s", "x"))
        self.assertIn(f"= '{sp.MOVER}'", sampler.sql)
        self.assertEqual(sampler.sql, sp.LockSampler.SQL)

    def test_a_subclass_query_still_wins_for_the_default_account(self) -> None:
        class Other(sp.LockSampler):
            SQL = "SELECT 1;"

        self.assertEqual(Other(sp.Server("snapshot-proof-s", "x")).sql, "SELECT 1;")

    def test_several_accounts_are_queried_together(self) -> None:
        sql = sp.LockSampler.sql_for(["dump_t1", "dump_t2"])
        self.assertIn("IN ('dump_t1', 'dump_t2')", sql)

    def test_an_account_name_that_is_not_a_word_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            sp.LockSampler.sql_for("x' OR '1'='1")


class ImagePinTests(unittest.TestCase):
    def test_the_wrapper_reads_its_percona_digest_from_the_mirror_list(self) -> None:
        self.assertNotRegex(_WRAPPER_TEXT, r"sha256:[0-9a-f]{64}")
        self.assertIn("percona_pin.py index", _WRAPPER_TEXT)

    def test_that_digest_is_on_the_image_mirror_list(self) -> None:
        digest = percona_pin.digest_for(_IMAGES["images"], "index")
        mirrored = {image["digest"] for image in _IMAGES["images"] if image["name"] == "percona-server"}
        self.assertRegex(digest, r"^sha256:[0-9a-f]{64}$")
        self.assertIn(digest, mirrored)

    def test_the_stock_digest_is_read_from_the_runbook_not_typed(self) -> None:
        self.assertNotRegex(_WRAPPER_TEXT, r"mysql:8\.0@sha256:[0-9a-f]{64}")
        self.assertIn("db/RUNBOOK-db.md", _WRAPPER_TEXT)

    def test_the_wrapper_runs_the_probe_with_the_source_kind(self) -> None:
        self.assertIn("percona_snapshot_probe.py run", _WRAPPER_TEXT)
        self.assertIn('--source-kind "$SOURCE_KIND"', _WRAPPER_TEXT)

    def test_both_servers_start_in_gtid_mode_with_the_flags_the_probe_checks(self) -> None:
        for name, want in psp.GTID_SETTINGS:
            self.assertIn(f"--{name}={want}", _WRAPPER_TEXT)
        # One function starts both containers, and it passes the flags.
        self.assertEqual(len(re.findall(r'"\$\{GTID_FLAGS\[@\]\}"', _WRAPPER_TEXT)), 1)
        self.assertEqual(len(re.findall(r'^start_server "\$(?:SOURCE|REPLICA)_IMAGE"', _WRAPPER_TEXT, re.M)), 2)


class WrapperTests(unittest.TestCase):
    def _run(self, *, context: str, extra: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess, str]:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "docker"
            fake.write_text(_FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            log = pathlib.Path(tmp) / "calls.log"
            env = {key: value for key, value in os.environ.items() if key != "DOCKER_HOST"}
            env.update(PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}", FAKE_DOCKER_LOG=str(log), FAKE_DOCKER_CONTEXT=context)
            env.update(extra or {})
            result = subprocess.run(["bash", str(_WRAPPER)], env=env, capture_output=True, text=True, check=False, timeout=120)
            return result, log.read_text(encoding="utf-8") if log.exists() else ""

    def test_a_non_local_docker_context_is_refused_before_any_container(self) -> None:
        result, calls = self._run(context="remote-prod")
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertEqual(calls.strip(), "context show")

    def test_an_ambient_docker_host_is_refused_before_any_docker_call(self) -> None:
        result, calls = self._run(context="default", extra={"DOCKER_HOST": "ssh://somewhere"})
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertIn("DOCKER_HOST", result.stderr)
        self.assertEqual(calls, "")

    def test_a_source_it_does_not_know_is_refused_before_any_container(self) -> None:
        result, calls = self._run(context="default", extra={"PROOF_SOURCE": "oracle-cloud"})
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertIn("oracle-cloud", result.stderr)
        self.assertNotIn("network create", calls)

    def test_the_probe_refuses_a_container_that_is_not_its_own(self) -> None:
        reason = sp.refusal(["prod-db", "snapshot-proof-replica-1"], None, lambda: "default")
        self.assertIn("prod-db", reason)


def _log(sabotage: str, *red: tuple[int, str, str], outcome: bool = True) -> str:
    """A probe log shaped as run_probe prints it: setup lines, then for each
    red control its numbers and its RED line, then the outcome line."""
    lines = ["== setup: source stock, replica percona, on linux/amd64", "  source image:         x"]
    for number, title, reason in red:
        lines += [f"== control {number} (sabotage: {sabotage})", "  a measured number", f"RED control {number}, {title}: {reason}"]
    if outcome:
        lines.append(f"RED as expected under sabotage {sabotage}: the control sees the failure")
    return "\n".join(lines) + "\n"


_LIMIT = f"exceeds the {sp._ms(psp.LATENCY_LIMIT_SECONDS)} limit"
GOOD_LOGS = {
    "commit-before-coordinates": _log(
        "commit-before-coordinates",
        (1, "variables and a GTID set consistent with the snapshot", "1 of 1 rounds failed; first, round 1: replica: t1: 14 tables differ | oracle: 122 committed rows LOST (in the seeding set, not in the snapshot)"),
    ),
    "global-lock": _log(
        "global-lock",
        (2, "no tenant's writes stall", f"round 1: t1: control 2: worst statement 59677.7 ms {_LIMIT} over 800 statements"),
        (3, "no dump lock", "the dump accounts held COMMIT/SHARED/GRANTED, GLOBAL/SHARED/GRANTED"),
    ),
    "gtid-drop-one": _log(
        "gtid-drop-one",
        (1, "variables and a GTID set consistent with the snapshot", "2 of 2 rounds failed; first, round 1: replica: t1: error 1062 | oracle: 3 rows DUPLICATED (in the snapshot, not in the seeding set)"),
    ),
    "gtid-extra-one": _log(
        "gtid-extra-one",
        (1, "variables and a GTID set consistent with the snapshot", "2 of 2 rounds failed; first, round 1: replica: t1: short | oracle: 3 committed rows LOST (in the seeding set, not in the snapshot)"),
    ),
}


class RedReasonTests(unittest.TestCase):
    """Exit 1 is not the stated reason: the wrapper exits 1 on a setup failure
    and a crashed control prints a RED line too."""

    def test_every_sabotage_states_a_reason_on_exactly_its_targeted_controls(self) -> None:
        self.assertEqual(set(psp.RED_REASONS), set(psp.SABOTAGE_TARGETS))
        for name, reasons in psp.RED_REASONS.items():
            self.assertEqual(tuple(reason.control for reason in reasons), psp.SABOTAGE_TARGETS[name], name)

    def test_a_log_with_the_stated_reason_is_accepted(self) -> None:
        for name, log in GOOD_LOGS.items():
            self.assertEqual(psp.red_log_problems(name, log), [], name)

    def test_the_reason_may_follow_on_a_line_after_the_red_line(self) -> None:
        log = GOOD_LOGS["gtid-drop-one"].replace("| oracle:", "\n| oracle:")
        self.assertEqual(psp.red_log_problems("gtid-drop-one", log), [])

    def test_a_setup_failure_that_exits_one_is_not_red(self) -> None:
        log = "== setup: source stock, replica percona, on linux/amd64\nFAILED: snapshot-proof-source-1 never answered a real query\n"
        for name in psp.RED_REASONS:
            problems = psp.red_log_problems(name, log)
            self.assertTrue(any("never reached its verdict" in problem for problem in problems), name)
            self.assertTrue(any("did not go red" in problem for problem in problems), name)

    def test_a_crashed_control_is_not_red_for_the_stated_reason(self) -> None:
        for name, reasons in psp.RED_REASONS.items():
            crashed = _log(name, *((reason.control, "did not complete", "ProofError: replica never started") for reason in reasons))
            problems = psp.red_log_problems(name, crashed)
            self.assertTrue(any("a crash, not the stated reason" in problem for problem in problems), name)
            self.assertTrue(any("without the stated reason" in problem for problem in problems), name)

    def test_the_other_gtid_cases_reason_does_not_stand_in(self) -> None:
        self.assertNotEqual(psp.red_log_problems("gtid-drop-one", GOOD_LOGS["gtid-extra-one"]), [])
        self.assertNotEqual(psp.red_log_problems("gtid-extra-one", GOOD_LOGS["gtid-drop-one"]), [])
        self.assertNotEqual(psp.red_log_problems("commit-before-coordinates", GOOD_LOGS["gtid-drop-one"]), [])

    def test_the_global_lock_case_needs_both_its_controls_red_for_their_reasons(self) -> None:
        only_latency = _log("global-lock", (2, "no tenant's writes stall", f"round 1: t1: control 2: worst statement 59677.7 ms {_LIMIT} over 800 statements"))
        self.assertIn("control 3 did not go red", psp.red_log_problems("global-lock", only_latency))
        no_limit = _log(
            "global-lock",
            (2, "no tenant's writes stall", "no round was measured"),
            (3, "no dump lock", "the dump accounts held COMMIT/SHARED/GRANTED, GLOBAL/SHARED/GRANTED"),
        )
        self.assertTrue(any(f"without the stated reason '{_LIMIT}'" in problem for problem in psp.red_log_problems("global-lock", no_limit)))
        no_global = _log(
            "global-lock",
            (2, "no tenant's writes stall", f"round 1: t1: control 2: worst statement 59677.7 ms {_LIMIT} over 800 statements"),
            (3, "no dump lock", "the sampler never saw a dump account hold a shared-read table lock, so it could not have seen a blocking one"),
        )
        self.assertNotEqual(psp.red_log_problems("global-lock", no_global), [])

    def test_a_control_the_sabotage_does_not_target_going_red_is_named(self) -> None:
        log = _log("gtid-extra-one", *(
            (number, "x", "committed rows LOST (in the seeding set, not in the snapshot)") for number in (1, 4)
        ))
        self.assertIn("control 4 went red but sabotage gtid-extra-one does not target it", psp.red_log_problems("gtid-extra-one", log))

    def test_a_log_without_the_probes_verdict_line_is_refused_even_with_the_reason(self) -> None:
        log = _log("gtid-extra-one", (1, "t", "committed rows LOST (in the seeding set, not in the snapshot)"), outcome=False)
        self.assertTrue(any("never reached its verdict" in problem for problem in psp.red_log_problems("gtid-extra-one", log)))

    def test_an_unknown_sabotage_has_no_stated_reason(self) -> None:
        self.assertEqual(len(psp.red_log_problems("nothing", "")), 1)

    def test_the_command_exits_one_with_the_problem_on_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "log"
            path.write_text("FAILED: setup\n", encoding="utf-8")
            result = subprocess.run(
                ["python3", str(_PROVISION / "percona_snapshot_probe.py"), "check-red", "--sabotage", "gtid-drop-one", "--log", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("RED FOR THE WRONG REASON (gtid-drop-one)", result.stderr)
            path.write_text(GOOD_LOGS["gtid-drop-one"], encoding="utf-8")
            result = subprocess.run(
                ["python3", str(_PROVISION / "percona_snapshot_probe.py"), "check-red", "--sabotage", "gtid-drop-one", "--log", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_reason_strings_are_the_ones_the_probe_prints(self) -> None:
        source = inspect.getsource(psp)
        for needle in ("committed rows LOST (in the seeding set, not in the snapshot)", "rows DUPLICATED (in the snapshot, not in the seeding set)", "the dump accounts held"):
            self.assertIn(f'f"{{count.lost}} {needle}"' if needle.startswith("committed") else needle, source)
        self.assertIn("exceeds the", inspect.getsource(sp.writer_stall_verdict))


class MutationDetectionTests(unittest.TestCase):
    """A GTID red counts only when the oracle, reading the source's binary log,
    saw the change. Disabling that check left every other test green."""

    def test_a_drop_the_oracle_did_not_see_as_duplicated_is_not_red(self) -> None:
        for count in (psp.OracleCount(), psp.OracleCount(1, 5, 2, 3, lost=4, duplicated=0)):
            verdict = psp.undetected_mutation("drop", count)
            assert verdict is not None
            self.assertTrue(verdict.passed)
            self.assertIn("did not see the drop", verdict.reason)

    def test_an_extra_the_oracle_did_not_see_as_lost_is_not_red(self) -> None:
        for count in (psp.OracleCount(), psp.OracleCount(1, 5, 2, 3, lost=0, duplicated=4)):
            verdict = psp.undetected_mutation("extra", count)
            assert verdict is not None
            self.assertTrue(verdict.passed)

    def test_a_change_the_oracle_saw_is_left_to_the_rounds_verdict(self) -> None:
        self.assertIsNone(psp.undetected_mutation("drop", psp.OracleCount(1, 5, 2, 3, duplicated=3)))
        self.assertIsNone(psp.undetected_mutation("extra", psp.OracleCount(1, 5, 2, 3, lost=3)))

    def test_an_unknown_mutation_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            psp.undetected_mutation("swap", psp.OracleCount())

    class _Source:
        """Answers control 1's two reads; the server itself is not under test."""

        def query(self, sql: str) -> list[list[str]]:
            if sql.startswith("SHOW STATUS"):
                return []
            if "@@version" in sql:
                return [["8.0.46-37", "Percona"]]
            return [["1", "ROW", "1", "ON", "ON"]]

    def _control_1(self, sabotage: str, oracle: psp.OracleCount, replica_red: bool) -> sp.ControlResult:
        ctx = sp.Ctx(
            source=self._Source(),  # type: ignore[arg-type]
            replica=sp.Server("snapshot-proof-r", "x"),
            workdir=pathlib.Path("."),
            passwords=sp.Passwords("a", "b", "c", "d"),
            sabotage=sabotage,
        )
        run = psp.Run(ctx, "p", scenario=psp.Scenario(rounds=[psp.Verdict(not replica_red, "replica: t1 differs")], oracle=oracle))
        return psp.control_1(run)

    def test_control_1_is_green_under_a_sabotage_when_the_replica_diverged_and_the_oracle_stayed_quiet(self) -> None:
        for sabotage in psp.GTID_MUTATIONS:
            result = self._control_1(sabotage, psp.OracleCount(1, 5, 2, 3), replica_red=True)
            self.assertTrue(result.verdict.passed, sabotage)
            self.assertIn("did not see", result.verdict.reason)

    def test_control_1_is_red_under_a_sabotage_only_when_the_oracle_saw_the_change(self) -> None:
        seen = {"gtid-drop-one": psp.OracleCount(1, 5, 2, 3, duplicated=3), "gtid-extra-one": psp.OracleCount(1, 5, 2, 3, lost=3)}
        for sabotage, oracle in seen.items():
            result = self._control_1(sabotage, oracle, replica_red=True)
            self.assertFalse(result.verdict.passed, sabotage)

    def test_the_two_mutations_map_to_the_two_sabotages(self) -> None:
        self.assertEqual(psp.GTID_MUTATIONS, {"gtid-drop-one": "drop", "gtid-extra-one": "extra"})


class CiTests(unittest.TestCase):
    def test_the_native_job_pulls_the_percona_pin_from_the_mirror_list(self) -> None:
        self.assertIn("percona_pin.py index", _CI)
        self.assertNotRegex(_CI, r"sha256:[0-9a-f]{64}")

    def test_the_green_proof_runs_un_sabotaged(self) -> None:
        self.assertRegex(_CI, r"run: db/provision/prove-percona-snapshot\.sh\n")

    def test_each_sabotage_must_exit_one_on_its_own_source(self) -> None:
        for name, source in psp.SABOTAGE_SOURCES.items():
            self.assertIn(f"PROOF_SOURCE={source} SABOTAGE={name} db/provision/prove-percona-snapshot.sh", _CI, name)
        self.assertGreaterEqual(len(re.findall(r'test "\$rc" = 1', _CI)), 3 + len(psp.SABOTAGE_TARGETS))

    def test_each_percona_red_step_checks_the_stated_reason_after_the_exit_code(self) -> None:
        for name in psp.SABOTAGE_TARGETS:
            step = re.search(rf'SABOTAGE={name} db/provision/prove-percona-snapshot\.sh.*?(?=\n      - name:|\Z)', _CI, re.DOTALL)
            assert step is not None, name
            lines = [line.strip() for line in step.group(0).splitlines()]
            self.assertIn('test "$rc" = 1', lines, name)
            check = f'python3 db/provision/percona_snapshot_probe.py check-red --sabotage {name} --log "$log"'
            self.assertIn(check, lines, name)
            self.assertLess(lines.index('test "$rc" = 1'), lines.index(check), name)

    def test_the_percona_proof_runs_after_a_failed_red_step(self) -> None:
        self.assertRegex(_CI, r"- name: Run the Percona proof, un-sabotaged\n\s+if: \$\{\{ !cancelled\(\) \}\}\n")

    def test_the_proof_triggers_the_workflow(self) -> None:
        self.assertEqual(_CI.count("'db/provision/percona_snapshot_probe*'"), 2)
        self.assertEqual(_CI.count("'db/provision/prove-percona-snapshot.sh'"), 2)


if __name__ == "__main__":
    unittest.main()
