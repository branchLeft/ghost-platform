"""Each rule that guards a volume increase is proven by breaking it: red broken, green whole."""

from __future__ import annotations

import unittest

from sabotage import FAULTS, Fault, prove


class SabotageTests(unittest.TestCase):
    def test_every_fault_turns_its_guards_red_and_the_whole_code_is_green(self) -> None:
        for fault in FAULTS:
            with self.subTest(fault.name):
                proof = prove(fault)
                self.assertTrue(proof.green_when_whole, "the guards must pass on the real code")
                self.assertTrue(proof.red_when_broken, "the guards must fail on the broken code")

    def test_the_cases_the_owner_named_are_covered(self) -> None:
        names = {fault.name for fault in FAULTS}
        self.assertTrue(
            {
                "advances on seed mail",
                "advances on stale evidence",
                "cap above proven volume",
                "resumes without the card",
            }
            <= names
        )

    def test_a_fault_that_breaks_nothing_is_not_proof(self) -> None:
        harmless = Fault(
            "changes nothing",
            "counted_volume",
            lambda day: day.real_sent,
            ("test_decide.NoRealMailTests.test_seed_mail_alone_never_advances",),
        )
        self.assertEqual(prove(harmless).red_when_broken, ())
        self.assertFalse(prove(harmless).proven)


if __name__ == "__main__":
    unittest.main()
