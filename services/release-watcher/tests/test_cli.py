import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from release_watcher import cli
from test_core import DIGESTS, PINNED_FROM, TAGS

DOCKERFILE = "# header\n" + PINNED_FROM + "RUN echo kept\n"


class FakeRegistry:
    tags = TAGS

    def __init__(self, *args, **kwargs):
        pass

    def list_tags(self):
        return list(self.tags)

    def resolve_digest(self, tag):
        return DIGESTS[tag]


class FakeGitHub:
    """Records every write the CLI would make, and answers reads from a script."""

    def __init__(self, open_pulls=()):
        self.open_pulls = list(open_pulls)
        self.branches = []
        self.commits = []
        self.pulls = []

    def open_pulls_for_branch(self, owner, branch):
        return self.open_pulls

    def create_branch(self, branch, sha):
        self.branches.append((branch, sha))
        return True

    def file_blob_sha(self, path, ref):
        return "blobsha"

    def commit_file(self, path, branch, blob_sha, text, message):
        self.commits.append((path, branch, text, message))

    def open_pull(self, branch, base, title, body):
        self.pulls.append((branch, base, title))
        return {"html_url": "https://github.com/branchLeft/ghost-platform/pull/1"}


class RunTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        self.dockerfile = os.path.join(self.dir, "Dockerfile")
        self.state = os.path.join(self.dir, "state.json")
        self.metrics = os.path.join(self.dir, "release-watcher.prom")
        with open(self.dockerfile, "w", encoding="utf-8") as handle:
            handle.write(DOCKERFILE)

    def tearDown(self):
        self._dir.cleanup()

    def run_cli(self, extra=(), token=None, github=None, registry_tags=None):
        env = {"GITHUB_REPOSITORY": "branchLeft/ghost-platform", "GITHUB_SHA": "a" * 40}
        argv = ["--dockerfile", self.dockerfile, "--state", self.state, "--metrics", self.metrics, *extra]
        registry_cls = FakeRegistry
        if registry_tags is not None:
            registry_cls = type("MajorRegistry", (FakeRegistry,), {"tags": registry_tags})
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(cli, "DockerHubRegistry", registry_cls), \
                mock.patch.object(cli, "GitHubApi", return_value=github or FakeGitHub()), \
                contextlib.redirect_stdout(out):
            os.environ.pop("RELEASE_WATCHER_TOKEN", None)
            if token is not None:
                os.environ["RELEASE_WATCHER_TOKEN"] = token
            code = cli.main(argv)
        return code, out.getvalue()

    def test_missing_state_without_bootstrap_is_a_hard_error(self):
        with self.assertRaises(RuntimeError):
            self.run_cli()

    def test_malformed_state_is_refused_not_defaulted(self):
        with open(self.state, "w", encoding="utf-8") as handle:
            handle.write('{"last_noticed_major": "six"}')
        with self.assertRaises(RuntimeError):
            self.run_cli()

    def test_no_token_writes_state_and_age_but_opens_no_pr(self):
        github = FakeGitHub()
        code, out = self.run_cli(["--bootstrap"], github=github)
        self.assertEqual(code, 0)
        self.assertIn("RELEASE_WATCHER_TOKEN is unset", out)
        self.assertEqual(github.branches, [])
        with open(self.state, encoding="utf-8") as handle:
            state = json.load(handle)
        self.assertEqual(state["last_noticed_major"], 6)
        self.assertGreater(state["last_successful_poll_epoch"], 0)
        with open(self.metrics, encoding="utf-8") as handle:
            self.assertIn("ghost_release_watcher_last_success_timestamp_seconds", handle.read())

    def test_with_token_opens_exactly_one_pr_changing_only_the_from_line(self):
        github = FakeGitHub()
        code, _out = self.run_cli(["--bootstrap"], token="t", github=github)
        self.assertEqual(code, 0)
        self.assertEqual(github.branches, [("release-watcher/ghost-6.69.0-alpine", "a" * 40)])
        path, _branch, text, _message = github.commits[0]
        self.assertEqual(path, "Dockerfile")
        self.assertEqual(
            text,
            "# header\n"
            f"FROM ghost:6.69.0-alpine@{DIGESTS['6.69.0-alpine']}\n"
            "RUN echo kept\n",
        )
        self.assertEqual(len(github.pulls), 1)

    def test_a_second_run_with_an_open_pr_does_nothing_more(self):
        github = FakeGitHub(open_pulls=[{"number": 1}])
        _code, out = self.run_cli(["--bootstrap"], token="t", github=github)
        self.assertIn("already carries this digest", out)
        self.assertEqual(github.branches, [])
        self.assertEqual(github.commits, [])
        self.assertEqual(github.pulls, [])

    def test_a_new_major_prints_a_notice_and_opens_no_pr(self):
        with open(self.state, "w", encoding="utf-8") as handle:
            json.dump({"last_noticed_major": 6}, handle)
        github = FakeGitHub()
        code, out = self.run_cli(
            token="t", github=github, registry_tags=TAGS + ["7.0.0-alpine"]
        )
        self.assertEqual(code, 0)
        self.assertIn("::notice::Ghost major 7 is available", out)
        self.assertEqual(github.pulls, [("release-watcher/ghost-6.69.0-alpine", "main", "Move Ghost base image to 6.69.0-alpine")])
        self.assertTrue(all("ghost-7" not in branch for branch, _sha in github.branches))
        with open(self.state, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["last_noticed_major"], 7)


if __name__ == "__main__":
    unittest.main()
