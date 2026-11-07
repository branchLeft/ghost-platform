#!/usr/bin/env python3
"""Unit tests for percona_snapshot_probe.py, no Docker. Each control is judged
by a pure verdict function; each is asserted here against a sabotage fixture
that must FAIL and a healthy one that must PASS, so a verdict that quietly
stopped judging turns this suite red. The Docker run is
prove-percona-snapshot.sh, run in snapshot-proof-ci.yml."""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import tempfile
import unittest

import extract_tenant_binlog
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


class SabotageFixturesTests(unittest.TestCase):
    def test_every_canned_case_behaves(self) -> None:
        self.assertEqual(psp.self_test(), [])

    def test_each_verdict_has_a_red_and_a_green_case(self) -> None:
        by_verdict: dict[str, set[bool]] = {}
        for label, expected, _ in psp.SELF_TEST_CASES:
            by_verdict.setdefault(label.split(":")[0], set()).add(expected)
        self.assertEqual(set(by_verdict), {"variables", "latency", "dump_lock", "grant", "snapshot_coordinate", "comment"})
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
        verdict = psp.variables_verdict({}, {"log_bin": "1", "binlog_format": "ROW", "sync_binlog": "1"})
        self.assertFalse(verdict.passed)
        self.assertIn("Binlog_snapshot_file", verdict.reason)

    def test_statement_format_fails_the_variable_check(self) -> None:
        verdict = psp.variables_verdict(dict.fromkeys(psp.SNAPSHOT_STATUS, ""), {"log_bin": "1", "binlog_format": "STATEMENT", "sync_binlog": "1"})
        self.assertFalse(verdict.passed)
        self.assertIn("binlog_format", verdict.reason)

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


class MissingRowTests(unittest.TestCase):
    """The diagnosis printed when a seeded replica lacks a row: the source's
    own binary log, not the replica, says where that row's transaction sits."""

    DECODED = (
        "# at 100\n#241107 12:00:00 server id 1  end_log_pos 200\n### INSERT INTO `t1`.`posts`\n### SET\n###   @2='w1-7'\n###   @3='w1-7'\n"
        "# at 200\n### INSERT INTO `t1`.`emails`\n"
    )

    def test_the_event_position_is_the_last_at_before_the_row(self) -> None:
        self.assertEqual(psp.binlog_event_position(self.DECODED, "w1-7"), 100)

    def test_a_row_not_in_the_log_has_no_position(self) -> None:
        self.assertIsNone(psp.binlog_event_position(self.DECODED, "w9-9"))

    def test_before_the_coordinates_and_absent_from_the_dump_means_the_coordinates_ran_ahead(self) -> None:
        text = psp.classify_missing(event_position=2900137, coordinates=("mysql-bin.000003", 2901402), in_dump=False)
        self.assertIn("coordinates ran ahead of the snapshot", text)

    def test_after_the_coordinates_means_the_replay_lost_it(self) -> None:
        text = psp.classify_missing(event_position=3000000, coordinates=("mysql-bin.000003", 2901402), in_dump=False)
        self.assertIn("the replay should have applied it", text)
        self.assertNotIn("ran ahead", text)

    def test_in_the_dump_means_the_load_or_replay_lost_it(self) -> None:
        text = psp.classify_missing(event_position=10, coordinates=("mysql-bin.000003", 2901402), in_dump=True)
        self.assertIn("in the dump but not on the replica", text)

    def test_a_row_not_found_in_the_coordinates_file_says_so(self) -> None:
        self.assertIn("mysql-bin.000003", psp.classify_missing(event_position=None, coordinates=("mysql-bin.000003", 5), in_dump=False))


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

    def test_the_sabotages_run_on_the_stock_source(self) -> None:
        self.assertEqual(psp.SABOTAGE_SOURCE, "stock")
        self.assertIn(psp.SABOTAGE_SOURCE, psp.SOURCE_KINDS)

    def test_the_default_run_is_one_long_round_with_the_long_transaction_then_short_ones(self) -> None:
        plan = psp.PLANS[None]
        self.assertEqual(plan[0], psp.RoundSpec(long_round=True, long_transaction=True))
        self.assertTrue(all(not spec.long_round for spec in plan[1:]))
        self.assertGreaterEqual(len(plan), 2)

    def test_the_long_reader_sleeps_sixty_seconds_on_three_tenants_schemas(self) -> None:
        self.assertEqual(psp.SLEEP_SECONDS, 60)
        self.assertEqual(len(psp.TENANTS), 3)
        self.assertIn(psp.LONG_TENANT, psp.TENANTS)

    def test_exit_codes_follow_snapshot_probe(self) -> None:
        self.assertEqual(psp.exit_code({1: True, 2: True, 3: True, 4: True, 5: True, 6: True}, sabotaged=False), 0)
        self.assertEqual(psp.exit_code({1: False, 2: False}, sabotaged=True), 1)
        self.assertEqual(psp.exit_code({1: True}, sabotaged=True), 2)
        self.assertEqual(psp.exit_code({1: False, 2: True}, sabotaged=False), 3)

    def test_the_dump_arguments_leave_source_data_off_only_for_the_stock_no_lock_case(self) -> None:
        for name, mode in psp.DUMP_MODES.items():
            ctx = sp.Ctx(
                source=sp.Server("snapshot-proof-s", "x"),
                replica=sp.Server("snapshot-proof-r", "x"),
                workdir=pathlib.Path("."),
                passwords=sp.Passwords("a", "b", "c", "d"),
                sabotage=name,
            )
            argv = psp.dump_argv(psp.Run(ctx, "p"), "t1")
            self.assertIn("--single-transaction", argv)
            self.assertEqual("--source-data=2" in argv, mode != "commit-before-coordinates", name)
            self.assertEqual(argv[-2:], ["--databases", "t1"])
            self.assertFalse({"--lock-tables", "--lock-all-tables", "--master-data"} & set(argv))


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
    def test_the_wrapper_pins_one_percona_digest(self) -> None:
        self.assertRegex(psp.pinned_percona(_WRAPPER_TEXT), r"^percona/percona-server@sha256:[0-9a-f]{64}$")

    def test_that_digest_is_on_the_image_mirror_list(self) -> None:
        digest = psp.pinned_percona(_WRAPPER_TEXT).split("@", 1)[1]
        mirrored = {image["digest"] for image in _IMAGES["images"] if image["name"] == "percona-server"}
        self.assertIn(digest, mirrored)

    def test_two_digests_in_the_wrapper_would_be_refused(self) -> None:
        with self.assertRaises(ValueError):
            psp.pinned_percona("percona/percona-server@sha256:" + "a" * 64 + " percona/percona-server@sha256:" + "b" * 64)

    def test_the_stock_digest_is_read_from_the_runbook_not_typed(self) -> None:
        self.assertNotRegex(_WRAPPER_TEXT, r"mysql:8\.0@sha256:[0-9a-f]{64}")
        self.assertIn("db/RUNBOOK-db.md", _WRAPPER_TEXT)

    def test_the_wrapper_runs_the_probe_with_the_source_kind(self) -> None:
        self.assertIn("percona_snapshot_probe.py run", _WRAPPER_TEXT)
        self.assertIn('--source-kind "$SOURCE_KIND"', _WRAPPER_TEXT)


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


class CiTests(unittest.TestCase):
    def test_the_native_job_pulls_the_percona_pin_from_the_wrapper(self) -> None:
        self.assertIn("db/provision/prove-percona-snapshot.sh", _CI)
        self.assertRegex(_CI, r"percona/percona-server@sha256:\[0-9a-f\]\{64\}")
        self.assertNotRegex(_CI, r"percona/percona-server@sha256:[0-9a-f]{64}")

    def test_the_green_proof_runs_un_sabotaged(self) -> None:
        self.assertRegex(_CI, r"run: db/provision/prove-percona-snapshot\.sh\n")

    def test_each_sabotage_must_exit_one(self) -> None:
        for name in psp.SABOTAGE_TARGETS:
            self.assertIn(f"PROOF_SOURCE=stock SABOTAGE={name} db/provision/prove-percona-snapshot.sh", _CI, name)
        self.assertGreaterEqual(len(re.findall(r'test "\$rc" = 1', _CI)), 3 + len(psp.SABOTAGE_TARGETS))

    def test_the_proof_triggers_the_workflow(self) -> None:
        self.assertEqual(_CI.count("'db/provision/percona_snapshot_probe*'"), 2)
        self.assertEqual(_CI.count("'db/provision/prove-percona-snapshot.sh'"), 2)


if __name__ == "__main__":
    unittest.main()
