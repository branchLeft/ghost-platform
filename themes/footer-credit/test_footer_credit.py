"""The platform's footer credit patches (themes/footer-credit/README.md), checked
without a build: the patch set covers exactly the bundled themes, no patch removes
Ghost's own credit, and the partial carries what render-core names. The patches
applied to the real themes, and the credits rendered beside each other, are proved
by themes/image/themes.image.test.mjs against the built image.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CALL = "{{> platform-footer-credit}}"
GHOST_LINK = "https://ghost.org"


def manifest_themes() -> set[str]:
    manifest = json.loads((ROOT / "themes" / "manifest.json").read_text())
    return {str(t["name"]) for t in manifest["themes"]}


def patch_lines(theme: str) -> tuple[list[str], list[str]]:
    """The (added, removed) content lines of one theme's patch."""
    added: list[str] = []
    removed: list[str] = []
    for line in (HERE / f"{theme}.patch").read_text().splitlines():
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            added.append(line[1:])
        elif line.startswith("-"):
            removed.append(line[1:])
    return added, removed


class FooterCreditPatches(unittest.TestCase):
    def test_one_patch_per_bundled_theme(self) -> None:
        patched = {p.stem for p in HERE.glob("*.patch")}
        self.assertEqual(patched, manifest_themes())

    def test_every_patch_adds_the_credit_call_and_keeps_ghosts_credit(self) -> None:
        for theme in sorted(manifest_themes()):
            added, removed = patch_lines(theme)
            self.assertTrue(
                any(line.strip() == CALL for line in added), f"{theme}: no credit call added"
            )
            ghost_removed = sum(line.count(GHOST_LINK) for line in removed)
            ghost_added = sum(line.count(GHOST_LINK) for line in added)
            self.assertEqual(
                ghost_added, ghost_removed, f"{theme}: a patch hunk removes Ghost's credit"
            )
            for line in added:
                # Casper's one-line credit becomes three: its own line, the call, the closing tag.
                if line.strip() not in (CALL, "</div>"):
                    self.assertIn(GHOST_LINK, line, f"{theme}: unexpected added line {line!r}")

    def test_every_patch_names_only_template_files(self) -> None:
        for patch in HERE.glob("*.patch"):
            for line in patch.read_text().splitlines():
                if line.startswith("+++ "):
                    self.assertRegex(line, r"^\+\+\+ b/[A-Za-z0-9_./-]+\.hbs$", patch.name)


class FooterCreditPartial(unittest.TestCase):
    def test_partial_carries_what_render_core_names(self) -> None:
        golden = json.loads(
            (ROOT / "render-core" / "test" / "golden" / "demo.ghost-settings.json").read_text()
        )
        credit = golden["footerCredit"]
        self.assertIs(credit["keepGhostCredit"], True)
        partial = (HERE / "platform-footer-credit.hbs").read_text()
        match = re.fullmatch(
            r'<span class="platform-footer-credit"><a href="([^"]*)" rel="noopener">([^<]*)</a></span>\n',
            partial,
        )
        self.assertIsNotNone(match, "the partial is not the one-line credit markup")
        assert match is not None
        self.assertEqual(match.group(1), credit["url"])
        self.assertEqual(match.group(2), credit["text"])


class ApplyScript(unittest.TestCase):
    def run_apply(self, themes: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["sh", str(HERE / "apply.sh"), str(themes)], capture_output=True, text=True
        )

    def test_a_patch_for_a_theme_that_is_absent_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_apply(Path(tmp))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("names a theme that is not in", result.stderr)

    def test_a_theme_that_drifted_from_its_patch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for theme in manifest_themes():
                (Path(tmp) / theme).mkdir()
            result = self.run_apply(Path(tmp))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no longer applies cleanly", result.stderr)


if __name__ == "__main__":
    unittest.main()
