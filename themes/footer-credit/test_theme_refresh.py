"""The entrypoint's bundled-theme refresh (docker-entrypoint.branchleft.sh,
refresh_bundled_themes). The upstream entrypoint seeds a bundled theme into the
content volume only when that theme directory is absent, so a site whose volume
already holds an older copy never gets the platform footer credit
(themes/footer-credit/README.md). The wrapper replaces such a copy before Ghost
starts; these tests run the real wrapper with a stub for the upstream entrypoint.
"""

from __future__ import annotations

import os
import shutil
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


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


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

    def tearDown(self) -> None:
        self._tmp.cleanup()

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

    def test_stale_bundled_theme_is_replaced_with_the_image_copy(self) -> None:
        write(self.site / "older" / "default.hbs", "tenant's old footer\n")
        result = self.run_wrapper(GHOST_BOOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("UPSTREAM", result.stdout)
        self.assertEqual(
            (self.site / "older" / "default.hbs").read_text(), "image footer\n"
        )
        self.assertEqual((self.site / "older" / PARTIAL).read_text(), CREDIT)
        kept = list((self.content / "theme-backup-pre-footer-credit").glob("older.*"))
        self.assertEqual(len(kept), 1, "the replaced copy is moved aside, not deleted")
        self.assertEqual(
            (kept[0] / "default.hbs").read_text(), "tenant's old footer\n"
        )

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
        write(self.site / "older" / "default.hbs", "tenant's old footer\n")
        result = self.run_wrapper(["sh", "-c", "true"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "tenant's old footer\n")

    def test_storage_guard_still_refuses_before_any_refresh(self) -> None:
        write(self.site / "older" / "default.hbs", "tenant's old footer\n")
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
        self.assertEqual((self.site / "older" / "default.hbs").read_text(), "tenant's old footer\n")


if __name__ == "__main__":
    unittest.main()
