"""Tests that need no Docker: the contract's own rules and its controls.

The live proof is `harness.py`; these tests prove the contract can fail. Each
`sabotage` test changes one thing the platform relies on and requires red.
"""

from __future__ import annotations

import re
import unittest
from collections.abc import Mapping
from pathlib import Path

import contract
from contract import FACTS, Fact, Json, failing, problems

HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parent.parent


def expected_observations() -> dict[str, Json]:
    return {fact.key: fact.expected for fact in FACTS}


def with_value(base: Mapping[str, Json], key: str, value: Json) -> dict[str, Json]:
    changed = dict(base)
    changed[key] = value
    return changed


class ProblemsRule(unittest.TestCase):
    def test_equal_observation_holds(self) -> None:
        self.assertEqual(problems([Fact("a", "claim", 1)], {"a": 1}), [])

    def test_different_observation_is_named(self) -> None:
        found = problems([Fact("a", "claim", 1)], {"a": 2})
        self.assertEqual(len(found), 1)
        self.assertIn("a:", found[0])

    def test_missing_observation_is_a_problem(self) -> None:
        self.assertEqual(problems([Fact("a", "claim", 1)], {}), ["a: not observed"])

    def test_at_most_and_at_least(self) -> None:
        self.assertEqual(problems([Fact("a", "c", 10, "le")], {"a": 10}), [])
        self.assertEqual(len(problems([Fact("a", "c", 10, "le")], {"a": 11})), 1)
        self.assertEqual(problems([Fact("a", "c", 10, "ge")], {"a": 10}), [])
        self.assertEqual(len(problems([Fact("a", "c", 10, "ge")], {"a": 9})), 1)

    def test_a_bound_never_holds_for_text(self) -> None:
        self.assertEqual(len(problems([Fact("a", "c", 10, "le")], {"a": "5"})), 1)


class ContractShape(unittest.TestCase):
    def test_fact_keys_are_unique(self) -> None:
        keys = [fact.key for fact in FACTS]
        self.assertEqual(len(keys), len(set(keys)))

    def test_every_required_variable_has_a_stated_effect_when_missing(self) -> None:
        self.assertEqual(set(contract.REQUIRED_ENV), set(contract.ENV_WHEN_MISSING))
        for name in contract.REQUIRED_ENV:
            self.assertIn(f"env.missing.{name}", {fact.key for fact in FACTS})

    def test_every_route_has_a_fact(self) -> None:
        keys = {fact.key for fact in FACTS}
        for route in contract.ROUTES:
            self.assertIn(route.key, keys)

    def test_the_pin_is_a_full_commit(self) -> None:
        self.assertRegex(contract.UPSTREAM_COMMIT, r"^[0-9a-f]{40}$")

    def test_the_pin_matches_the_image_build_when_it_exists(self) -> None:
        pin = REPOSITORY / "services" / "activitypub" / "UPSTREAM"
        if not pin.exists():
            self.skipTest("the image build's pin file is not in this tree")
        found = re.search(r"^commit=([0-9a-f]{40})$", pin.read_text(), re.MULTILINE)
        self.assertIsNotNone(found)
        assert found is not None
        self.assertEqual(found.group(1), contract.UPSTREAM_COMMIT)

    def test_the_document_carries_the_facts_as_stated(self) -> None:
        text = (HERE / "CONTRACT.md").read_text()
        begin = text.index(contract.TABLE_BEGIN) + len(contract.TABLE_BEGIN)
        end = text.index(contract.TABLE_END)
        self.assertEqual(text[begin:end].strip(), contract.render_table(FACTS))

    def test_the_stated_facts_hold_for_themselves(self) -> None:
        self.assertEqual(problems(FACTS, expected_observations()), [])


class Sabotage(unittest.TestCase):
    """Each case changes one reliance and requires the contract to go red."""

    def test_a_required_variable_that_no_longer_stops_the_service(self) -> None:
        for name in contract.REQUIRED_ENV:
            key = f"env.missing.{name}"
            stated = expected_observations()[key]
            changed = with_value(
                expected_observations(), key, "works" if stated != "works" else "exits"
            )
            found = failing(FACTS, changed)
            self.assertEqual([k for k, _ in found], [key], name)

    def test_a_path_that_changes_its_answer(self) -> None:
        for route in contract.ROUTES:
            stated = expected_observations()[route.key]
            self.assertIsInstance(stated, dict)
            assert isinstance(stated, dict)
            moved: dict[str, Json] = dict(stated)
            moved["registered"] = 404
            found = failing(FACTS, with_value(expected_observations(), route.key, moved))
            if stated["registered"] != 404:
                self.assertEqual([k for k, _ in found], [route.key], route.path)

    def test_an_unobserved_fact_is_red(self) -> None:
        for fact in FACTS:
            observed = expected_observations()
            del observed[fact.key]
            self.assertEqual(problems(FACTS, observed), [f"{fact.key}: not observed"])

    def test_every_fact_can_fail(self) -> None:
        for fact in FACTS:
            wrong: Json
            if fact.op == "le":
                wrong = 10**9
            elif fact.op == "ge":
                wrong = -1
            else:
                wrong = {"sabotaged": True}
            found = failing(FACTS, with_value(expected_observations(), fact.key, wrong))
            self.assertEqual([k for k, _ in found], [fact.key], fact.key)


if __name__ == "__main__":
    unittest.main()
