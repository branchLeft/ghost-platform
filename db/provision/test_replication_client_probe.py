#!/usr/bin/env python3
"""Unit tests for replication_client_probe.py, no Docker. Each control is
judged by a pure verdict function; each is asserted here against a sabotage
fixture that must FAIL and a healthy one that must PASS, so a verdict that
quietly stopped judging turns this suite red. The Docker run is
prove-replication-client.sh, run in snapshot-proof-ci.yml."""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest

import replication_client_probe as rcp

_PROVISION = pathlib.Path(__file__).resolve().parent
_CI = (_PROVISION.parents[1] / ".github" / "workflows" / "snapshot-proof-ci.yml").read_text(encoding="utf-8")
_WRAPPER = _PROVISION / "prove-replication-client.sh"
_FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = context ]; then echo "$FAKE_DOCKER_CONTEXT"; fi
exit 1
"""


class SabotageFixturesTests(unittest.TestCase):
    def test_every_canned_case_behaves(self) -> None:
        self.assertEqual(rcp.self_test(), [])

    def test_each_verdict_has_a_red_and_a_green_case(self) -> None:
        by_verdict: dict[str, set[bool]] = {}
        for label, expected, _ in rcp.SELF_TEST_CASES:
            by_verdict.setdefault(label.split(":")[0], set()).add(expected)
        self.assertEqual(set(by_verdict), {"privileges", "grant_shape", "multiset", "replay", "rounds"})
        for name, outcomes in by_verdict.items():
            self.assertEqual(outcomes, {True, False}, f"{name} needs both a sabotage and a healthy fixture")


class VerdictTests(unittest.TestCase):
    def test_backup_admin_held_alongside_fails_the_privilege_check(self) -> None:
        verdict = rcp.privileges_verdict({"REPLICATION CLIENT", "BACKUP_ADMIN"})
        self.assertFalse(verdict.passed)
        self.assertIn("BACKUP_ADMIN", verdict.reason)

    def test_reload_held_alongside_fails_the_privilege_check(self) -> None:
        self.assertFalse(rcp.privileges_verdict({"REPLICATION CLIENT", "RELOAD"}).passed)

    def test_a_lost_row_is_named(self) -> None:
        verdict = rcp.multiset_verdict("emails by post", {"7": 1, "8": 1}, {"7": 1})
        self.assertFalse(verdict.passed)
        self.assertIn("1 lost ['8']", verdict.reason)

    def test_a_duplicated_row_is_named(self) -> None:
        verdict = rcp.multiset_verdict("emails by post", {"7": 1}, {"7": 2})
        self.assertFalse(verdict.passed)
        self.assertIn("1 duplicated ['7']", verdict.reason)

    def test_a_row_only_on_the_replica_is_a_duplicate(self) -> None:
        self.assertFalse(rcp.multiset_verdict("emails by post", {"7": 1}, {"7": 1, "9": 1}).passed)

    def test_a_replay_that_applied_nothing_is_not_a_pass(self) -> None:
        self.assertFalse(rcp.replay_verdict(300, 300).passed)

    def test_one_failed_round_fails_the_control(self) -> None:
        verdict = rcp.rounds_verdict([rcp.Verdict(True, "ok"), rcp.Verdict(True, "ok"), rcp.Verdict(False, "dup")])
        self.assertFalse(verdict.passed)
        self.assertIn("round 3", verdict.reason)

    def test_the_instance_lock_being_allowed_fails_the_grant_check(self) -> None:
        verdict = rcp.grant_shape_verdict(
            errno_other_schema=1142,
            errno_ftwrl=1227,
            errno_instance_lock=0,
            errno_master_status=0,
            privileges={"REPLICATION CLIENT", "BACKUP_ADMIN"},
        )
        self.assertFalse(verdict.passed)
        self.assertIn("LOCK INSTANCE FOR BACKUP gave error 0", verdict.reason)


class ExitCodeTests(unittest.TestCase):
    def test_all_green_is_a_pass(self) -> None:
        self.assertEqual(rcp.exit_code({1: True, 2: True, 3: True}, sabotaged=False), rcp.EXIT_PASSED)

    def test_a_failed_control_without_sabotage_says_the_grant_is_not_enough(self) -> None:
        self.assertEqual(rcp.exit_code({1: False, 2: True, 3: True}, sabotaged=False), rcp.EXIT_NOT_ADEQUATE)

    def test_no_control_run_is_never_a_pass(self) -> None:
        self.assertEqual(rcp.exit_code({}, sabotaged=False), rcp.EXIT_NOT_ADEQUATE)

    def test_a_sabotage_that_stays_green_is_not_detected(self) -> None:
        self.assertEqual(rcp.exit_code({1: True}, sabotaged=True), rcp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_a_sabotage_that_goes_red_is_detected(self) -> None:
        self.assertEqual(rcp.exit_code({1: False, 3: False}, sabotaged=True), rcp.EXIT_RED)


class SabotageTableTests(unittest.TestCase):
    def test_both_wrong_orderings_target_the_coordinate_control(self) -> None:
        self.assertEqual(rcp.SABOTAGE_TARGETS["coordinates-before-lock"], (1,))
        self.assertEqual(rcp.SABOTAGE_TARGETS["coordinates-after-unlock"], (1,))

    def test_every_target_is_a_control_that_exists(self) -> None:
        for name, targets in rcp.SABOTAGE_TARGETS.items():
            self.assertTrue(set(targets) <= set(rcp.CONTROLS), name)

    def test_every_control_has_a_sabotage_that_turns_it_red(self) -> None:
        covered = {number for targets in rcp.SABOTAGE_TARGETS.values() for number in targets}
        self.assertEqual(covered, set(rcp.CONTROLS))

    def test_grant_sabotages_name_a_known_sabotage(self) -> None:
        self.assertTrue(set(rcp.GRANT_SABOTAGES) <= set(rcp.SABOTAGE_TARGETS))


class WrapperTests(unittest.TestCase):
    def _run(self, *, context: str) -> tuple[subprocess.CompletedProcess, str]:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "docker"
            fake.write_text(_FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            log = pathlib.Path(tmp) / "calls.log"
            env = {key: value for key, value in os.environ.items() if key != "DOCKER_HOST"}
            env.update(PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}", FAKE_DOCKER_LOG=str(log), FAKE_DOCKER_CONTEXT=context)
            result = subprocess.run(["bash", str(_WRAPPER)], env=env, capture_output=True, text=True, check=False, timeout=120)
            return result, log.read_text(encoding="utf-8") if log.exists() else ""

    def test_a_non_local_docker_context_is_refused_before_any_container(self) -> None:
        result, calls = self._run(context="remote-prod")
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertEqual(calls.strip(), "context show")

    def test_a_probe_name_it_does_not_know_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "docker"
            log = pathlib.Path(tmp) / "calls.log"
            fake.write_text(_FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            env = {key: value for key, value in os.environ.items() if key != "DOCKER_HOST"}
            env.update(
                PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}",
                FAKE_DOCKER_LOG=str(log),
                FAKE_DOCKER_CONTEXT="default",
                PROOF_PROBE="other.py",
            )
            result = subprocess.run(
                ["bash", str(_PROVISION / "prove-snapshot-locking.sh")], env=env, capture_output=True, text=True, check=False, timeout=120
            )
            calls = log.read_text(encoding="utf-8") if log.exists() else ""
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertIn("other.py", result.stderr)
        self.assertNotIn("network create", calls)


class CiTests(unittest.TestCase):
    def test_the_native_job_runs_the_replication_client_proof_un_sabotaged(self) -> None:
        self.assertIn("db/provision/prove-replication-client.sh", _CI)

    def test_the_proof_triggers_the_workflow(self) -> None:
        self.assertIn("'db/provision/replication_client_probe*'", _CI)
        self.assertIn("'db/provision/prove-replication-client.sh'", _CI)


if __name__ == "__main__":
    unittest.main()
