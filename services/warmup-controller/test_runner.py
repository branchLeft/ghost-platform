"""One run end to end against real files: what is written, in what order, and what a failure leaves alone."""

from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from scenarios import NOW, TODAY, clean_evidence, clock
from warmup_controller.model import Action, OwnerCards, ResumeCard, SeedPlacement
from warmup_controller.runner import Paths, run_once
from warmup_controller.store import (
    Ledger,
    LedgerError,
    StateCorruptError,
    load_state,
    parse_published,
)


class RunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        root = Path(holder.name)
        self.paths = Paths(root / "controller.json", root / "ip2.json", root / "ledger.jsonl")

    def run_at(self, moment: datetime, real: int = 3) -> Action:
        evidence = clean_evidence(real=real, at=moment)
        return run_once(evidence, lambda: moment, self.paths).action

    def test_a_first_run_starts_at_stage_1_and_holds_on_three_real_readers(self) -> None:
        decision = run_once(clean_evidence(real=3), clock, self.paths)
        self.assertEqual(decision.action, Action.HOLD)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertEqual((published.stage, published.held, published.effective_cap), (1, False, 50))
        state = load_state(self.paths.controller_state)
        self.assertIsNotNone(state)
        self.assertEqual(Ledger(self.paths.ledger).rows()[0]["day"], TODAY.isoformat())

    def test_a_day_with_no_real_mail_is_logged_as_a_wait_not_an_advance(self) -> None:
        run_once(clean_evidence(real=0, seed=500), clock, self.paths)
        rows = Ledger(self.paths.ledger).rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["action"], "wait")
        self.assertEqual(rows[0]["stageAfter"], 1)
        self.assertEqual(rows[0]["realSent"], 0)
        self.assertEqual(rows[0]["seedSentNotCounted"], 500)
        self.assertEqual(rows[0]["reasons"][0], "no_real_mail")  # type: ignore[index]

    def test_every_day_gets_one_row_and_the_ledger_only_grows(self) -> None:
        sizes: list[int] = []
        for offset in range(10):
            self.run_at(NOW + timedelta(days=offset), real=0)
            sizes.append(self.paths.ledger.stat().st_size)
        self.assertEqual(len(Ledger(self.paths.ledger).rows()), 10)
        self.assertEqual(sizes, sorted(set(sizes)))

    def test_a_second_run_on_a_day_adds_no_second_daily_row(self) -> None:
        run_once(clean_evidence(real=3), clock, self.paths)
        run_once(clean_evidence(real=3), clock, self.paths)
        self.assertEqual(len(Ledger(self.paths.ledger).rows()), 1)

    def test_a_stop_is_an_event_row_even_when_the_day_has_its_row(self) -> None:
        run_once(clean_evidence(real=3), clock, self.paths)
        spoiled = dataclasses.replace(clean_evidence(real=3), seed_placement=SeedPlacement.SPAM)
        run_once(spoiled, clock, self.paths)
        rows = Ledger(self.paths.ledger).rows()
        self.assertEqual(
            [(r["kind"], r["action"]) for r in rows], [("daily", "hold"), ("event", "stop")]
        )
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertTrue(published.held)

    def test_the_stop_survives_to_the_next_run_and_the_card_resumes_it(self) -> None:
        spoiled = dataclasses.replace(clean_evidence(real=3), seed_placement=SeedPlacement.SPAM)
        run_once(spoiled, clock, self.paths)
        later = NOW + timedelta(days=1)
        held = run_once(clean_evidence(real=3, at=later), lambda: later, self.paths)
        self.assertEqual(held.action, Action.HOLD)
        self.assertTrue(held.state.held)
        card = OwnerCards(resume=ResumeCard(stopped_at=NOW))
        resumed = run_once(clean_evidence(real=3, at=later), lambda: later, self.paths, card)
        self.assertEqual(resumed.action, Action.RESUME)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertFalse(published.held)

    def test_a_ledger_that_cannot_be_written_changes_no_state(self) -> None:
        run_once(clean_evidence(real=3), clock, self.paths)
        controller = self.paths.controller_state.read_bytes()
        published = self.paths.published_state.read_bytes()
        later = NOW + timedelta(days=1)
        with (
            mock.patch.object(Ledger, "append", side_effect=LedgerError("full")),
            self.assertRaises(LedgerError),
        ):
            run_once(clean_evidence(real=3, at=later), lambda: later, self.paths)
        self.assertEqual(self.paths.controller_state.read_bytes(), controller)
        self.assertEqual(self.paths.published_state.read_bytes(), published)

    def test_a_stop_reaches_the_collector_file_even_if_the_controller_state_write_fails(
        self,
    ) -> None:
        run_once(clean_evidence(real=3), clock, self.paths)
        spoiled = dataclasses.replace(clean_evidence(real=3), seed_placement=SeedPlacement.SPAM)
        with (
            mock.patch("warmup_controller.runner.save_state", side_effect=OSError("crash")),
            self.assertRaises(OSError),
        ):
            run_once(spoiled, clock, self.paths)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertTrue(published.held)

    def test_a_half_written_ledger_does_not_block_a_stop_from_being_published(self) -> None:
        run_once(clean_evidence(real=3), clock, self.paths)
        with self.paths.ledger.open("a", encoding="utf-8") as handle:
            handle.write('{"kind": "ev')  # a row cut off mid-write, no newline
        blocklisted = dataclasses.replace(clean_evidence(real=3), blocklisted_now=True)
        decision = run_once(blocklisted, clock, self.paths)
        self.assertEqual(decision.action, Action.STOP)
        self.assertIn("ledger_unwritable", decision.alerts)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertTrue(published.held)

    def test_a_corrupt_controller_state_stops_the_run_before_any_write(self) -> None:
        self.paths.controller_state.write_text("{")
        with self.assertRaises(StateCorruptError):
            run_once(clean_evidence(real=3), clock, self.paths)
        self.assertFalse(self.paths.ledger.exists())
        self.assertFalse(self.paths.published_state.exists())

    def test_an_advance_on_a_second_run_of_the_day_is_written_to_the_ledger(self) -> None:
        start = datetime.combine(TODAY - timedelta(days=7), NOW.timetz())
        self.run_at(start, real=30)
        missing = dataclasses.replace(clean_evidence(real=30), feeds={})
        run_once(missing, clock, self.paths)  # the day's daily row: hold
        later = NOW + timedelta(hours=1)
        decision = run_once(clean_evidence(real=30, at=later), lambda: later, self.paths)
        self.assertEqual(decision.action, Action.ADVANCE)
        rows = Ledger(self.paths.ledger).rows()
        self.assertEqual(
            [(r["kind"], r["action"]) for r in rows[-2:]], [("daily", "hold"), ("event", "advance")]
        )
        self.assertEqual(rows[-1]["stageAfter"], 2)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertEqual(published.stage, 2)

    def test_a_clean_run_advances_and_publishes_the_new_stage(self) -> None:
        first = TODAY - timedelta(days=7)
        start = datetime.combine(first, NOW.timetz())
        self.run_at(start, real=30)
        decision = run_once(clean_evidence(real=30), clock, self.paths)
        self.assertEqual(decision.action, Action.ADVANCE)
        published = parse_published(json.loads(self.paths.published_state.read_text()))
        self.assertEqual(published.stage, 2)
        self.assertEqual(Ledger(self.paths.ledger).rows()[-1]["action"], "advance")


if __name__ == "__main__":
    unittest.main()
