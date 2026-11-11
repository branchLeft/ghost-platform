"""Tests for mail-spool-drain-network-proof.py: the pure precondition, no Docker.

Run: python3 -m unittest discover -s scripts -p 'test_mail_spool_drain_network_proof.py' -v
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType

_SCRIPT = Path(__file__).resolve().parent / "mail-spool-drain-network-proof.py"


def _load_proof() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "mail_spool_drain_network_proof", _SCRIPT
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proof = _load_proof()
FIXED = "10.231.200.0/29"


class PoolConflictTest(unittest.TestCase):
    def test_auto_assigned_pool_is_a_valid_old_state(self) -> None:
        old = {"Subnet": "172.20.0.0/16", "Gateway": "172.20.0.1"}
        self.assertIsNone(proof.pool_conflict(old, FIXED))

    def test_no_pool_is_a_valid_old_state(self) -> None:
        self.assertIsNone(proof.pool_conflict(None, FIXED))

    def test_old_network_already_on_the_fixed_pool_is_refused(self) -> None:
        old = {"Subnet": FIXED, "Gateway": "10.231.200.1"}
        self.assertIsNotNone(proof.pool_conflict(old, FIXED))


if __name__ == "__main__":
    unittest.main()
