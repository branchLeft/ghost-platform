"""The state-file writer and the ledger append: whole files, nothing overwritten, nothing guessed."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from scenarios import NOW, TODAY, clean_evidence, clock, ready_state
from warmup_controller.decide import decide
from warmup_controller.model import ControllerState
from warmup_controller.stages import DestinationGroup
from warmup_controller.store import (
    Ledger,
    LedgerError,
    PublishedState,
    StateCorruptError,
    ledger_row,
    load_state,
    parse_published,
    published_from,
    save_state,
    write_json_atomic,
    write_published,
)


class TempDir(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.dir = Path(holder.name)


class AtomicWriteTests(TempDir):
    def test_writes_the_whole_file_and_leaves_nothing_else(self) -> None:
        target = self.dir / "state.json"
        write_json_atomic(target, {"stage": 1})
        self.assertEqual(json.loads(target.read_text()), {"stage": 1})
        self.assertEqual([p.name for p in self.dir.iterdir()], ["state.json"])

    def test_a_failed_write_keeps_the_old_file_and_leaves_no_temp(self) -> None:
        target = self.dir / "state.json"
        write_json_atomic(target, {"stage": 1})
        with mock.patch("os.replace", side_effect=OSError("disk")), self.assertRaises(OSError):
            write_json_atomic(target, {"stage": 2})
        self.assertEqual(json.loads(target.read_text()), {"stage": 1})
        self.assertEqual([p.name for p in self.dir.iterdir()], ["state.json"])


class PublishedStateTests(TempDir):
    def test_the_file_has_the_collectors_three_keys_and_the_cap(self) -> None:
        decision = decide(clean_evidence(), ready_state(), clock)
        target = self.dir / "ip2.json"
        write_published(target, published_from(decision))
        raw = json.loads(target.read_text())
        self.assertEqual(set(raw), {"stage", "held", "destinationHolds", "effectiveCap"})
        self.assertEqual(raw["stage"], 2)
        self.assertIs(raw["held"], False)
        self.assertEqual(raw["destinationHolds"], [])
        self.assertEqual(parse_published(raw), published_from(decision))

    def test_destination_holds_are_written_by_name(self) -> None:
        published = PublishedState(3, False, (DestinationGroup.GMAIL, DestinationGroup.YAHOO), 90)
        self.assertEqual(published.to_json()["destinationHolds"], ["gmail", "yahoo"])

    def test_what_the_collector_would_refuse_is_refused(self) -> None:
        bad: list[object] = [
            [],
            {"stage": 0, "held": False, "destinationHolds": [], "effectiveCap": 50},
            {"stage": 8, "held": False, "destinationHolds": [], "effectiveCap": 50},
            {"stage": True, "held": False, "destinationHolds": [], "effectiveCap": 50},
            {"stage": 1, "held": "no", "destinationHolds": [], "effectiveCap": 50},
            {"stage": 1, "held": False, "destinationHolds": "gmail", "effectiveCap": 50},
            {"stage": 1, "held": False, "destinationHolds": ["aol"], "effectiveCap": 50},
            {"stage": 1, "held": False, "destinationHolds": [], "effectiveCap": -1},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(StateCorruptError):
                parse_published(raw)


class ControllerStateFileTests(TempDir):
    def test_a_missing_file_is_a_first_run(self) -> None:
        self.assertIsNone(load_state(self.dir / "absent.json"))

    def test_round_trip(self) -> None:
        state = ControllerState(
            stage=4,
            stage_since=TODAY,
            held=True,
            destination_holds=(DestinationGroup.MICROSOFT,),
            last_advance_day=TODAY - timedelta(days=9),
            stopped_at=NOW,
            stop_reasons=("blocklist", "seed_in_spam"),
            last_step_down_at=NOW - timedelta(days=3),
        )
        target = self.dir / "controller.json"
        save_state(target, state)
        self.assertEqual(load_state(target), state)

    def test_a_file_that_cannot_be_read_exactly_is_never_guessed_at(self) -> None:
        target = self.dir / "controller.json"
        for text in ("", "{", "[]", '{"version": 2}', '{"version": 1, "stage": 9}'):
            with self.subTest(text=text):
                target.write_text(text)
                with self.assertRaises(StateCorruptError):
                    load_state(target)

    def test_a_time_with_no_zone_is_refused(self) -> None:
        target = self.dir / "controller.json"
        save_state(target, ready_state())
        raw = json.loads(target.read_text())
        raw["stoppedAt"] = "2026-12-01T06:00:00"
        target.write_text(json.dumps(raw))
        with self.assertRaises(StateCorruptError):
            load_state(target)


class LedgerTests(TempDir):
    def row(self, day: date, kind: str = "daily") -> dict[str, object]:
        return {"kind": kind, "day": day.isoformat(), "action": "hold"}

    def test_rows_are_appended_one_line_each_and_earlier_bytes_never_change(self) -> None:
        ledger = Ledger(self.dir / "ledger.jsonl")
        before = b""
        for offset in range(4):
            ledger.append(self.row(TODAY + timedelta(days=offset)))
            now = (self.dir / "ledger.jsonl").read_bytes()
            self.assertTrue(now.startswith(before))
            self.assertGreater(len(now), len(before))
            before = now
        self.assertEqual(len(ledger.rows()), 4)
        self.assertEqual(before.count(b"\n"), 4)

    def test_a_second_daily_row_for_a_day_is_refused_and_nothing_is_written(self) -> None:
        ledger = Ledger(self.dir / "ledger.jsonl")
        ledger.append(self.row(TODAY))
        before = (self.dir / "ledger.jsonl").read_bytes()
        with self.assertRaises(LedgerError):
            ledger.append(self.row(TODAY))
        self.assertEqual((self.dir / "ledger.jsonl").read_bytes(), before)

    def test_event_rows_add_to_a_day_that_already_has_its_daily_row(self) -> None:
        ledger = Ledger(self.dir / "ledger.jsonl")
        ledger.append(self.row(TODAY))
        ledger.append(self.row(TODAY, kind="event"))
        ledger.append(self.row(TODAY, kind="event"))
        self.assertEqual([r["kind"] for r in ledger.rows()], ["daily", "event", "event"])
        self.assertTrue(ledger.has_daily(TODAY))
        self.assertFalse(ledger.has_daily(TODAY + timedelta(days=1)))

    def test_a_half_written_last_row_stops_every_append(self) -> None:
        path = self.dir / "ledger.jsonl"
        path.write_bytes(b'{"kind": "daily", "day": "2026-12-01"}\n{"kind": "da')
        before = path.read_bytes()
        with self.assertRaises(LedgerError):
            Ledger(path).append(self.row(TODAY))
        self.assertEqual(path.read_bytes(), before)

    def test_a_line_that_is_not_a_row_stops_every_append(self) -> None:
        path = self.dir / "ledger.jsonl"
        for text in (b"nonsense\n", b"[1]\n"):
            with self.subTest(text=text):
                path.write_bytes(text)
                with self.assertRaises(LedgerError):
                    Ledger(path).append(self.row(TODAY))
                self.assertEqual(path.read_bytes(), text)

    def test_a_row_carries_each_gate_with_its_value_and_why(self) -> None:
        decision = decide(clean_evidence(real=3), ready_state(), clock)
        row = ledger_row(decision, "daily", NOW, real_sent=3, seed_sent=40)
        self.assertEqual(row["action"], "hold")
        self.assertEqual(row["realSent"], 3)
        self.assertEqual(row["seedSentNotCounted"], 40)
        self.assertEqual(row["reasons"], ["evidence_floor"])
        gates = {g["name"]: g for g in row["gates"]}  # type: ignore[attr-defined]
        self.assertEqual(gates["evidence_floor"]["passed"], False)
        self.assertEqual(gates["evidence_floor"]["value"], "0 of 7 days")
        self.assertEqual(json.loads(json.dumps(row)), row)


if __name__ == "__main__":
    unittest.main()
