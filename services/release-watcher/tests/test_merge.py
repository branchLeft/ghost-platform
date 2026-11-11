import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from release_watcher import merge
from release_watcher.clients import GitHubApi

SLUG = "digest-app"
BOT = "digest-app[bot]"
HEAD = "b" * 40
BRANCH = "release-watcher/ghost-6"
OLD_TAG, NEW_TAG = "6.2.0-alpine", "6.3.1-alpine"
OLD_DIGEST = "sha256:" + "1" * 64
NEW_DIGEST = "sha256:" + "2" * 64
DOCKERFILE = f"# header\nFROM ghost:{OLD_TAG}@{OLD_DIGEST}\nRUN echo kept\n"
REQUIRED = ["docker build", "Format and lint", merge.LINE_SCOPE_CHECK]


def patch(old, new):
    return f"@@ -1,3 +1,3 @@\n # header\n-{old}\n+{new}\n RUN echo kept"


OLD_FROM = f"FROM ghost:{OLD_TAG}@{OLD_DIGEST}"
NEW_FROM = f"FROM ghost:{NEW_TAG}@{NEW_DIGEST}"


def good_files():
    return [{"filename": "Dockerfile", "status": "modified", "additions": 1, "deletions": 1,
             "patch": patch(OLD_FROM, NEW_FROM)}]


def check(name, conclusion="success", status="completed", app="github-actions"):
    return {"name": name, "status": status, "conclusion": conclusion, "app": {"slug": app}}


def all_green():
    return [check(name) for name in REQUIRED]


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeGitHub:
    def __init__(self):
        self.pulls = [{"number": 7, "state": "open", "draft": False,
                       "user": {"login": BOT, "type": "Bot"},
                       "head": {"ref": BRANCH, "sha": HEAD}, "base": {"ref": "main"},
                       "html_url": "https://github.com/branchLeft/ghost-platform/pull/7"}]
        self.files = good_files()
        self.required = list(REQUIRED)
        self.polls = [all_green()]
        self.merge_calls = []
        self.merge_error = None
        self.merge_result = {"merged": True}

    def list_pulls(self, branch, state):
        return list(self.pulls) if branch == BRANCH and state == "open" else []

    def pull_files(self, number):
        return self.files

    def required_status_contexts(self, branch):
        return self.required

    def check_runs(self, sha):
        assert sha == HEAD
        return self.polls.pop(0) if len(self.polls) > 1 else self.polls[0]

    def merge_pull(self, number, sha):
        if self.merge_error:
            raise RuntimeError(self.merge_error)
        self.merge_calls.append((number, sha))
        return self.merge_result


def env(**over):
    base = {"DIGEST_MACHINE_SLUG": SLUG, "DIGEST_MACHINE_LOGIN": BOT, "MINTED_APP_SLUG": SLUG}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()
        self.clock = Clock()

    def go(self, environment=None, timeout=300):
        return merge.run(self.github, DOCKERFILE, environment or env(),
                         clock=self.clock, sleep=self.clock.sleep, timeout=timeout, interval=10)

    def test_a_clean_digest_pr_by_the_app_is_squash_merged_at_the_checked_head(self):
        result = self.go()
        self.assertEqual(self.github.merge_calls, [(7, HEAD)])
        self.assertIn("merged", result)

    def test_checks_still_running_are_waited_for(self):
        self.github.polls = [
            [check("docker build", status="in_progress", conclusion=None)] + all_green()[1:],
            all_green(),
        ]
        self.go()
        self.assertEqual(self.github.merge_calls, [(7, HEAD)])
        self.assertGreater(self.clock.now, 0)

    def test_a_required_check_that_never_reports_times_out_without_merging(self):
        self.github.polls = [all_green()[:-1]]
        with self.assertRaisesRegex(merge.Refused, "timed out"):
            self.go(timeout=60)
        self.assertEqual(self.github.merge_calls, [])

    def test_a_failed_required_check_refuses_at_once(self):
        self.github.polls = [[check("docker build", "failure")] + all_green()[1:]]
        with self.assertRaisesRegex(merge.Refused, "docker build"):
            self.go()
        self.assertEqual(self.github.merge_calls, [])
        self.assertEqual(self.clock.now, 0)

    def test_the_line_scope_check_must_succeed_not_merely_finish(self):
        for conclusion in ("skipped", "neutral", "failure", "cancelled"):
            self.github.polls = [all_green()[:-1] + [check(merge.LINE_SCOPE_CHECK, conclusion)]]
            with self.assertRaises(merge.Refused):
                self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_a_line_scope_result_from_another_app_is_not_trusted(self):
        self.github.polls = [all_green()[:-1] + [check(merge.LINE_SCOPE_CHECK, app="other-app")]]
        with self.assertRaisesRegex(merge.Refused, "github-actions"):
            self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_a_ruleset_that_does_not_require_the_line_scope_check_refuses(self):
        self.github.required = ["docker build"]
        with self.assertRaisesRegex(merge.Refused, "does not bind"):
            self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_a_pr_by_anyone_but_the_app_is_skipped_never_merged(self):
        for user in ({"login": "someone", "type": "User"},
                     {"login": "digest-app", "type": "Bot"},
                     {"login": BOT, "type": "User"}):
            self.github.pulls[0]["user"] = user
            with self.assertRaises(merge.Skip):
                self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_with_no_slug_configured_the_route_is_off(self):
        with self.assertRaises(merge.Skip):
            self.go(env(DIGEST_MACHINE_SLUG=None))
        with self.assertRaises(merge.Skip):
            self.go(env(DIGEST_MACHINE_SLUG=""))
        self.assertEqual(self.github.merge_calls, [])

    def test_a_line_scope_identity_that_is_not_the_app_refuses_because_the_check_would_pass_unexamined(self):
        for login in (None, "", "someone-else[bot]", SLUG):
            with self.assertRaisesRegex(merge.Refused, "DIGEST_MACHINE_LOGIN"):
                self.go(env(DIGEST_MACHINE_LOGIN=login))
        self.assertEqual(self.github.merge_calls, [])

    def test_a_token_minted_for_another_app_refuses(self):
        with self.assertRaisesRegex(merge.Refused, "minted"):
            self.go(env(MINTED_APP_SLUG="other-app"))
        self.assertEqual(self.github.merge_calls, [])

    def test_a_malformed_slug_refuses(self):
        with self.assertRaises(merge.Refused):
            self.go(env(DIGEST_MACHINE_SLUG="a[bot]", DIGEST_MACHINE_LOGIN="a[bot][bot]"))

    def test_no_open_pr_means_nothing_to_merge(self):
        self.github.pulls = []
        self.assertIn("no open", self.go())
        self.assertEqual(self.github.merge_calls, [])

    def test_two_open_prs_on_the_branch_refuse(self):
        self.github.pulls.append(dict(self.github.pulls[0], number=8))
        with self.assertRaises(merge.Refused):
            self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_a_draft_or_foreign_base_refuses(self):
        self.github.pulls[0]["draft"] = True
        with self.assertRaises(merge.Refused):
            self.go()
        self.github.pulls[0].update(draft=False, base={"ref": "other"})
        with self.assertRaises(merge.Refused):
            self.go()
        self.assertEqual(self.github.merge_calls, [])

    def assert_diff_refused(self, files):
        self.github.files = files
        with self.assertRaises(merge.Refused):
            self.go()
        self.assertEqual(self.github.merge_calls, [])

    def test_a_pr_that_changes_more_than_one_file_refuses(self):
        self.assert_diff_refused(good_files() + [{"filename": "README.md", "status": "modified",
                                                  "patch": "@@ -1 +1 @@\n-a\n+b"}])

    def test_a_pr_that_renames_or_adds_the_dockerfile_refuses(self):
        for status in ("renamed", "added", "removed"):
            self.assert_diff_refused([dict(good_files()[0], status=status)])

    def test_a_pr_that_changes_a_second_line_refuses(self):
        two = "@@ -1,3 +1,4 @@\n # header\n-" + OLD_FROM + "\n+" + NEW_FROM + "\n+RUN curl evil\n RUN echo kept"
        self.assert_diff_refused([dict(good_files()[0], patch=two)])
        two = "@@ -1,3 +1,3 @@\n-# header\n+# changed\n-" + OLD_FROM + "\n+" + NEW_FROM
        self.assert_diff_refused([dict(good_files()[0], patch=two)])

    def test_a_pr_with_two_hunks_or_no_patch_refuses(self):
        self.assert_diff_refused([dict(good_files()[0], patch=good_files()[0]["patch"] + "\n@@ -9 +9 @@\n-x\n+y")])
        self.assert_diff_refused([{k: v for k, v in good_files()[0].items() if k != "patch"}])

    def test_a_pr_that_changes_the_image_name_refuses(self):
        other = NEW_FROM.replace("ghost:", "evil/ghost:")
        self.assert_diff_refused([dict(good_files()[0], patch=patch(OLD_FROM, other))])

    def test_a_new_major_is_never_merged(self):
        major = f"FROM ghost:7.0.0-alpine@{NEW_DIGEST}"
        self.assert_diff_refused([dict(good_files()[0], patch=patch(OLD_FROM, major))])

    def test_a_pr_whose_old_line_is_not_main_pin_refuses(self):
        stale = f"FROM ghost:6.1.0-alpine@{OLD_DIGEST}"
        self.assert_diff_refused([dict(good_files()[0], patch=patch(stale, NEW_FROM))])

    def test_a_merge_api_failure_is_raised_and_leaves_the_pr_untouched(self):
        self.github.merge_error = "GitHub PUT pulls/7/merge failed: HTTP 405"
        with self.assertRaisesRegex(RuntimeError, "HTTP 405"):
            self.go()
        self.assertEqual(self.github.pulls[0]["state"], "open")

    def test_a_merge_response_that_does_not_say_merged_refuses(self):
        self.github.merge_result = {"merged": False, "message": "blocked"}
        with self.assertRaises(merge.Refused):
            self.go()


class MainTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dockerfile = os.path.join(self._dir.name, "Dockerfile")
        with open(self.dockerfile, "w", encoding="utf-8") as handle:
            handle.write(DOCKERFILE)

    def tearDown(self):
        self._dir.cleanup()

    def run_main(self, run_result=None, run_error=None, token="t"):
        environment = dict(env(), GITHUB_REPOSITORY="branchLeft/ghost-platform")
        out = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.object(merge, "GitHubApi"), \
                mock.patch.object(merge, "run", return_value=run_result, side_effect=run_error), \
                contextlib.redirect_stdout(out):
            if token is not None:
                os.environ["RELEASE_WATCHER_TOKEN"] = token
            code = merge.main(["--dockerfile", self.dockerfile])
        return code, out.getvalue()

    def test_a_skip_is_a_warning_and_a_green_exit(self):
        code, out = self.run_main(run_error=merge.Skip("not the app"))
        self.assertEqual(code, 0)
        self.assertIn("::warning::", out)

    def test_a_refusal_is_an_error_annotation_and_a_failing_exit(self):
        code, out = self.run_main(run_error=merge.Refused("checks failed"))
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)

    def test_an_api_failure_is_an_error_annotation_and_a_failing_exit(self):
        code, out = self.run_main(run_error=RuntimeError("GitHub PUT pulls/7/merge failed: HTTP 405"))
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)

    def test_no_token_merges_nothing_and_stays_green(self):
        code, out = self.run_main(token=None)
        self.assertEqual(code, 0)
        self.assertIn("::warning::", out)

    def test_success_prints_the_result(self):
        code, out = self.run_main(run_result="merged PR 7")
        self.assertEqual(code, 0)
        self.assertIn("merged PR 7", out)


class ClientTests(unittest.TestCase):
    def test_merge_pull_sends_a_squash_merge_pinned_to_the_head_sha_and_nothing_else(self):
        sent = []

        def request(url, method="GET", headers=None, body=None):
            sent.append((url, method, body))
            return 200, {}, json.dumps({"merged": True}).encode()

        api = GitHubApi("branchLeft/ghost-platform", "t", request=request)
        api.merge_pull(7, HEAD)
        self.assertEqual(sent, [(
            "https://api.github.com/repos/branchLeft/ghost-platform/pulls/7/merge",
            "PUT", {"merge_method": "squash", "sha": HEAD})])

    def test_merge_pull_raises_on_a_refused_merge(self):
        api = GitHubApi("branchLeft/ghost-platform", "t",
                        request=lambda *a, **k: (405, {}, b'{"message":"blocked"}'))
        with self.assertRaisesRegex(RuntimeError, "HTTP 405"):
            api.merge_pull(7, HEAD)

    def test_required_contexts_are_read_from_the_branch_rules_of_every_ruleset(self):
        rules = [{"type": "deletion"},
                 {"type": "required_status_checks",
                  "parameters": {"required_status_checks": [{"context": "a"}, {"context": "b"}]}},
                 {"type": "required_status_checks",
                  "parameters": {"required_status_checks": [{"context": "c"}]}}]
        api = GitHubApi("branchLeft/ghost-platform", "t",
                        request=lambda *a, **k: (200, {}, json.dumps(rules).encode()))
        self.assertEqual(api.required_status_contexts("main"), ["a", "b", "c"])

    def test_check_runs_are_paged_until_the_total_is_read(self):
        pages = [{"total_count": 3, "check_runs": [{"name": "a"}, {"name": "b"}]},
                 {"total_count": 3, "check_runs": [{"name": "c"}]}]
        urls = []

        def request(url, method="GET", headers=None, body=None):
            urls.append(url)
            return 200, {}, json.dumps(pages[len(urls) - 1]).encode()

        api = GitHubApi("branchLeft/ghost-platform", "t", request=request)
        self.assertEqual([r["name"] for r in api.check_runs(HEAD)], ["a", "b", "c"])
        self.assertIn("filter=latest", urls[0])


if __name__ == "__main__":
    unittest.main()
