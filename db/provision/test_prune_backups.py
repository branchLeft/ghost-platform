#!/usr/bin/env python3
"""Unit tests for prune_backups.py.

`plan_prune` is a data-destroying decision made with no human in the loop
between the decision and the delete, so this file's job is to make every way
the invariant could quietly break into a test that fails loudly instead: a
missed or failed nightly dump, a binlog rotation whose shipped timestamp
lands on the wrong side of a cutoff, a clock-skew-exact boundary second, and
the refusal path itself -- proving the function declines to prune rather
than silently opening a gap when it cannot be sure the retained set still
covers the window.
"""

import datetime
import os
import unittest
from unittest import mock

import prune_backups as pb

NOW = datetime.datetime(2026, 8, 24, 3, 0, 0, tzinfo=datetime.timezone.utc)
UUID_A = "aaaaaaaa-0000-0000-0000-000000000000"
UUID_B = "bbbbbbbb-1111-1111-1111-111111111111"


def _dump(uuid, days_ago):
    ts = NOW - datetime.timedelta(days=days_ago)
    return pb.DumpObject(key=f"dumps/{uuid}/db1-{ts.strftime('%Y%m%dT%H%M%SZ')}.sql.age", server_uuid=uuid, timestamp=ts)


def _binlog(uuid, seq, days_ago):
    ts = NOW - datetime.timedelta(days=days_ago)
    log_name = f"mysql-bin.{seq:06d}"
    return pb.BinlogObject(key=f"binlogs/{uuid}/db1-{log_name}.age", server_uuid=uuid, log_name=log_name, timestamp=ts)


class PlanPruneDumpRetentionTests(unittest.TestCase):
    def test_keeps_the_anchor_and_everything_within_retention_days(self):
        dumps = [_dump(UUID_A, days_ago=d) for d in range(0, 21)]
        plan = pb.plan_prune(dumps, [], now=NOW)
        expected_deleted = {_dump(UUID_A, days_ago=d).key for d in range(10, 21)}
        self.assertEqual({d.key for d in plan.delete_dumps}, expected_deleted)
        self.assertEqual(plan.refusals, [])

    def test_a_missed_run_of_nightly_dumps_keeps_the_only_anchor_available(self):
        # Two dumps, an 11-day gap between them. Naive age-based deletion
        # (older than RETENTION_DAYS=10) would delete the day-15 dump and
        # leave nothing covering the PITR window's far edge.
        recent = _dump(UUID_A, days_ago=3)
        old_anchor = _dump(UUID_A, days_ago=15)
        plan = pb.plan_prune([recent, old_anchor], [], now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(plan.refusals, [])

    def test_a_dump_that_failed_mid_run_never_produces_an_object_and_is_the_same_case_as_a_gap(self):
        # dump_nightly.py uploads only after mysqldump and age both succeed,
        # so a failed run leaves no object at all -- to this function, a
        # week of failed runs looks exactly like a week nobody ran the dump.
        # Day 15 is the only dump old enough to anchor the window (days 1-3
        # are all inside it), so it must survive despite being well past
        # RETENTION_DAYS on its own.
        surviving = [_dump(UUID_A, days_ago=d) for d in (1, 2, 3, 15)]
        plan = pb.plan_prune(surviving, [], now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(plan.refusals, [])

    def test_a_dump_exactly_at_the_pitr_boundary_second_is_kept_as_the_anchor(self):
        # Inclusive comparison at the boundary matters: a clock-skewed
        # second either way must not tip this dump out of the anchor role.
        boundary = pb.DumpObject(
            key=f"dumps/{UUID_A}/db1-boundary.sql.age",
            server_uuid=UUID_A,
            timestamp=NOW - datetime.timedelta(days=pb.PITR_WINDOW_DAYS),
        )
        newer = _dump(UUID_A, days_ago=1)
        plan = pb.plan_prune([boundary, newer], [], now=NOW)
        self.assertNotIn(boundary.key, {d.key for d in plan.delete_dumps})

    def test_nothing_is_deleted_before_any_dump_reaches_the_window_boundary(self):
        dumps = [_dump(UUID_A, days_ago=d) for d in range(0, 5)]
        plan = pb.plan_prune(dumps, [], now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(plan.refusals, [])

    def test_server_uuid_groups_are_pruned_independently(self):
        healthy = [_dump(UUID_A, days_ago=d) for d in range(0, 21)]
        # A dead incarnation (db1 was rebuilt): no new objects ever land
        # under UUID_B again, so it ages out to a single surviving anchor.
        dead_incarnation = [_dump(UUID_B, days_ago=d) for d in (25, 30, 40)]
        plan = pb.plan_prune(healthy + dead_incarnation, [], now=NOW)
        b_deleted = {d.key for d in plan.delete_dumps if d.server_uuid == UUID_B}
        self.assertEqual(b_deleted, {_dump(UUID_B, days_ago=30).key, _dump(UUID_B, days_ago=40).key})
        self.assertNotIn(_dump(UUID_B, days_ago=25).key, b_deleted)


class PlanPruneBinlogRetentionTests(unittest.TestCase):
    def test_binlogs_are_kept_back_to_a_stretched_anchor_past_retention_days(self):
        anchor = _dump(UUID_A, days_ago=15)  # a missed-dump gap stretches the anchor back
        recent_dump = _dump(UUID_A, days_ago=1)
        binlogs = [_binlog(UUID_A, seq=s, days_ago=21 - s) for s in range(1, 21)]
        plan = pb.plan_prune([anchor, recent_dump], binlogs, now=NOW)
        cutoff = NOW - datetime.timedelta(days=15)
        expected_deleted = {b.key for b in binlogs if b.timestamp < cutoff}
        expected_kept = {b.key for b in binlogs if b.timestamp >= cutoff}
        self.assertEqual({b.key for b in plan.delete_binlogs}, expected_deleted)
        self.assertEqual({b.key for b in plan.delete_binlogs} & expected_kept, set())

    def test_a_binlog_exactly_at_the_cutoff_second_is_kept_not_deleted(self):
        anchor = _dump(UUID_A, days_ago=pb.PITR_WINDOW_DAYS)
        recent_dump = _dump(UUID_A, days_ago=1)
        boundary_binlog = pb.BinlogObject(
            key=f"binlogs/{UUID_A}/db1-mysql-bin.000001.age",
            server_uuid=UUID_A,
            log_name="mysql-bin.000001",
            timestamp=NOW - datetime.timedelta(days=pb.RETENTION_DAYS),
        )
        plan = pb.plan_prune([anchor, recent_dump], [boundary_binlog], now=NOW)
        self.assertNotIn(boundary_binlog.key, {b.key for b in plan.delete_binlogs})

    def test_deleted_binlogs_are_always_a_clean_prefix_by_sequence(self):
        # A binlog file's rotation can straddle the cutoff -- opened before
        # it, closed (and so timestamped) after -- so the guarantee this
        # test pins is about sequence order, not raw timestamps.
        anchor = _dump(UUID_A, days_ago=8)
        recent_dump = _dump(UUID_A, days_ago=1)
        binlogs = [_binlog(UUID_A, seq=s, days_ago=20 - s) for s in range(1, 21)]
        plan = pb.plan_prune([anchor, recent_dump], binlogs, now=NOW)
        deleted_seqs = {pb._binlog_sequence(b.log_name) for b in plan.delete_binlogs}
        kept_seqs = {pb._binlog_sequence(b.log_name) for b in binlogs} - deleted_seqs
        if deleted_seqs and kept_seqs:
            self.assertLess(max(deleted_seqs), min(kept_seqs))


class PlanPruneRefusalTests(unittest.TestCase):
    def test_refuses_to_delete_every_shipped_binlog_when_that_would_strand_the_anchor(self):
        anchor = _dump(UUID_A, days_ago=12)
        recent_dump = _dump(UUID_A, days_ago=1)
        only_binlog = _binlog(UUID_A, seq=1, days_ago=20)  # older than the anchor itself
        plan = pb.plan_prune([anchor, recent_dump], [only_binlog], now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(plan.delete_binlogs, [])
        self.assertEqual(len(plan.refusals), 1)
        self.assertEqual(plan.refusals[0].server_uuid, UUID_A)
        self.assertIn("unreplayable", plan.refusals[0].reason)

    def test_a_refusal_blocks_dump_deletions_in_the_same_group_too(self):
        # day-100's dump is ordinary surplus (older than the anchor) and
        # would be deleted on its own -- proving the refusal discards the
        # whole group's plan, not just the binlog half of it.
        ancient_surplus = _dump(UUID_A, days_ago=100)
        anchor = _dump(UUID_A, days_ago=12)
        recent_dump = _dump(UUID_A, days_ago=1)
        only_binlog = _binlog(UUID_A, seq=1, days_ago=20)
        plan = pb.plan_prune([ancient_surplus, anchor, recent_dump], [only_binlog], now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(len(plan.refusals), 1)

    def test_refuses_when_binlog_sequence_order_does_not_track_ship_time(self):
        anchor = _dump(UUID_A, days_ago=8)
        recent_dump = _dump(UUID_A, days_ago=1)
        # seq 2 timestamped as shipped BEFORE seq 1 -- impossible under the
        # real pipeline, but this function must not trust a timestamp-only
        # cutoff split if it ever sees an ordering like this.
        scrambled = [
            pb.BinlogObject(
                key=f"binlogs/{UUID_A}/db1-mysql-bin.000002.age",
                server_uuid=UUID_A,
                log_name="mysql-bin.000002",
                timestamp=NOW - datetime.timedelta(days=15),
            ),
            pb.BinlogObject(
                key=f"binlogs/{UUID_A}/db1-mysql-bin.000001.age",
                server_uuid=UUID_A,
                log_name="mysql-bin.000001",
                timestamp=NOW - datetime.timedelta(days=5),
            ),
        ]
        plan = pb.plan_prune([anchor, recent_dump], scrambled, now=NOW)
        self.assertEqual(plan.delete_dumps, [])
        self.assertEqual(plan.delete_binlogs, [])
        self.assertEqual(len(plan.refusals), 1)
        self.assertIn("monotonic", plan.refusals[0].reason)

    def test_an_unparseable_binlog_name_refuses_only_its_own_server_uuid(self):
        # Group A has one binlog with no trailing digits -- _binlog_sequence
        # can't parse it. That must not stop group B, an otherwise-healthy
        # incarnation, from being pruned in the same run.
        anchor_a = _dump(UUID_A, days_ago=12)
        recent_a = _dump(UUID_A, days_ago=1)
        malformed_binlog = pb.BinlogObject(
            key=f"binlogs/{UUID_A}/db1-mysql-bin-no-number.age",
            server_uuid=UUID_A,
            log_name="mysql-bin-no-number",
            timestamp=NOW - datetime.timedelta(days=20),
        )
        recent_binlog_a = _binlog(UUID_A, seq=1, days_ago=1)

        old_surplus_b = _dump(UUID_B, days_ago=100)
        anchor_b = _dump(UUID_B, days_ago=12)
        recent_b = _dump(UUID_B, days_ago=1)
        binlogs_b = [_binlog(UUID_B, seq=s, days_ago=20 - s) for s in range(1, 21)]

        plan = pb.plan_prune(
            [anchor_a, recent_a, old_surplus_b, anchor_b, recent_b],
            [malformed_binlog, recent_binlog_a, *binlogs_b],
            now=NOW,
        )

        a_refusals = [r for r in plan.refusals if r.server_uuid == UUID_A]
        self.assertEqual(len(a_refusals), 1)
        self.assertIn("unparseable", a_refusals[0].reason)
        # Nothing in group A was touched -- the refusal discards its whole plan.
        self.assertEqual([d for d in plan.delete_dumps if d.server_uuid == UUID_A], [])
        self.assertEqual([b for b in plan.delete_binlogs if b.server_uuid == UUID_A], [])

        # Group B is untouched by A's problem: its ordinary surplus dump is
        # still deleted and its anchor still survives.
        self.assertIn(old_surplus_b.key, {d.key for d in plan.delete_dumps})
        self.assertNotIn(anchor_b.key, {d.key for d in plan.delete_dumps})
        self.assertEqual([r for r in plan.refusals if r.server_uuid == UUID_B], [])


class PlanPruneNoDumpsTests(unittest.TestCase):
    def test_a_server_uuid_with_binlogs_but_no_dumps_is_left_untouched(self):
        # Named explicitly in the review brief as a scenario to attack:
        # eligible_anchors is empty (there is no dump at all), so the group
        # must be skipped rather than mishandled.
        orphan_binlogs = [_binlog(UUID_A, seq=s, days_ago=20 - s) for s in range(1, 21)]
        healthy = [_dump(UUID_B, days_ago=d) for d in range(0, 21)]
        plan = pb.plan_prune(healthy, orphan_binlogs, now=NOW)
        self.assertEqual([d for d in plan.delete_dumps if d.server_uuid == UUID_A], [])
        self.assertEqual([b for b in plan.delete_binlogs if b.server_uuid == UUID_A], [])
        self.assertEqual([r for r in plan.refusals if r.server_uuid == UUID_A], [])


class CoverageReportTests(unittest.TestCase):
    def test_covered_when_the_oldest_binlog_is_at_or_before_the_oldest_dump(self):
        dumps = [_dump(UUID_A, days_ago=10)]
        binlogs = [_binlog(UUID_A, seq=1, days_ago=10), _binlog(UUID_A, seq=2, days_ago=1)]
        rows = pb.coverage_report(dumps, binlogs)
        self.assertEqual(rows, [pb.CoverageRow(UUID_A, dumps[0].timestamp, binlogs[0].timestamp, "covered")])

    def test_gap_when_the_oldest_binlog_is_newer_than_the_oldest_dump(self):
        dumps = [_dump(UUID_A, days_ago=10)]
        binlogs = [_binlog(UUID_A, seq=1, days_ago=5)]
        rows = pb.coverage_report(dumps, binlogs)
        self.assertEqual(rows[0].status, "gap")

    def test_no_dump_reported_when_only_binlogs_exist(self):
        binlogs = [_binlog(UUID_A, seq=1, days_ago=1)]
        rows = pb.coverage_report([], binlogs)
        self.assertEqual(rows[0].status, "no dump")
        self.assertIsNone(rows[0].oldest_dump)

    def test_no_binlog_reported_when_only_a_dump_exists(self):
        dumps = [_dump(UUID_A, days_ago=1)]
        rows = pb.coverage_report(dumps, [])
        self.assertEqual(rows[0].status, "no binlog")
        self.assertIsNone(rows[0].oldest_binlog)

    def test_rows_are_independent_per_server_uuid(self):
        # The bug this replaces: a bucket-wide min() would have reported
        # UUID_B's ancient, forever-kept anchor as "the" oldest dump and
        # hidden UUID_A's real gap behind it.
        dumps = [_dump(UUID_A, days_ago=10), _dump(UUID_B, days_ago=100)]
        binlogs = [_binlog(UUID_A, seq=1, days_ago=5), _binlog(UUID_B, seq=1, days_ago=100)]
        rows = {row.server_uuid: row for row in pb.coverage_report(dumps, binlogs)}
        self.assertEqual(rows[UUID_A].status, "gap")
        self.assertEqual(rows[UUID_B].status, "covered")


class ParseObjectsTests(unittest.TestCase):
    def test_parses_dump_keys_and_uses_last_modified_not_the_key_timestamp(self):
        listing = [
            {
                "key": f"dumps/{UUID_A}/db1-20260801T031000Z.sql.age",
                "last_modified": "2026-08-01T03:10:05.000Z",
            }
        ]
        objs = pb.parse_dump_objects(listing)
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0].server_uuid, UUID_A)
        self.assertEqual(objs[0].timestamp, datetime.datetime(2026, 8, 1, 3, 10, 5, tzinfo=datetime.timezone.utc))

    def test_ignores_keys_that_do_not_match_the_dump_pattern(self):
        listing = [{"key": f"binlogs/{UUID_A}/db1-mysql-bin.000001.age", "last_modified": "2026-08-01T00:00:00Z"}]
        self.assertEqual(pb.parse_dump_objects(listing), [])

    def test_parses_binlog_keys_and_the_log_name(self):
        listing = [{"key": f"binlogs/{UUID_A}/db1-mysql-bin.000042.age", "last_modified": "2026-08-01T00:00:00Z"}]
        objs = pb.parse_binlog_objects(listing)
        self.assertEqual(objs[0].log_name, "mysql-bin.000042")
        self.assertEqual(objs[0].server_uuid, UUID_A)

    def test_ignores_keys_that_do_not_match_the_binlog_pattern(self):
        listing = [{"key": f"dumps/{UUID_A}/db1-20260801T000000Z.sql.age", "last_modified": "2026-08-01T00:00:00Z"}]
        self.assertEqual(pb.parse_binlog_objects(listing), [])


class BuildAndApplyPlanTests(unittest.TestCase):
    def test_build_plan_lists_both_prefixes_and_feeds_plan_prune(self):
        calls = []

        def fake_lister(*, bucket, endpoint, region, access_key, secret_key, prefix):
            calls.append(prefix)
            if prefix == "dumps/":
                old = NOW - datetime.timedelta(days=20)
                return [{"key": f"dumps/{UUID_A}/db1-x.sql.age", "last_modified": old.strftime("%Y-%m-%dT%H:%M:%SZ")}]
            return []

        plan = pb.build_plan(
            bucket="b", endpoint="e", region="r", access_key="ak", secret_key="sk", now=NOW, lister=fake_lister
        )
        self.assertEqual(sorted(calls), ["binlogs/", "dumps/"])
        # The single dump is its own anchor (nothing newer exists yet) --
        # kept, not deleted.
        self.assertEqual(plan.delete_dumps, [])

    def test_apply_plan_deletes_every_object_named_in_the_plan(self):
        deleted = []

        def fake_remover(*, bucket, endpoint, region, access_key, secret_key, key):
            deleted.append(key)

        plan = pb.PrunePlan(
            delete_dumps=[_dump(UUID_A, days_ago=20)],
            delete_binlogs=[_binlog(UUID_A, seq=1, days_ago=20)],
            refusals=[],
        )
        pb.apply_plan(plan, bucket="b", endpoint="e", region="r", access_key="ak", secret_key="sk", remover=fake_remover)
        self.assertEqual(deleted, [plan.delete_dumps[0].key, plan.delete_binlogs[0].key])

    def test_build_coverage_report_lists_both_prefixes_and_feeds_coverage_report(self):
        calls = []

        def fake_lister(*, bucket, endpoint, region, access_key, secret_key, prefix):
            calls.append(prefix)
            ts = (NOW - datetime.timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
            if prefix == "dumps/":
                return [{"key": f"dumps/{UUID_A}/db1-20260101T000000Z.sql.age", "last_modified": ts}]
            return [{"key": f"binlogs/{UUID_A}/db1-mysql-bin.000001.age", "last_modified": ts}]

        rows = pb.build_coverage_report(
            bucket="b", endpoint="e", region="r", access_key="ak", secret_key="sk", lister=fake_lister
        )
        self.assertEqual(sorted(calls), ["binlogs/", "dumps/"])
        self.assertEqual(rows[0].server_uuid, UUID_A)
        self.assertEqual(rows[0].status, "covered")


class MainTests(unittest.TestCase):
    ENV = {
        "DB_BACKUP_BUCKET": "branchleft-db-backups",
        "DB_BACKUP_ENDPOINT": "hel1.your-objectstorage.com",
        "DB_BACKUP_REGION": "hel1",
        "AWS_ACCESS_KEY_ID": "AK",
        "AWS_SECRET_ACCESS_KEY": "SECRET",
    }

    def test_missing_env_var_fails_before_any_listing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(pb.main([]), 1)

    def test_dry_run_never_applies_the_plan(self):
        plan = pb.PrunePlan(delete_dumps=[_dump(UUID_A, days_ago=20)], delete_binlogs=[], refusals=[])
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            pb, "build_plan", return_value=plan
        ), mock.patch.object(pb, "apply_plan") as apply_mock:
            code = pb.main(["--dry-run"])
        self.assertEqual(code, 0)
        apply_mock.assert_not_called()

    def test_a_refusal_exits_nonzero_but_still_applies_what_is_safe(self):
        plan = pb.PrunePlan(delete_dumps=[], delete_binlogs=[], refusals=[pb.Refusal(UUID_A, "reason")])
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            pb, "build_plan", return_value=plan
        ), mock.patch.object(pb, "apply_plan") as apply_mock:
            code = pb.main([])
        self.assertEqual(code, 1)
        apply_mock.assert_called_once()

    def test_a_clean_plan_exits_zero_and_applies(self):
        plan = pb.PrunePlan(delete_dumps=[_dump(UUID_A, days_ago=20)], delete_binlogs=[], refusals=[])
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            pb, "build_plan", return_value=plan
        ), mock.patch.object(pb, "apply_plan") as apply_mock:
            code = pb.main([])
        self.assertEqual(code, 0)
        apply_mock.assert_called_once()

    def test_verify_coverage_exits_zero_when_every_row_is_covered(self):
        rows = [pb.CoverageRow(UUID_A, NOW, NOW, "covered")]
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            pb, "build_coverage_report", return_value=rows
        ), mock.patch.object(pb, "apply_plan") as apply_mock, mock.patch.object(pb, "build_plan") as build_plan_mock:
            code = pb.main(["--verify-coverage"])
        self.assertEqual(code, 0)
        apply_mock.assert_not_called()
        build_plan_mock.assert_not_called()

    def test_verify_coverage_exits_nonzero_on_any_gap(self):
        rows = [pb.CoverageRow(UUID_A, NOW, NOW, "covered"), pb.CoverageRow(UUID_B, NOW, NOW, "gap")]
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            pb, "build_coverage_report", return_value=rows
        ):
            code = pb.main(["--verify-coverage"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
