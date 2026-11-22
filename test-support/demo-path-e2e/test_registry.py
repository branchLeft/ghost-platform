"""The path and its control cases stay in step: a stage built is a stage with a sabotage, and no work-item number sits in the source."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from demo_path_e2e import environment, sabotage as sabotages
from demo_path_e2e.stages import LIVE_IDS, STAGES

# The path as the epic states it, in the order a prospect meets it.
PATH = (
    "landing",
    "front-door",
    "provisioning",
    "arrival",
    "admin-sign-in",
    "gated-read",
    "extension",
    "expiry",
    "recycle",
)

HERE = Path(__file__).resolve().parent


class RegistryTests(unittest.TestCase):
    def test_the_stages_are_the_path_in_order(self) -> None:
        self.assertEqual(PATH, tuple(s.stage_id for s in STAGES))

    def test_a_stage_not_built_says_what_is_missing(self) -> None:
        for stage in STAGES:
            if stage.run is None:
                self.assertTrue(stage.missing.strip(), stage.stage_id)

    def test_every_built_stage_has_a_sabotage_and_every_sabotage_a_built_stage(self) -> None:
        sabotaged = {s.stage_id for s in sabotages.SABOTAGES}
        self.assertEqual(set(LIVE_IDS), sabotaged)

    def test_sabotage_names_are_unique_and_found(self) -> None:
        names = [s.name for s in sabotages.SABOTAGES]
        self.assertEqual(len(names), len(set(names)))
        for sabotage in sabotages.SABOTAGES:
            self.assertEqual(sabotage, sabotages.find(sabotage.name))

    def test_no_work_item_number_in_the_source(self) -> None:
        pattern = re.compile(r"(#\d{2,}|workspace#|issues/\d+)")
        for path in sorted(HERE.rglob("*.py")) + sorted(HERE.rglob("*.md")):
            if path.name == "test_registry.py":
                continue
            self.assertIsNone(pattern.search(path.read_text()), str(path))


class EnvironmentHelperTests(unittest.TestCase):
    def test_image_refs_expand_to_the_public_namespace_or_the_mirror(self) -> None:
        template = "${IMAGE_REGISTRY:-docker.io/library}/caddy:1@sha256:" + "a" * 64
        self.assertEqual("docker.io/library/caddy:1@sha256:" + "a" * 64, environment.image_ref(template, ""))
        self.assertEqual(
            "mirror.example/namespace/caddy:1@sha256:" + "a" * 64,
            environment.image_ref(template, "mirror.example/namespace"),
        )

    def test_the_pinned_images_carry_digests(self) -> None:
        for ref in (environment.CADDY_IMAGE, environment.COLOURS_IMAGE):
            self.assertRegex(ref, r"@sha256:[0-9a-f]{64}$")

    def test_exempting_ghost_adds_a_proxy_ahead_of_the_catch_all(self) -> None:
        text = "x\n\t\thandle {\n\t\t\tforward_auth\n\t\t}\n"
        out = environment.exempt_ghost(text)
        self.assertLess(out.index("handle /ghost/*"), out.index("forward_auth"))

    def test_exempting_ghost_refuses_a_caddyfile_it_cannot_place_it_in(self) -> None:
        with self.assertRaises(RuntimeError):
            environment.exempt_ghost("nothing to match\n")


if __name__ == "__main__":
    unittest.main()
