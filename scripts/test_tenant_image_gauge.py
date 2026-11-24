"""The tenant image gauge, and the registry-push job that writes it.

Run: python3 -m unittest discover -s scripts -p 'test_tenant_image_gauge.py'
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

import tenant_image_gauge as gauge

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "registry-push.yml"
GOOD = "sha256:" + "ab" * 32


def job_block(text: str, name: str) -> str:
    """The lines of one job of the top-level `jobs:` mapping."""
    match = re.search(rf"^  {re.escape(name)}:\n((?:    .*\n|\n)+)", text, re.M)
    if match is None:
        raise AssertionError(f"no job named {name}")
    return match.group(1)


class RenderTests(unittest.TestCase):
    def test_a_good_digest_gives_one_info_series_and_one_timestamp(self) -> None:
        text = gauge.render(GOOD, 1_700_000_000)
        self.assertIn(f'{gauge.INFO}{{digest="{GOOD}"}} 1\n', text)
        self.assertIn(f"{gauge.STAMP} 1700000000\n", text)

    def test_refuses_what_is_not_a_full_sha256_digest(self) -> None:
        for bad in ["", "latest", "sha256:abc", "sha256:" + "AB" * 32, GOOD + "\n", GOOD + '"} 1\nx{a="', "sha512:" + "ab" * 32]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                gauge.render(bad, 1_700_000_000)

    def test_refuses_a_timestamp_that_is_not_positive(self) -> None:
        with self.assertRaises(ValueError):
            gauge.render(GOOD, 0)


class CliTests(unittest.TestCase):
    def test_writes_the_file_and_exits_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tenant-image.prom"
            self.assertEqual(gauge.main(["--digest", GOOD, "--metrics", str(path), "--now", "1700000000"]), 0)
            self.assertEqual(path.read_text(encoding="utf-8"), gauge.render(GOOD, 1_700_000_000))
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["tenant-image.prom"])

    def test_a_bad_digest_exits_one_and_leaves_the_old_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tenant-image.prom"
            path.write_text("old\n", encoding="utf-8")
            self.assertEqual(gauge.main(["--digest", "latest", "--metrics", str(path)]), 1)
            self.assertEqual(path.read_text(encoding="utf-8"), "old\n")


class WorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.job = job_block(self.text, "gauge")

    def test_it_runs_only_after_the_scan_and_the_attestation(self) -> None:
        self.assertRegex(self.job, r"needs: \[push, scan, attest\]")

    def test_it_is_the_only_job_with_contents_write(self) -> None:
        self.assertIn("contents: write", self.job)
        others = self.text.replace(self.job, "")
        code = [line for line in others.splitlines() if not line.lstrip().startswith("#")]
        self.assertNotIn("contents: write", "\n".join(code))

    def test_it_takes_the_digest_from_the_push_job_never_a_tag(self) -> None:
        self.assertIn("needs.push.outputs.digest", self.job)
        self.assertNotRegex(self.job, r":latest|IMAGE_TAG")

    def test_it_writes_only_the_state_branch_and_tracks_one_file(self) -> None:
        self.assertIn("refs/heads/state/tenant-image", self.job)
        self.assertIn('[ "$(git ls-files)" != "tenant-image.prom" ]', self.job)
        self.assertNotRegex(self.job, r"refs/heads/main|--force|-f origin")


if __name__ == "__main__":
    unittest.main()
