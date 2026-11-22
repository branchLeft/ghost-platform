#!/usr/bin/env python3
"""Tests for scripts/assert-no-private-tracker-refs.py.

The forbidden spelling is built by concatenation in the fixtures, so this file
does not itself contain a private tracker reference and the guard stays clean.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import unittest
from types import ModuleType

GUARD = pathlib.Path(__file__).resolve().parent / "assert-no-private-tracker-refs.py"

SHORT = "work" + "space" + "#"
REPO = "branchLeft/" + "workspace"


def _load_guard() -> ModuleType:
    spec = importlib.util.spec_from_file_location("assert_no_private_tracker_refs", GUARD)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


guard = _load_guard()


class FindRefsTests(unittest.TestCase):
    def test_short_form_is_found(self) -> None:
        text = "see " + REPO + "#1302 for the rule\n"
        self.assertEqual(guard.find_refs(text), [(1, SHORT + "1302")])

    def test_bare_short_form_is_found(self) -> None:
        text = "(" + SHORT + "1740).\n"
        self.assertEqual(guard.find_refs(text), [(1, SHORT + "1740")])

    def test_full_url_form_is_found(self) -> None:
        url = "https://github.com/" + REPO + "/issues/3203#issuecomment-1"
        text = "approved at " + url + "\n"
        self.assertEqual(guard.find_refs(text), [(1, "github.com/" + REPO + "/issues/3203")])

    def test_several_on_one_line_and_line_numbers(self) -> None:
        text = "first\n" + SHORT + "1 and " + SHORT + "2\nthird\n"
        self.assertEqual(
            guard.find_refs(text),
            [(2, SHORT + "1"), (2, SHORT + "2")],
        )

    def test_repo_name_without_issue_number_is_not_a_reference(self) -> None:
        text = "The filing code targets --repo " + REPO + " by design.\n"
        self.assertEqual(guard.find_refs(text), [])

    def test_non_numeric_hash_is_not_a_reference(self) -> None:
        text = SHORT + "abc and " + SHORT + " are not issue numbers\n"
        self.assertEqual(guard.find_refs(text), [])

    def test_other_repo_issue_url_is_not_a_reference(self) -> None:
        text = "https://github.com/branchLeft/ghost-platform/issues/12\n"
        self.assertEqual(guard.find_refs(text), [])

    def test_short_form_is_case_insensitive(self) -> None:
        text = "WORKSPACE#1302 and Workspace#7\n"
        self.assertEqual(
            guard.find_refs(text),
            [(1, "WORKSPACE#1302"), (1, "Workspace#7")],
        )

    def test_pull_url_form_is_found(self) -> None:
        text = "see https://github.com/" + REPO + "/pull/12\n"
        self.assertEqual(guard.find_refs(text), [(1, "github.com/" + REPO + "/pull/12")])

    def test_api_url_form_is_found(self) -> None:
        text = "https://api.github.com/repos/" + REPO + "/issues/9/comments\n"
        self.assertEqual(
            guard.find_refs(text),
            [(1, "api.github.com/repos/" + REPO + "/issues/9")],
        )

    def test_lowercased_url_is_found(self) -> None:
        text = "https://github.com/branchleft/workspace/issues/9\n"
        self.assertEqual(guard.find_refs(text), [(1, "github.com/branchleft/workspace/issues/9")])


class ScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, name: str, data: bytes) -> pathlib.Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_clean_file_passes_and_dirty_file_is_reported(self) -> None:
        clean = self._write("clean.md", b"nothing to see here\n")
        dirty = self._write("sub/dirty.md", ("ref " + REPO + "#7\n").encode())
        self.assertEqual(guard.scan_paths([clean]), [])
        findings = guard.scan_paths([clean, dirty])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].path, dirty)
        self.assertEqual(findings[0].line, 1)
        self.assertEqual(findings[0].text, SHORT + "7")

    def test_binary_file_with_a_reference_is_scanned(self) -> None:
        binary = self._write("blob.bin", b"\x00\x01" + ("x " + SHORT + "9").encode())
        findings = guard.scan_paths([binary])
        self.assertEqual([f.text for f in findings], [SHORT + "9"])

    def test_utf16_le_bom_file_is_scanned(self) -> None:
        path = self._write("utf16.md", ("x " + SHORT + "1302").encode("utf-16"))
        self.assertEqual([f.text for f in guard.scan_paths([path])], [SHORT + "1302"])

    def test_utf16_be_bom_file_is_scanned(self) -> None:
        path = self._write("utf16be.md", b"\xfe\xff" + ("x " + SHORT + "1302").encode("utf-16-be"))
        self.assertEqual([f.text for f in guard.scan_paths([path])], [SHORT + "1302"])

    def test_utf32_bom_file_is_scanned(self) -> None:
        path = self._write("utf32.md", ("x " + SHORT + "1302").encode("utf-32"))
        self.assertEqual([f.text for f in guard.scan_paths([path])], [SHORT + "1302"])

    def test_bomless_utf16_file_is_scanned(self) -> None:
        path = self._write("bomless.md", ("x " + SHORT + "1302").encode("utf-16-le"))
        self.assertEqual([f.text for f in guard.scan_paths([path])], [SHORT + "1302"])

    def test_unreadable_file_is_a_finding(self) -> None:
        gone = self.root / "gone.md"
        findings = guard.scan_paths([gone])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].path, gone)
        self.assertEqual(findings[0].line, 0)

    def test_allowlisted_path_is_the_only_skip(self) -> None:
        path = self._write("allowed.bin", b"\x00" + ("x " + SHORT + "9").encode())
        original = guard.BINARY_ALLOWLIST
        guard.BINARY_ALLOWLIST = frozenset({str(path)})
        try:
            self.assertEqual(guard.scan_paths([path]), [])
        finally:
            guard.BINARY_ALLOWLIST = original

    def test_main_exit_codes(self) -> None:
        clean = self._write("clean.md", b"ok\n")
        dirty = self._write("dirty.md", ("x " + SHORT + "5").encode())
        utf16 = self._write("utf16-dirty.md", ("x " + SHORT + "5").encode("utf-16"))
        self.assertEqual(guard.main([str(clean)]), 0)
        self.assertEqual(guard.main([str(dirty)]), 1)
        self.assertEqual(guard.main([str(utf16)]), 1)
        self.assertEqual(guard.main([str(self.root / "gone.md")]), 1)


class SelfTestTests(unittest.TestCase):
    def test_self_test_passes(self) -> None:
        self.assertEqual(guard.self_test(), 0)


if __name__ == "__main__":
    unittest.main()
