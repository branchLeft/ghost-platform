"""Tests for resolve-mirror-entry.py.

Run: python3 -m unittest discover -s scripts -p 'test_resolve_mirror_entry.py'
No network: the list is a temporary file or the committed one.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIST = HERE.parent / ".github" / "image-mirror" / "images.json"

spec = importlib.util.spec_from_file_location("resolve_mirror_entry", HERE / "resolve-mirror-entry.py")
resolver = importlib.util.module_from_spec(spec)
sys.modules["resolve_mirror_entry"] = resolver
spec.loader.exec_module(resolver)

REGISTRY = "ghcr.io/branchleft/mirror"
FIRST = "sha256:" + "a" * 64
SECOND = "sha256:" + "b" * 64


def entry(name: str, digest: str, tags: list[str]) -> dict:
    return {
        "name": name,
        "source": f"docker.io/library/{name}",
        "digest": digest,
        "upstreamTags": tags,
        "licence": "GPL-2.0-only",
        "redistribution": "conditioned",
        "licenceSource": "https://example.invalid/LICENSE",
    }


class ResolveTests(unittest.TestCase):
    def run_main(self, images: list[dict], name: str, tag: str) -> tuple[int, str, str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "images.json"
            path.write_text(json.dumps({"registry": REGISTRY, "images": images}))
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = resolver.main([name, tag, "--list", str(path)])
        return code, out.getvalue(), err.getvalue()

    def test_picks_the_entry_that_lists_the_tag(self):
        images = [entry("mysql", FIRST, ["8.0", "8.0.46"]), entry("mysql", SECOND, ["8.4"])]
        code, out, _ = self.run_main(images, "mysql", "8.0.46")
        self.assertEqual(code, 0)
        self.assertEqual(out, f"image={REGISTRY}/mysql\ndigest={FIRST}\n")

    def test_a_tag_on_another_name_is_not_a_match(self):
        images = [entry("mysql", FIRST, ["8.0"]), entry("postgres", SECOND, ["17"])]
        code, out, err = self.run_main(images, "mysql", "17")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("found 0", err)

    def test_two_entries_listing_one_tag_are_refused(self):
        images = [entry("mysql", FIRST, ["8.0"]), entry("mysql", SECOND, ["8.0"])]
        code, out, err = self.run_main(images, "mysql", "8.0")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("found 2", err)

    def test_a_bad_list_is_exit_two(self):
        bad = entry("mysql", "sha256:short", ["8.0"])
        code, out, err = self.run_main([bad], "mysql", "8.0")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("bad list", err)

    def test_the_committed_list_resolves_the_db_stack_image(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = resolver.main(["mysql", "8.0.46", "--list", str(LIST)])
        self.assertEqual(code, 0, err.getvalue())
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], f"image={REGISTRY}/mysql")
        self.assertRegex(lines[1], r"\Adigest=sha256:[0-9a-f]{64}\Z")


if __name__ == "__main__":
    unittest.main()
