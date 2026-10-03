#!/usr/bin/env python3
"""Unit tests for promotion_gate.py: every branch of the decision table.

The real-server proof is prove-promotion-gate.sh; see promotion_gate.md.
"""

from __future__ import annotations

import io
import subprocess
import unittest
from contextlib import redirect_stdout

import promotion_gate as gate

SOURCE_UUID = "3e11fa47-71ca-11e1-9e33-c80aa9429562"
OTHER_UUID = "9a2b7c1d-0000-11ef-8000-0242ac120002"
FROZEN = gate.FrozenSource(SOURCE_UUID, "mysql-bin.000007", 5000)


def status(**overrides: str) -> dict[str, str]:
    row = {
        "Source_UUID": SOURCE_UUID,
        "Replica_IO_Running": "Yes",
        "Replica_SQL_Running": "Yes",
        "Last_IO_Errno": "0",
        "Last_SQL_Errno": "0",
        "Last_SQL_Error": "",
        "Relay_Source_Log_File": "mysql-bin.000007",
        "Exec_Source_Log_Pos": "5000",
        "Seconds_Behind_Source": "0",
    }
    row.update(overrides)
    return row


def decide(**overrides: str) -> gate.Verdict:
    return gate.evaluate(FROZEN, [status(**overrides)])


class PromoteTests(unittest.TestCase):
    def test_promotes_at_exact_coordinates_with_both_threads_running(self):
        verdict = decide()
        self.assertEqual(verdict.decision, gate.PROMOTE)
        self.assertIn("mysql-bin.000007:5000", verdict.reason)

    def test_uuid_comparison_ignores_case(self):
        self.assertEqual(decide(Source_UUID=SOURCE_UUID.upper()).decision, gate.PROMOTE)

    def test_lag_is_never_read(self):
        # The same positions promote whatever lag says, and lag never rescues a refusal.
        for lag in ("0", "NULL", "86400", ""):
            self.assertEqual(decide(Seconds_Behind_Source=lag).decision, gate.PROMOTE)
        without = status()
        del without["Seconds_Behind_Source"]
        self.assertEqual(gate.evaluate(FROZEN, [without]).decision, gate.PROMOTE)
        self.assertNotIn("Seconds_Behind_Source", gate.REQUIRED_FIELDS)


class DisconnectedReplicaTests(unittest.TestCase):
    """LLD-10's measured failure: IO thread Connecting, zero lag, a post missing."""

    def test_connecting_with_zero_lag_behind_the_freeze_is_not_promoted(self):
        verdict = decide(Replica_IO_Running="Connecting", Exec_Source_Log_Pos="4200", Seconds_Behind_Source="0")
        self.assertEqual(verdict.decision, gate.WAIT)
        self.assertIn("behind", verdict.reason)

    def test_connecting_at_the_frozen_position_still_waits(self):
        self.assertEqual(decide(Replica_IO_Running="Connecting").decision, gate.WAIT)

    def test_io_error_at_the_frozen_position_waits(self):
        self.assertEqual(decide(Last_IO_Errno="2003").decision, gate.WAIT)

    def test_io_thread_stopped_abandons(self):
        for state in ("No", "", "Maybe"):
            verdict = decide(Replica_IO_Running=state)
            self.assertEqual(verdict.decision, gate.ABANDON, state)
            self.assertIn("IO thread", verdict.reason)


class BehindTests(unittest.TestCase):
    def test_lower_position_in_the_same_file_waits(self):
        self.assertEqual(decide(Exec_Source_Log_Pos="4999").decision, gate.WAIT)

    def test_earlier_file_waits_even_at_a_higher_position(self):
        verdict = decide(Relay_Source_Log_File="mysql-bin.000006", Exec_Source_Log_Pos="900000")
        self.assertEqual(verdict.decision, gate.WAIT)


class PastTheFreezeTests(unittest.TestCase):
    def test_higher_position_in_the_same_file_abandons(self):
        verdict = decide(Exec_Source_Log_Pos="5001")
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("past the frozen coordinates", verdict.reason)

    def test_later_file_abandons_even_at_a_lower_position(self):
        verdict = decide(Relay_Source_Log_File="mysql-bin.000008", Exec_Source_Log_Pos="157")
        self.assertEqual(verdict.decision, gate.ABANDON)

    def test_sequence_compares_numerically_not_as_text(self):
        frozen = gate.FrozenSource(SOURCE_UUID, "mysql-bin.999999", 4)
        row = status(Relay_Source_Log_File="mysql-bin.1000000", Exec_Source_Log_Pos="4")
        self.assertEqual(gate.evaluate(frozen, [row]).decision, gate.ABANDON)
        row = status(Relay_Source_Log_File="mysql-bin.999998", Exec_Source_Log_Pos="4")
        self.assertEqual(gate.evaluate(frozen, [row]).decision, gate.WAIT)


class SqlThreadTests(unittest.TestCase):
    def test_sql_error_abandons_even_at_the_frozen_position(self):
        verdict = decide(Last_SQL_Errno="1062", Last_SQL_Error="Duplicate entry '7' for key 'posts.PRIMARY'")
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("1062", verdict.reason)
        self.assertIn("Duplicate entry", verdict.reason)

    def test_sql_error_abandons_while_behind(self):
        verdict = decide(Last_SQL_Errno="1032", Replica_SQL_Running="No", Exec_Source_Log_Pos="10")
        self.assertEqual(verdict.decision, gate.ABANDON)

    def test_sql_thread_stopped_without_error_abandons(self):
        for state in ("No", "", "yes"):
            verdict = decide(Replica_SQL_Running=state)
            self.assertEqual(verdict.decision, gate.ABANDON, state)
            self.assertIn("SQL thread", verdict.reason)


class CoordinatesMismatchTests(unittest.TestCase):
    def test_different_source_abandons(self):
        verdict = decide(Source_UUID=OTHER_UUID)
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("coordinates mismatch", verdict.reason)

    def test_never_connected_replica_has_no_source_uuid_and_abandons(self):
        self.assertEqual(decide(Source_UUID="", Replica_IO_Running="Connecting").decision, gate.ABANDON)

    def test_different_binary_log_base_abandons(self):
        verdict = decide(Relay_Source_Log_File="binlog.000007")
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("coordinates mismatch", verdict.reason)


class UnknownStateTests(unittest.TestCase):
    def test_no_rows_abandons(self):
        verdict = gate.evaluate(FROZEN, [])
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("found 0", verdict.reason)

    def test_two_channels_abandon(self):
        self.assertEqual(gate.evaluate(FROZEN, [status(), status()]).decision, gate.ABANDON)

    def test_each_missing_field_abandons(self):
        for key in gate.REQUIRED_FIELDS:
            row = status()
            del row[key]
            verdict = gate.evaluate(FROZEN, [row])
            self.assertEqual(verdict.decision, gate.ABANDON, key)
            self.assertIn(key, verdict.reason)

    def test_pre_8_0_22_column_names_abandon(self):
        row = {k.replace("Replica", "Slave").replace("Source", "Master"): v for k, v in status().items()}
        self.assertEqual(gate.evaluate(FROZEN, [row]).decision, gate.ABANDON)

    def test_non_numeric_fields_abandon(self):
        for key, value in (
            ("Exec_Source_Log_Pos", "NULL"),
            ("Exec_Source_Log_Pos", "-1"),
            ("Exec_Source_Log_Pos", ""),
            ("Last_SQL_Errno", "x"),
            ("Last_IO_Errno", ""),
        ):
            verdict = decide(**{key: value})
            self.assertEqual(verdict.decision, gate.ABANDON, (key, value))
            self.assertIn("unusable input", verdict.reason)

    def test_unparsable_relay_file_abandons(self):
        for value in ("", "mysql-bin", "relay/mysql-bin.000007"):
            self.assertEqual(decide(Relay_Source_Log_File=value).decision, gate.ABANDON, value)


class FrozenInputTests(unittest.TestCase):
    def test_bad_frozen_coordinates_abandon(self):
        for frozen in (
            gate.FrozenSource("not-a-uuid", "mysql-bin.000007", 5000),
            gate.FrozenSource(SOURCE_UUID, "mysql-bin", 5000),
            gate.FrozenSource(SOURCE_UUID, "mysql-bin.000007", 3),
        ):
            verdict = gate.evaluate(frozen, [status()])
            self.assertEqual(verdict.decision, gate.ABANDON, frozen)
            self.assertIn("unusable input", verdict.reason)


VERTICAL = """\
*************************** 1. row ***************************
             Replica_IO_State: Waiting for source to send event
                  Source_Host: 127.0.0.1
        Relay_Source_Log_File: mysql-bin.000007
          Exec_Source_Log_Pos: 5000
           Replica_IO_Running: Yes
          Replica_SQL_Running: Yes
                Last_IO_Errno: 0
               Last_SQL_Errno: 0
               Last_SQL_Error:
                  Source_UUID: 3e11fa47-71ca-11e1-9e33-c80aa9429562
        Seconds_Behind_Source: 0
            Executed_Gtid_Set: 3e11fa47-71ca-11e1-9e33-c80aa9429562:1-5,
9a2b7c1d-0000-11ef-8000-0242ac120002:1-2
"""


class ParseTests(unittest.TestCase):
    def test_parses_vertical_output(self):
        rows = gate.parse_replica_status(VERTICAL)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Source_Host"], "127.0.0.1")
        self.assertEqual(rows[0]["Last_SQL_Error"], "")
        self.assertEqual(rows[0]["Replica_IO_State"], "Waiting for source to send event")
        self.assertTrue(rows[0]["Executed_Gtid_Set"].endswith("\n9a2b7c1d-0000-11ef-8000-0242ac120002:1-2"))
        self.assertEqual(gate.evaluate(FROZEN, rows).decision, gate.PROMOTE)

    def test_empty_output_is_no_rows(self):
        self.assertEqual(gate.parse_replica_status(""), [])
        self.assertEqual(gate.parse_replica_status("\n  \n"), [])

    def test_two_rows(self):
        text = VERTICAL + VERTICAL.replace("1. row", "2. row")
        self.assertEqual(len(gate.parse_replica_status(text)), 2)

    def test_text_before_a_row_header_is_refused(self):
        with self.assertRaises(gate.GateInputError):
            gate.parse_replica_status("Warning: something\n" + VERTICAL)

    def test_repeated_field_is_refused(self):
        with self.assertRaises(gate.GateInputError):
            gate.parse_replica_status(VERTICAL + "          Exec_Source_Log_Pos: 9999\n")

    def test_continuation_without_a_field_is_refused(self):
        with self.assertRaises(gate.GateInputError):
            gate.parse_replica_status("*************************** 1. row ***************************\n  ???\n")


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def readings(*results):
    queue = list(results)

    def read():
        result = queue.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    return read


class WaitTests(unittest.TestCase):
    def wait(self, read, timeout=10.0, poll=1.0):
        fake = FakeClock()
        verdict = gate.wait_for_promotion(
            FROZEN, read, timeout_seconds=timeout, poll_seconds=poll, clock=fake.clock, sleep=fake.sleep
        )
        return verdict, fake

    def test_waits_then_promotes_once_caught_up(self):
        verdict, fake = self.wait(
            readings([status(Exec_Source_Log_Pos="4000")], [status(Exec_Source_Log_Pos="4500")], [status()])
        )
        self.assertEqual(verdict.decision, gate.PROMOTE)
        self.assertEqual(fake.sleeps, [1.0, 1.0])

    def test_abandons_at_once_without_waiting(self):
        verdict, fake = self.wait(readings([status(Last_SQL_Errno="1062")]))
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertEqual(fake.sleeps, [])

    def test_times_out_into_abandon(self):
        behind = [status(Replica_IO_Running="Connecting", Exec_Source_Log_Pos="4000")]
        verdict, fake = self.wait(lambda: behind, timeout=3.0)
        self.assertEqual(verdict.decision, gate.ABANDON)
        self.assertIn("timed out after 3s", verdict.reason)
        self.assertIn("behind", verdict.reason)
        self.assertEqual(sum(fake.sleeps), 3.0)

    def test_status_read_error_abandons(self):
        for error in (gate.StatusReadError("exit 1: access denied"), gate.GateInputError("garbled")):
            verdict, _ = self.wait(readings(error))
            self.assertEqual(verdict.decision, gate.ABANDON)
            self.assertIn("could not be read", verdict.reason)

    def test_non_positive_bounds_abandon(self):
        for timeout, poll in ((0, 1), (-1, 1), (10, 0)):
            verdict, _ = self.wait(readings(), timeout=timeout, poll=poll)
            self.assertEqual(verdict.decision, gate.ABANDON)


class FakeRun:
    def __init__(self, returncode=0, stdout="", stderr="", raises=None):
        self.result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        self.raises = raises
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if self.raises:
            raise self.raises
        return self.result


class CommandReaderTests(unittest.TestCase):
    def test_parses_command_output(self):
        run = FakeRun(stdout=VERTICAL)
        rows = gate.command_status_reader(["status"], timeout_seconds=5, run=run)()
        self.assertEqual(rows[0]["Exec_Source_Log_Pos"], "5000")
        self.assertEqual(run.calls[0][1]["timeout"], 5)
        self.assertFalse(run.calls[0][1]["check"])

    def test_nonzero_exit_is_a_read_error(self):
        reader = gate.command_status_reader(["status"], timeout_seconds=5, run=FakeRun(returncode=1, stderr="denied"))
        with self.assertRaisesRegex(gate.StatusReadError, "denied"):
            reader()

    def test_hang_or_missing_binary_is_a_read_error(self):
        for raises in (subprocess.TimeoutExpired(["status"], 5), FileNotFoundError("status")):
            reader = gate.command_status_reader(["status"], timeout_seconds=5, run=FakeRun(raises=raises))
            with self.assertRaises(gate.StatusReadError):
                reader()


class MainTests(unittest.TestCase):
    ARGS = [
        "--source-uuid", SOURCE_UUID,
        "--source-log-file", "mysql-bin.000007",
        "--source-log-position", "5000",
        "--timeout", "0.2",
        "--poll", "0.1",
    ]  # fmt: skip

    def run_main(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = gate.main(argv)
        return code, out.getvalue()

    def printing(self, text):
        return ["--", "python3", "-c", f"import sys; sys.stdout.write({text!r})"]

    def test_promote_exits_zero(self):
        code, out = self.run_main(self.ARGS + self.printing(VERTICAL))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("PROMOTE: "))

    def test_refusal_exits_one_and_says_do_not_promote(self):
        code, out = self.run_main(self.ARGS + self.printing(VERTICAL.replace("Pos: 5000", "Pos: 4000")))
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("DO NOT PROMOTE: timed out"))

    def test_failing_status_command_refuses(self):
        code, out = self.run_main(self.ARGS + ["--", "false"])
        self.assertEqual(code, 1)
        self.assertIn("could not be read", out)

    def test_missing_status_command_refuses(self):
        for tail in ([], ["--"]):
            code, out = self.run_main(self.ARGS + tail)
            self.assertEqual(code, 2)
            self.assertTrue(out.startswith("DO NOT PROMOTE"))

    def test_unexpected_exception_refuses(self):
        original = gate.wait_for_promotion

        def explode(*args, **kwargs):
            raise RuntimeError("boom")

        gate.wait_for_promotion = explode
        try:
            code, out = self.run_main(self.ARGS + ["--", "true"])
        finally:
            gate.wait_for_promotion = original
        self.assertEqual(code, 1)
        self.assertIn("gate failed", out)


if __name__ == "__main__":
    unittest.main()
