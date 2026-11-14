#!/usr/bin/env python3
"""Pin tests for db/recovery/Dockerfile.

These read the Dockerfile text only. They prove that every base image is
digest-pinned, that the base digest is the one the image scan judged, that
the apt-supplied `age` is gone, and that `age` comes from the pinned source
build. The live scan of the built image runs in CI through the image-scan
gate, not here.
"""

from __future__ import annotations

import pathlib
import re
import unittest

DOCKERFILE = pathlib.Path(__file__).with_name("Dockerfile")

# The digest the scan judged: debian:trixie-slim as published on 2026-11-10.
SCANNED_BASE_DIGEST = "sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2"
# The Go builder for the pinned age source build (golang:1.27.3-trixie).
GO_BUILDER_DIGEST = "sha256:af1bfc2614ebb1dbd31af514b78740fd678850e76498762b425ecee4c5c6ea80"
# The age source tag v1.3.2 and the commit it names.
AGE_TAG = "v1.3.2"
AGE_COMMIT = "b74dce4cdbe35b5e5f66c06d9612b72f89028758"
# The zlib1g version that clears the base's zlib finding.
ZLIB_FIXED = "1:1.3.dfsg+really1.3.1-1+deb13u1"

FROM_RE = re.compile(r"^FROM\s+(\S+)", re.MULTILINE)
DIGEST_RE = re.compile(r"@sha256:[0-9a-f]{64}\b")


class DockerfilePinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = DOCKERFILE.read_text(encoding="utf-8")
        self.froms = FROM_RE.findall(self.text)

    def test_every_from_is_digest_pinned(self) -> None:
        self.assertTrue(self.froms, "no FROM line found")
        for image in self.froms:
            self.assertRegex(image, DIGEST_RE, f"FROM is not digest-pinned: {image}")

    def test_final_base_is_the_scanned_digest(self) -> None:
        final = self.froms[-1]
        self.assertEqual(
            final,
            f"debian:trixie-slim@{SCANNED_BASE_DIGEST}",
            "the final FROM must be the base digest the image scan judged",
        )

    def test_go_builder_is_digest_pinned(self) -> None:
        self.assertIn(f"golang:1.27.3-trixie@{GO_BUILDER_DIGEST}", self.froms)

    def test_age_source_is_pinned_to_tag_and_commit(self) -> None:
        self.assertIn(f"--branch {AGE_TAG}", self.text)
        self.assertIn(AGE_COMMIT, self.text)

    def test_zlib_is_pinned_to_the_fixed_version(self) -> None:
        self.assertIn(f"zlib1g={ZLIB_FIXED}", self.text)

    def test_debian_age_is_purged(self) -> None:
        self.assertRegex(self.text, r"apt-get purge[^\n]*\bage\b")

    def test_age_binary_comes_from_the_build_stage(self) -> None:
        self.assertIn("COPY --from=age-build", self.text)


if __name__ == "__main__":
    unittest.main()
