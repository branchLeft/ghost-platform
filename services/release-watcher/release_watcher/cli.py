"""Entry point: poll the registry, reconcile the line's PR, publish the poll age."""

import argparse
import os
import sys
import time

from release_watcher import core
from release_watcher.clients import DockerHubRegistry, GitHubApi

BRANCH_PREFIX = "release-watcher/ghost-"
PR_BASE = "main"
DOCKERFILE_PATH = "Dockerfile"


def line_branch(pin):
    """One branch per major line: at most one watcher PR per line, ever."""
    return f"{BRANCH_PREFIX}{pin.version[0]}"


def check_existing_branch(github, branch, main_sha):
    """A kept branch must sit on main's current tip and change only the Dockerfile."""
    comparison = github.compare(main_sha, branch)
    if comparison["behind_by"] > 0:
        raise RuntimeError(
            f"{branch} is {comparison['behind_by']} commit(s) behind main; the owner deletes "
            "the branch and the next run recreates it from main"
        )
    other = [f["filename"] for f in comparison.get("files", []) if f["filename"] != DOCKERFILE_PATH]
    if other:
        raise RuntimeError(
            f"{branch} changes files other than {DOCKERFILE_PATH}: {', '.join(other)}; refusing"
        )


def reconcile_pr(github, main_text, main_sha, pin, decision):
    """Create or resume the line's PR. Every step is safe to rerun after a failure."""
    branch = line_branch(pin)
    created = github.create_branch(branch, main_sha)
    if not created:
        check_existing_branch(github, branch, main_sha)
    branch_text = main_text if created else github.read_file(DOCKERFILE_PATH, branch)
    if core.without_from_line(branch_text) != core.without_from_line(main_text):
        raise RuntimeError(
            f"{branch} differs from main outside the FROM line; the owner must delete it "
            "before the watcher can continue"
        )
    target_text = core.apply_pin(branch_text, decision.pr_tag, decision.pr_digest)
    open_pulls = github.list_pulls(branch, "open")
    if not open_pulls and not created and target_text == branch_text:
        if github.list_pulls(branch, "closed"):
            return (
                f"not reopened: the PR for {decision.pr_tag} was closed without merging; "
                "a new tag or digest reopens it"
            )

    if target_text != branch_text:
        blob = github.file_blob_sha(DOCKERFILE_PATH, branch)
        github.commit_file(
            DOCKERFILE_PATH, branch, blob, target_text, f"Move Ghost base image to {decision.pr_tag}"
        )
    title = f"Move Ghost base image to {decision.pr_tag}"
    body = (
        f"Moves the Ghost base image to `ghost:{decision.pr_tag}` at `{decision.pr_digest}`.\n\n"
        "Opened by the release watcher. Only the `FROM` line of `Dockerfile` changes. "
        "The watcher updates this PR in place for later tags or digests on the same major line.\n"
    )
    if open_pulls:
        github.update_pull(open_pulls[0]["number"], title, body)
        return f"updated PR {open_pulls[0].get('html_url', '(no url)')}"
    pull = github.open_pull(branch, PR_BASE, title, body)
    return f"opened PR {pull.get('html_url', '(no url returned)')}"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="release-watcher")
    parser.add_argument("--dockerfile", default=DOCKERFILE_PATH)
    parser.add_argument("--metrics", required=True)
    args = parser.parse_args(argv)

    with open(args.dockerfile, encoding="utf-8") as handle:
        dockerfile_text = handle.read()
    pin = core.read_pin(dockerfile_text)

    registry = DockerHubRegistry()
    decision = core.decide(pin, registry.list_tags(), registry.resolve_digest)

    notes = [decision.reason]
    if decision.notify_major is not None:
        # Not recorded as noticed: the owner digest has no input from this job,
        # so the notice re-raises on every run until that feed exists.
        notes.append(f"new major {decision.notify_major} seen; notice only, nothing started")
        print(f"::notice::Ghost major {decision.notify_major} is available; no PR opened")

    token = os.environ.get("RELEASE_WATCHER_TOKEN")
    pr_writes_enabled = bool(token)
    if not token:
        notes.append("cannot open PRs: RELEASE_WATCHER_TOKEN is not set")
    if decision.pr_tag is not None:
        if not token:
            print("::warning::pin is behind, but RELEASE_WATCHER_TOKEN is unset; no PR opened")
        else:
            github = GitHubApi(os.environ["GITHUB_REPOSITORY"], token)
            notes.append(
                reconcile_pr(github, dockerfile_text, os.environ["GITHUB_SHA"], pin, decision)
            )

    # Written only after every step above has succeeded: a failure raises
    # before this line, so the gauge's age keeps growing.
    with open(args.metrics, "w", encoding="utf-8") as handle:
        handle.write(core.render_age_metric(time.time(), pr_writes_enabled))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("### Release watcher\n\n" + "".join(f"- {note}\n" for note in notes))
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
