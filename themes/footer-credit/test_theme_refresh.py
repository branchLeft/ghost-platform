"""The entrypoint's bundled-theme refresh (docker-entrypoint.branchleft.sh,
refresh_bundled_themes). The upstream entrypoint seeds a bundled theme into the
content volume only when that theme directory is absent, so a site whose volume
already holds an older copy never gets the platform footer credit
(themes/footer-credit/README.md). The wrapper replaces such a copy before Ghost
starts, and only while the copy still matches the pinned, unpatched bundle hash.
These tests run the real wrapper with a stub for the upstream entrypoint.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
WRAPPER = ROOT / "docker-entrypoint.branchleft.sh"
PARTIAL = Path("partials") / "platform-footer-credit.hbs"
CREDIT = '<span class="platform-footer-credit">PLATFORM</span>'
GHOST_BOOT = ["node", "current/index.js"]
# Storage guard settings that pass the wrapper's checks without a real S3 setup.
STORAGE_OK = {
    "BRANCHLEFT_ALLOW_LOCAL_STORAGE": "true",
    **{
        f"storage__{feature}__adapter": "ScanningStorageAdapter"
        for feature in ("images", "media", "files")
    },
    **{f"storage__{feature}__wraps": "LocalImagesStorage" for feature in ("images", "media", "files")},
}
# The unpatched bundle of the "older" theme, as the manifest pins it.
PRISTINE_OLDER = {
    "package.json": '{"name":"older","version":"2"}',
    "default.hbs": "pristine footer\n",
}
# The same theme as the images before the footer step installed it: the bundle
# plus the font files the Dockerfile's theme loop copied in (the font step and
# the footer patch came later). This is a state that really shipped, and it lacks
# the credit partial, so it is the state the refresh exists for.
FONTS_OLDER = {
    **PRISTINE_OLDER,
    "assets/platform-fonts/fonts.css": "@font-face { font-family: X; src: url(X.woff2); }\n",
    "assets/platform-fonts/X/X.woff2": "font bytes\n",
}


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def tree_sha256(root: Path) -> str:
    """The same hash as themes/lib/treehash.mjs treeSha256, for regular files."""
    lines = []
    files = sorted(
        (p for p in root.rglob("*") if p.is_file() and not p.is_symlink()),
        key=lambda p: p.relative_to(root).as_posix(),
    )
    for path in files:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(root).as_posix()}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


class ThemeRefreshTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.install = self.tmp / "ghost"
        self.content = self.tmp / "content"
        self.seed = self.install / "content.orig" / "themes"
        self.site = self.content / "themes"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        stub = self.bin / "docker-entrypoint.sh"
        stub.write_text('#!/bin/sh\necho "UPSTREAM $*"\n')
        stub.chmod(0o755)

        # The image's bundled themes: "fresh" is patched (has the credit partial).
        write(self.seed / "fresh" / "package.json", '{"name":"fresh","version":"2"}')
        write(self.seed / "fresh" / PARTIAL, CREDIT)
        write(self.seed / "fresh" / "default.hbs", "{{> platform-footer-credit}}\n")
        # "older" is patched in the image; the site's copy predates the credit.
        write(self.seed / "older" / "package.json", '{"name":"older","version":"2"}')
        write(self.seed / "older" / PARTIAL, CREDIT)
        write(self.seed / "older" / "default.hbs", "image footer\n")

        # The trees shipped images installed for "older": the unpatched bundle
        # (the image before the footer and font steps) is listed.
        self.write_shipped("older", PRISTINE_OLDER)

    def write_shipped(self, name: str, files: dict[str, str]) -> None:
        """Add the tree an earlier image installed for `name` to the shipped list."""
        root = Path(tempfile.mkdtemp(prefix=f"shipped-{name}-", dir=self.tmp))
        for rel, text in files.items():
            write(root / rel, text)
        pins = self.install / "bundled-theme-pins.txt"
        with pins.open("a") as out:
            out.write(f"{name} {tree_sha256(root)}\n")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def site_older_pristine(self) -> None:
        """The site holds an unmodified copy of the older bundled theme."""
        for rel, text in PRISTINE_OLDER.items():
            write(self.site / "older" / rel, text)

    def run_wrapper(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        env = {
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "GHOST_INSTALL": str(self.install),
            "GHOST_CONTENT": str(self.content),
            **STORAGE_OK,
        }
        return subprocess.run(
            ["sh", str(WRAPPER), *args], env=env, capture_output=True, text=True, check=False
        )

    def assert_no_staged_copies(self) -> None:
        self.assertEqual(list(self.site.glob(".older.refresh-*")), [])

    def test_unmodified_stale_bundled_theme_is_replaced_and_backed_up(self) -> None:
        self.site_older_pristine()
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("UPSTREAM", result.stdout)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "image footer\n")
        self.assertEqual((self.site / "older" / PARTIAL).read_text(), CREDIT)
        kept = list((self.content / "theme-backup-pre-footer-credit").glob("older.*"))
        self.assertEqual(len(kept), 1, "the replaced copy is moved aside, not deleted")
        self.assertEqual((kept[0] / "default.hbs").read_text(), "pristine footer\n")
        self.assert_no_staged_copies()

    def test_copy_as_an_earlier_image_installed_it_with_fonts_is_replaced(self) -> None:
        # The shipped list holds the tree an earlier image installed after its
        # font step, not the bare bundle; the site's copy is exactly that tree.
        self.write_shipped("older", FONTS_OLDER)
        for rel, text in FONTS_OLDER.items():
            write(self.site / "older" / rel, text)
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "image footer\n")
        self.assertEqual((self.site / "older" / PARTIAL).read_text(), CREDIT)
        kept = list((self.content / "theme-backup-pre-footer-credit").glob("older.*"))
        self.assertEqual(len(kept), 1)
        self.assertEqual((kept[0] / "assets" / "platform-fonts" / "fonts.css").read_text(),
                         FONTS_OLDER["assets/platform-fonts/fonts.css"])
        self.assert_no_staged_copies()

    def test_modified_bundled_theme_is_left_untouched(self) -> None:
        self.site_older_pristine()
        write(self.site / "older" / "default.hbs", "tenant's own footer\n")
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "tenant's own footer\n")
        self.assertFalse((self.site / "older" / PARTIAL).exists())
        self.assertFalse((self.content / "theme-backup-pre-footer-credit").exists())
        self.assertIn("left bundled theme older untouched", result.stderr)

    def test_failed_copy_leaves_the_old_theme_live(self) -> None:
        self.site_older_pristine()
        # A dangling symlink in the image copy makes `cp -RL` fail.
        os.remove(self.seed / "older" / "default.hbs")
        os.symlink(self.tmp / "nowhere", self.seed / "older" / "default.hbs")
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, "a failed refresh must not stop Ghost")
        self.assertIn("UPSTREAM", result.stdout)
        self.assertIn("WARNING: could not copy bundled theme older", result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "pristine footer\n")
        self.assertFalse((self.site / "older" / PARTIAL).exists())
        self.assertFalse((self.content / "theme-backup-pre-footer-credit").exists())
        self.assert_no_staged_copies()

    def test_unreadable_tenant_copy_never_stops_ghost(self) -> None:
        # A bundled name whose copy cannot be read: the hash or the owner lookup
        # may fail, and the refresh must warn and leave it, not stop the start.
        self.site_older_pristine()
        locked = self.site / "older" / "locked"
        write(locked / "x.txt", "y\n")
        os.chmod(locked, 0)
        try:
            result = self.run_wrapper(GHOST_BOOT)
        finally:
            os.chmod(locked, 0o755)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("UPSTREAM", result.stdout)

    def test_current_bundled_theme_is_left_alone(self) -> None:
        write(self.site / "fresh" / "default.hbs", "tenant edit\n")
        write(self.site / "fresh" / PARTIAL, CREDIT)
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "fresh" / "default.hbs").read_text(), "tenant edit\n")
        self.assertFalse((self.content / "theme-backup-pre-footer-credit").exists())

    def test_tenant_theme_outside_the_bundle_is_left_alone(self) -> None:
        write(self.site / "tenant-custom" / "default.hbs", "custom\n")
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "tenant-custom" / "default.hbs").read_text(), "custom\n")

    def test_missing_bundled_theme_is_left_to_upstream_seed(self) -> None:
        self.site.mkdir(parents=True)
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.site / "older").exists())

    def test_refresh_runs_only_when_ghost_starts(self) -> None:
        self.site_older_pristine()
        result = self.run_wrapper(["sh", "-c", "true"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "pristine footer\n")

    def test_storage_guard_still_refuses_before_any_refresh(self) -> None:
        self.site_older_pristine()
        env = {
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "GHOST_INSTALL": str(self.install),
            "GHOST_CONTENT": str(self.content),
        }
        result = subprocess.run(
            ["sh", str(WRAPPER), *GHOST_BOOT], env=env, capture_output=True, text=True, check=False
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FATAL:", result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "pristine footer\n")


if __name__ == "__main__":
    unittest.main()
