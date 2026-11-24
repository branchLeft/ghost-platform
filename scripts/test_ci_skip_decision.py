"""The skip decision fails closed: every case in the review table, both gates."""

from __future__ import annotations

import unittest

from ci_skip_decision import DOCS_LINT_GATE, IMAGE_GATE, decide, parse


def diff(*records: tuple[str, str]) -> bytes:
    """Build the ``--name-status -z`` output the workflow feeds the script."""
    return "".join(f"{status}\0{path}\0" for status, path in records).encode("utf-8")


def verdict(data: bytes, gate: tuple[str, ...]) -> str:
    return decide(parse(data), gate)


# (name, diff, expected). The image gate: a skip needs every path to be one the
# image job never reads. Run is the answer for anything else.
IMAGE_TABLE: list[tuple[str, bytes, str]] = [
    ("docs markdown", diff(("M", "docs/a.md")), "skip"),
    ("nested docs markdown", diff(("A", "docs/x/y/z.md")), "skip"),
    ("root README", diff(("M", "README.md")), "skip"),
    ("docs png", diff(("A", "docs/img.png")), "skip"),
    ("docs txt", diff(("M", "docs/notes.txt")), "skip"),
    ("root licence", diff(("M", "LICENSE")), "skip"),
    ("another workflow", diff(("M", ".github/workflows/ansible.yml")), "skip"),
    ("build workflow itself", diff(("M", ".github/workflows/build.yml")), "run"),
    ("Dockerfile", diff(("M", "Dockerfile")), "run"),
    ("docker entrypoint", diff(("M", "docker-entrypoint.branchleft.sh")), "run"),
    ("adapters source", diff(("M", "adapters/sso/src/x.js")), "run"),
    ("services source", diff(("A", "services/broker/x.ts")), "run"),
    ("scripts file", diff(("M", "scripts/smoke-test.sh")), "run"),
    ("test-support file", diff(("M", "test-support/ghost-admin.mjs")), "run"),
    ("root package.json", diff(("M", "package.json")), "run"),
    ("lockfile", diff(("M", "pnpm-lock.yaml")), "run"),
    ("render-core source", diff(("M", "render-core/src/environment.ts")), "run"),
    ("widgets file", diff(("M", "widgets/pins.json")), "run"),
    ("unknown root file", diff(("M", "weird-file")), "run"),
    ("docs html (not read by the decision)", diff(("M", "docs/page.html")), "run"),
    ("docs file deleted", diff(("D", "docs/a.md")), "run"),
    ("README deleted", diff(("D", "README.md")), "run"),
    ("Dockerfile renamed away (old side deleted)", diff(("D", "Dockerfile"), ("A", "plain/Dockerfile.bak")), "run"),
    ("scripts file renamed to txt (old side deleted)", diff(("D", "scripts/a.sh"), ("A", "notes2.txt")), "run"),
    ("docs file renamed to png", diff(("D", "docs/a.md"), ("A", "docs/img2.png")), "run"),
    ("non-ASCII docs name", diff(("A", "docs/é.md")), "run"),
    ("non-ASCII adapters name", diff(("A", "adapters/é.js")), "run"),
    ("type change", diff(("T", "docs/a.md")), "run"),
    ("empty diff", b"", "run"),
    ("one skippable path among a run path", diff(("M", "docs/a.md"), ("M", "adapters/x.js")), "run"),
    ("odd record count", b"M\0docs/a.md\0M\0", "run"),
    ("bytes that are not UTF-8", b"M\0docs/\xff.md\0", "run"),
]

# The docs-lint gate: a skip needs every path to be outside what the lint reads.
DOCS_LINT_TABLE: list[tuple[str, bytes, str]] = [
    ("png", diff(("M", "docs/img.png")), "skip"),
    ("txt", diff(("A", "notes.txt")), "skip"),
    ("licence", diff(("M", "LICENSE")), "skip"),
    ("root package.json", diff(("M", "package.json")), "skip"),
    ("json", diff(("M", "x.json")), "skip"),
    ("Dockerfile edit (not a lint input, but not allow-listed)", diff(("M", "Dockerfile")), "run"),
    ("workflow file", diff(("M", ".github/workflows/docs-lint.yml")), "run"),
    ("markdown edit", diff(("M", "README.md")), "run"),
    ("new markdown", diff(("A", "docs/new.md")), "run"),
    ("yaml", diff(("M", "config.yaml")), "run"),
    ("yml", diff(("M", ".github/workflows/x.yml")), "run"),
    ("shell", diff(("M", "scripts/a.sh")), "run"),
    ("typescript", diff(("M", "src/a.ts")), "run"),
    ("python", diff(("M", "src/a.py")), "run"),
    ("lockfile by yaml extension", diff(("M", "pnpm-lock.yaml")), "run"),
    ("docs-lint mode file", diff(("M", ".docs-lint.mode")), "run"),
    ("docs-lint ignore file", diff(("M", ".docs-lintignore")), "run"),
    ("scripts shell deleted", diff(("D", "scripts/a.sh")), "run"),
    ("Dockerfile deleted", diff(("D", "Dockerfile")), "run"),
    ("scripts shell renamed to txt", diff(("D", "scripts/a.sh"), ("A", "notes2.txt")), "run"),
    ("markdown renamed to png", diff(("D", "docs/a.md"), ("A", "docs/img2.png")), "run"),
    ("python renamed to json", diff(("D", "src/app.py"), ("A", "x2.json")), "run"),
    ("non-ASCII markdown name", diff(("A", "docs/é.md")), "run"),
    ("non-ASCII adapters name", diff(("A", "adapters/é.js")), "run"),
    ("empty diff", b"", "run"),
    ("unknown extension", diff(("M", "weird-file")), "run"),
    ("odd record count", b"A\0notes.txt\0A\0", "run"),
    ("bytes that are not UTF-8", b"A\0docs/\xff.txt\0", "run"),
]


class ImageGateTable(unittest.TestCase):
    def test_every_case(self) -> None:
        for name, data, expected in IMAGE_TABLE:
            with self.subTest(case=name):
                self.assertEqual(expected, verdict(data, IMAGE_GATE))


class DocsLintGateTable(unittest.TestCase):
    def test_every_case(self) -> None:
        for name, data, expected in DOCS_LINT_TABLE:
            with self.subTest(case=name):
                self.assertEqual(expected, verdict(data, DOCS_LINT_GATE))


class ParseTests(unittest.TestCase):
    def test_pairs_status_and_path(self) -> None:
        self.assertEqual([("M", "a"), ("D", "b")], parse(b"M\0a\0D\0b\0"))

    def test_empty_input_has_no_records(self) -> None:
        self.assertEqual([], parse(b""))

    def test_odd_count_does_not_parse(self) -> None:
        self.assertIsNone(parse(b"M\0a\0M\0"))


if __name__ == "__main__":
    unittest.main()
