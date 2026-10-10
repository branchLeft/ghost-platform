import contextlib
import io
import os
import tempfile
import unittest
from unittest import mock

from release_watcher import cli
from test_core import DIGESTS, PINNED_FROM, TAGS, from_line

BRANCH = "release-watcher/ghost-6"
MAIN_SHA = "a" * 40
DOCKERFILE = "# header\n" + PINNED_FROM + "RUN echo kept\n"


class FakeRepo:
    """A stateful stand-in for GitHubApi. fail maps an operation to a one-shot error."""

    def __init__(self, main_text=DOCKERFILE):
        self.main_text = main_text
        self.branches = {}      # branch -> Dockerfile text
        self.pulls = []         # dicts with number, head, state, title
        self.fail = {}          # operation -> message, raised once then cleared
        self.updates = []
        self.next_number = 1

    def _maybe_fail(self, op):
        if op in self.fail:
            raise RuntimeError(self.fail.pop(op))

    def list_pulls(self, branch, state):
        return [p for p in self.pulls if p["head"] == branch and p["state"] == state]

    def create_branch(self, branch, sha):
        self._maybe_fail("create_branch")
        if branch in self.branches:
            return False
        self.branches[branch] = self.main_text
        return True

    def read_file(self, path, ref):
        return self.branches[ref]

    def file_blob_sha(self, path, ref):
        return "sha-" + ref

    def commit_file(self, path, branch, blob_sha, text, message):
        self._maybe_fail("commit")
        self.branches[branch] = text

    def open_pull(self, branch, base, title, body):
        self._maybe_fail("pull")
        pull = {"number": self.next_number, "head": branch, "state": "open", "title": title,
                "html_url": f"https://github.com/branchLeft/ghost-platform/pull/{self.next_number}"}
        self.next_number += 1
        self.pulls.append(pull)
        return pull

    def update_pull(self, number, title, body):
        self.updates.append((number, title))

    def close(self, number):
        for pull in self.pulls:
            if pull["number"] == number:
                pull["state"] = "closed"


class FakeRegistry:
    tags = TAGS
    digests = DIGESTS

    def __init__(self, *args, **kwargs):
        pass

    def list_tags(self):
        return list(self.tags)

    def resolve_digest(self, tag):
        return self.digests[tag]


class RunTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dockerfile = os.path.join(self._dir.name, "Dockerfile")
        self.metrics = os.path.join(self._dir.name, "release-watcher.prom")
        with open(self.dockerfile, "w", encoding="utf-8") as handle:
            handle.write(DOCKERFILE)
        self.repo = FakeRepo()
        FakeRegistry.tags = TAGS
        FakeRegistry.digests = dict(DIGESTS)

    def tearDown(self):
        self._dir.cleanup()

    def run_cli(self, token="t"):
        env = {"GITHUB_REPOSITORY": "branchLeft/ghost-platform", "GITHUB_SHA": MAIN_SHA}
        argv = ["--dockerfile", self.dockerfile, "--metrics", self.metrics]
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(cli, "DockerHubRegistry", FakeRegistry), \
                mock.patch.object(cli, "GitHubApi", return_value=self.repo), \
                contextlib.redirect_stdout(out):
            os.environ.pop("RELEASE_WATCHER_TOKEN", None)
            if token is not None:
                os.environ["RELEASE_WATCHER_TOKEN"] = token
            code = cli.main(argv)
        return code, out.getvalue()

    def metrics_written(self):
        return os.path.exists(self.metrics)

    def open_pulls(self):
        return [p for p in self.repo.pulls if p["state"] == "open"]

    def test_no_token_warns_opens_nothing_and_still_writes_the_gauge(self):
        code, out = self.run_cli(token=None)
        self.assertEqual(code, 0)
        self.assertIn("RELEASE_WATCHER_TOKEN is unset", out)
        self.assertEqual(self.repo.pulls, [])
        self.assertTrue(self.metrics_written())

    def test_first_run_opens_one_pr_that_changes_only_the_from_line(self):
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.open_pulls()), 1)
        self.assertEqual(self.repo.branches[BRANCH],
                         "# header\n" + from_line("6.69.0", DIGESTS["6.69.0-alpine"]) + "RUN echo kept\n")

    def test_a_403_on_pr_create_fails_the_run_and_writes_no_gauge(self):
        self.repo.fail["pull"] = "GitHub POST pulls failed: HTTP 403"
        with self.assertRaises(RuntimeError):
            self.run_cli()
        self.assertFalse(self.metrics_written())
        self.assertIn(BRANCH, self.repo.branches)
        self.assertEqual(self.repo.pulls, [])

    def test_a_rerun_after_a_403_resumes_and_opens_the_pr(self):
        self.repo.fail["pull"] = "GitHub POST pulls failed: HTTP 403"
        with self.assertRaises(RuntimeError):
            self.run_cli()
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.open_pulls()), 1)
        self.assertTrue(self.metrics_written())

    def test_a_500_on_commit_fails_the_run_and_the_rerun_commits_and_opens(self):
        self.repo.fail["commit"] = "GitHub PUT contents failed: HTTP 500"
        with self.assertRaises(RuntimeError):
            self.run_cli()
        self.assertFalse(self.metrics_written())
        self.assertEqual(self.repo.branches[BRANCH], DOCKERFILE)
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.open_pulls()), 1)

    def test_a_closed_unmerged_pr_with_the_branch_kept_is_not_reopened(self):
        self.run_cli()
        self.repo.close(1)
        code, out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("not reopened", out)
        self.assertEqual(len(self.repo.pulls), 1)
        self.assertTrue(self.metrics_written())

    def test_a_newer_tag_while_a_pr_is_open_updates_that_pr_not_a_second_one(self):
        self.run_cli()
        FakeRegistry.tags = TAGS + ["6.70.0-alpine"]
        FakeRegistry.digests["6.70.0-alpine"] = "sha256:" + "c" * 64
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.repo.pulls), 1)
        self.assertEqual(len(self.repo.updates), 1)
        self.assertIn("6.70.0-alpine", self.repo.branches[BRANCH])

    def test_a_same_tag_digest_refresh_is_not_skipped_when_the_branch_survives(self):
        self.run_cli()
        FakeRegistry.digests["6.69.0-alpine"] = "sha256:" + "d" * 64
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(len(self.repo.pulls), 1)
        self.assertIn("sha256:" + "d" * 64, self.repo.branches[BRANCH])

    def test_a_rerun_with_nothing_new_changes_nothing(self):
        self.run_cli()
        commits_before = dict(self.repo.branches)
        code, _out = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(self.repo.branches, commits_before)
        self.assertEqual(len(self.repo.pulls), 1)
        self.assertEqual(self.repo.updates, [(1, "Move Ghost base image to 6.69.0-alpine")])

    def test_a_branch_that_diverges_from_main_outside_the_from_line_is_refused(self):
        self.repo.branches[BRANCH] = DOCKERFILE + "RUN something else\n"
        with self.assertRaises(RuntimeError):
            self.run_cli()
        self.assertFalse(self.metrics_written())

    def test_a_new_major_is_noticed_on_every_run_and_nothing_is_recorded(self):
        FakeRegistry.tags = TAGS + ["7.0.0-alpine"]
        first_code, first_out = self.run_cli()
        second_code, second_out = self.run_cli()
        self.assertEqual((first_code, second_code), (0, 0))
        self.assertIn("::notice::Ghost major 7 is available", first_out)
        self.assertIn("::notice::Ghost major 7 is available", second_out)
        self.assertTrue(all("ghost-7" not in branch for branch in self.repo.branches))


if __name__ == "__main__":
    unittest.main()
