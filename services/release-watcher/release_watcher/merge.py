"""Merge the digest PR the release watcher keeps open, once it is provably only the FROM line.

Every gate below fails closed. A pull request that is simply not ours to merge
(no App configured, another author) is a Skip: a warning, a green run. One that
should have merged and did not (a failed or missing check, a diff that is more
than the FROM line, a timeout, an API refusal) is a Refused or an error: the PR
stays open and the job fails.
"""

import argparse
import os
import re
import sys
import time

from release_watcher import core
from release_watcher.cli import PR_BASE, line_branch
from release_watcher.clients import GitHubApi

DOCKERFILE_PATH = "Dockerfile"
LINE_SCOPE_CHECK = "Digest-only line scope"
LINE_SCOPE_APP = "github-actions"
PASSING = ("success", "neutral", "skipped")
SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*")
FROM_LINE = re.compile(r"FROM ([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})")
IMAGE = "ghost"
INTERVAL_SECONDS = 30
TIMEOUT_SECONDS = 1800


class Skip(Exception):
    """Not ours to merge; say so and stay green."""


class Refused(RuntimeError):
    """Ours to merge and not safe to: leave the PR open and fail the job."""


def expected_author(env):
    """The one login whose PR may merge, after the three identity cross-checks."""
    slug = (env.get("DIGEST_MACHINE_SLUG") or "").strip()
    if not slug:
        raise Skip("DIGEST_MACHINE_SLUG is not set; the digest merge route is off")
    if SLUG.fullmatch(slug) is None:
        raise Refused(f"DIGEST_MACHINE_SLUG must be the bare App slug; found {slug!r}")
    login = f"{slug}[bot]"
    if (env.get("MINTED_APP_SLUG") or "").lower() != slug.lower():
        raise Refused("the minted token belongs to a different App than DIGEST_MACHINE_SLUG names")
    # The line-scope check reads DIGEST_MACHINE_LOGIN and passes every PR while
    # it is unset or another identity, so merging is refused unless it is ours.
    if (env.get("DIGEST_MACHINE_LOGIN") or "").lower() != login.lower():
        raise Refused(
            f"DIGEST_MACHINE_LOGIN must be {login}; otherwise the {LINE_SCOPE_CHECK} check "
            "would pass this pull request without examining it"
        )
    return login


def is_authored_by(pull, login):
    user = pull.get("user") or {}
    return (user.get("login") or "").lower() == login.lower() and user.get("type") == "Bot"


def _from_line(text):
    match = FROM_LINE.fullmatch(text)
    if match is None:
        raise Refused(f"a changed line is not FROM {IMAGE}:<tag>@sha256:<digest>: {text!r}")
    image, tag, digest = match.groups()
    version = core.parse_version(tag)
    if image != IMAGE or version is None:
        raise Refused(f"a changed line is not a stable {IMAGE} tag: {text!r}")
    return tag, digest, version


def verify_digest_only(files, pin):
    """The PR is one modified Dockerfile with one FROM line swapped on the pinned major."""
    if len(files) != 1:
        raise Refused(f"the PR changes {len(files)} files; exactly one is allowed")
    changed = files[0]
    if changed.get("filename") != DOCKERFILE_PATH or changed.get("status") != "modified":
        raise Refused(f"the PR must modify {DOCKERFILE_PATH} only; found {changed.get('filename')!r}")
    lines = (changed.get("patch") or "").split("\n")
    if not changed.get("patch"):
        raise Refused("the Dockerfile patch is not available; refusing")
    if sum(1 for line in lines if line.startswith("@@")) != 1:
        raise Refused("the Dockerfile must change in exactly one hunk")
    removed = [line[1:] for line in lines if line.startswith("-")]
    added = [line[1:] for line in lines if line.startswith("+")]
    if len(removed) != 1 or len(added) != 1:
        raise Refused("the hunk must replace exactly one line with exactly one line")
    old_tag, old_digest, old_version = _from_line(removed[0])
    _new_tag, _new_digest, new_version = _from_line(added[0])
    if (old_tag, old_digest) != (pin.tag, pin.digest):
        raise Refused("the line the PR replaces is not the pin on main; refusing a stale PR")
    if new_version[0] != pin.version[0] or old_version[0] != pin.version[0]:
        raise Refused("a change of major version is never merged here")


def assess_checks(required, runs):
    """Return the names still pending; raise Refused on any failure."""
    latest = {}
    for run in runs:
        latest[run.get("name")] = run
    failed, pending = [], []
    for name in required:
        run = latest.get(name)
        if run is None or run.get("status") != "completed":
            pending.append(name)
            continue
        conclusion = run.get("conclusion")
        allowed = ("success",) if name == LINE_SCOPE_CHECK else PASSING
        if conclusion not in allowed:
            failed.append(f"{name} ({conclusion})")
        elif name == LINE_SCOPE_CHECK and (run.get("app") or {}).get("slug") != LINE_SCOPE_APP:
            failed.append(f"{name} (not reported by {LINE_SCOPE_APP})")
    if failed:
        raise Refused("required checks did not pass: " + ", ".join(failed))
    return pending


def wait_for_checks(github, sha, required, clock, sleep, timeout, interval):
    deadline = clock() + timeout
    while True:
        pending = assess_checks(required, github.check_runs(sha))
        if not pending:
            return
        if clock() + interval > deadline:
            raise Refused(f"timed out waiting for required checks: {', '.join(pending)}")
        print(f"waiting for: {', '.join(pending)}")
        sleep(interval)


def run(github, dockerfile_text, env, clock=time.monotonic, sleep=time.sleep,
        timeout=TIMEOUT_SECONDS, interval=INTERVAL_SECONDS):
    login = expected_author(env)
    pin = core.read_pin(dockerfile_text)
    pulls = github.list_pulls(line_branch(pin), "open")
    if not pulls:
        return "no open digest PR; nothing to merge"
    if len(pulls) != 1:
        raise Refused(f"{len(pulls)} open PRs on the watcher branch; refusing to choose")
    pull = pulls[0]
    if not is_authored_by(pull, login):
        raise Skip(f"PR {pull.get('number')} is not authored by {login}; not merging it")
    if pull.get("draft") or (pull.get("base") or {}).get("ref") != PR_BASE:
        raise Refused(f"PR {pull.get('number')} is a draft or does not target {PR_BASE}")

    verify_digest_only(github.pull_files(pull["number"]), pin)

    required = github.required_status_contexts(PR_BASE)
    if LINE_SCOPE_CHECK not in required:
        raise Refused(f"no ruleset on {PR_BASE} requires {LINE_SCOPE_CHECK}; it does not bind")
    head = pull["head"]["sha"]
    wait_for_checks(github, head, required, clock, sleep, timeout, interval)

    result = github.merge_pull(pull["number"], head)
    if not result.get("merged"):
        raise Refused(f"GitHub did not merge PR {pull['number']}: {result.get('message', 'no reason')}")
    return f"merged PR {pull['number']} (squash) at {head}"


def _summary(env, line):
    path = env.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"### Digest merge\n\n- {line}\n")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="release-watcher-merge")
    parser.add_argument("--dockerfile", default=DOCKERFILE_PATH)
    args = parser.parse_args(argv)

    token = os.environ.get("RELEASE_WATCHER_TOKEN")
    if not token:
        print("::warning::no App token; the digest PR is not merged")
        return 0
    with open(args.dockerfile, encoding="utf-8") as handle:
        dockerfile_text = handle.read()
    github = GitHubApi(os.environ["GITHUB_REPOSITORY"], token)
    try:
        outcome = run(github, dockerfile_text, os.environ)
    except Skip as skipped:
        print(f"::warning::{skipped}")
        _summary(os.environ, f"not merged: {skipped}")
        return 0
    except (Refused, RuntimeError) as failure:
        print(f"::error::digest PR left open: {failure}")
        _summary(os.environ, f"left open: {failure}")
        return 1
    print(outcome)
    _summary(os.environ, outcome)
    return 0


if __name__ == "__main__":
    sys.exit(main())
