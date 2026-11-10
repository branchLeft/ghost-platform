#!/usr/bin/env python3
"""The demo-edge Dockerfile builds on the base images its image scan was run
against, and carries the package and module pins that scan needed.

Reads the Dockerfile as text and asserts the exact lines. It runs without
Docker, so the pin cannot drift silently: a new base digest, a new Caddy
version or a dropped replacement fails here before the image is built.
"""

from __future__ import annotations

import pathlib
import unittest

DOCKERFILE = pathlib.Path(__file__).parents[2] / "services" / "demo-edge" / "Dockerfile"

CADDY_VERSION = "2.11.9"
BUILDER_DIGEST = "sha256:f7d08b96ba62ff0ae985079c0db4e0f97acb1f174e0e111aebe1f8a4b2d56f31"
FINAL_DIGEST = "sha256:fc9cbc100585871d18d4e451cca7021785c90a7006087427ae5ceb3e4efe6424"
ZLIB_PIN = "zlib=1.4-r0"
REPLACEMENTS = (
    "--replace golang.org/x/net=golang.org/x/net@v0.62.0",
    "--replace github.com/klauspost/compress=github.com/klauspost/compress@v1.20.2",
)


class DemoEdgeBasePin(unittest.TestCase):
    def setUp(self) -> None:
        self.lines = DOCKERFILE.read_text(encoding="utf-8").splitlines()

    def test_base_images_are_the_scanned_digests(self) -> None:
        self.assertIn(
            f"FROM caddy:{CADDY_VERSION}-builder-alpine@{BUILDER_DIGEST} AS builder",
            self.lines,
        )
        self.assertIn(f"FROM caddy:{CADDY_VERSION}-alpine@{FINAL_DIGEST}", self.lines)

    def test_every_from_is_digest_pinned(self) -> None:
        froms = [line for line in self.lines if line.startswith("FROM ")]
        self.assertEqual(len(froms), 2)
        for line in froms:
            self.assertRegex(line, r"@sha256:[0-9a-f]{64}")

    def test_xcaddy_builds_the_same_caddy_version_with_the_replacements(self) -> None:
        build = [line for line in self.lines if "xcaddy build" in line]
        self.assertEqual(len(build), 1)
        self.assertIn(f"xcaddy build v{CADDY_VERSION} ", build[0])
        for flag in REPLACEMENTS:
            self.assertIn(flag, build[0])

    def test_zlib_is_pinned_to_the_patched_apk(self) -> None:
        self.assertIn(f"RUN apk add --no-cache {ZLIB_PIN}", self.lines)


if __name__ == "__main__":
    unittest.main()
