"""Unit tests for the node-env gate's verdict. Run by gates.test.mjs in CI."""

from __future__ import annotations

import unittest

import node_env_gate


class JudgeTest(unittest.TestCase):
    def test_production_passes(self) -> None:
        self.assertTrue(node_env_gate.judge("production"))

    def test_development_is_red(self) -> None:
        self.assertFalse(node_env_gate.judge("development"))

    def test_unset_is_red(self) -> None:
        self.assertFalse(node_env_gate.judge("<unset>"))

    def test_empty_is_red(self) -> None:
        self.assertFalse(node_env_gate.judge(""))

    def test_case_must_match_exactly(self) -> None:
        self.assertFalse(node_env_gate.judge("Production"))
        self.assertFalse(node_env_gate.judge("production "))


class MainTest(unittest.TestCase):
    def test_missing_image_argument_is_a_usage_error(self) -> None:
        self.assertEqual(node_env_gate.main(["node_env_gate.py"]), 2)
        self.assertEqual(node_env_gate.main(["node_env_gate.py", ""]), 2)


if __name__ == "__main__":
    unittest.main()
