#!/usr/bin/env python3
"""The Percona Server digest is read from the image mirror list, never typed.

.github/image-mirror/images.json is the one source. A db proof script that
carries its own Percona digest literal can be left on an old image when the
digest is re-pinned, so the guard below fails on any such line under db/.
"""

import re
import unittest
from pathlib import Path

import percona_pin

REPO = Path(__file__).resolve().parents[2]
DB = REPO / "db"
PINNED_SCRIPTS = (
    DB / "provision" / "prove-promotion-gate.sh",
    DB / "tunnel" / "prove-replica-tunnel.sh",
    DB / "provision" / "prove-percona-snapshot.sh",
)
DIGEST_LITERAL = re.compile(r"sha256:[0-9a-f]{64}")


def percona_literal_lines(text: str) -> list[int]:
    """1-based numbers of lines that name Percona and carry a digest literal."""
    return [
        number
        for number, line in enumerate(text.splitlines(), start=1)
        if "percona" in line.lower() and DIGEST_LITERAL.search(line)
    ]


class PerconaPinSourceTest(unittest.TestCase):
    def test_both_roles_resolve_to_a_digest_from_the_mirror_list(self) -> None:
        images = percona_pin.load(percona_pin.LIST)
        index = percona_pin.digest_for(images, "index")
        amd64 = percona_pin.digest_for(images, "amd64")
        self.assertRegex(index, r"^sha256:[0-9a-f]{64}$")
        self.assertRegex(amd64, r"^sha256:[0-9a-f]{64}$")
        self.assertNotEqual(index, amd64)

    def test_unknown_role_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            percona_pin.digest_for(percona_pin.load(percona_pin.LIST), "latest")

    def test_each_pinned_script_reads_the_mirror_list(self) -> None:
        for script in PINNED_SCRIPTS:
            with self.subTest(script=script.name):
                self.assertIn("percona_pin.py", script.read_text(encoding="utf-8"))

    def test_no_db_script_carries_its_own_percona_digest(self) -> None:
        offenders = []
        for path in sorted(DB.rglob("*")):
            if path.suffix not in (".sh", ".py") or not path.is_file():
                continue
            for number in percona_literal_lines(path.read_text(encoding="utf-8")):
                offenders.append(f"{path.relative_to(REPO)}:{number}")
        self.assertEqual(offenders, [], "Percona digest literal found; read images.json instead")

    def test_guard_flags_a_literal_and_passes_a_reference(self) -> None:
        literal = "REPLICA_IMAGE=percona/percona-server@sha256:" + "a" * 64
        reference = 'REPLICA_IMAGE="percona/percona-server@$DIGEST"'
        self.assertEqual(percona_literal_lines(literal), [1])
        self.assertEqual(percona_literal_lines(reference), [])


if __name__ == "__main__":
    unittest.main()
