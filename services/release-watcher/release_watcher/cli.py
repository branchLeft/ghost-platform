"""Entry point: poll the registry, optionally open the digest PR, publish poll age."""

import argparse
import json
import os
import sys
import time

from release_watcher import core
from release_watcher.clients import DockerHubRegistry, GitHubApi

BRANCH_PREFIX = "release-watcher/ghost-"
PR_BASE = "main"


def load_state(path, bootstrap, pinned_major):
    if not os.path.exists(path):
        if not bootstrap:
            raise RuntimeError(f"state file missing at {path}; pass --bootstrap only on first run")
        return {"last_noticed_major": pinned_major}
    with open(path, encoding="utf-8") as handle:
        state = json.load(handle)
    if not isinstance(state.get("last_noticed_major"), int):
        raise RuntimeError(f"state file at {path} is malformed; refusing to default it")
    return state


def open_digest_pr(github, dockerfile_text, decision, sha):
    branch = f"{BRANCH_PREFIX}{decision.pr_tag}"
    owner = os.environ["GITHUB_REPOSITORY"].split("/")[0]
    if github.open_pulls_for_branch(owner, branch):
        return "skipped: an open PR already carries this digest"
    if not github.create_branch(branch, sha):
        return "skipped: the branch already exists without an open PR; owner to inspect"
    blob = github.file_blob_sha("Dockerfile", sha)
    text = core.apply_pin(dockerfile_text, decision.pr_tag, decision.pr_digest)
    github.commit_file("Dockerfile", branch, blob, text, f"Move the Ghost base image to {decision.pr_tag}")
    body = (
        f"Moves the Ghost base image to `ghost:{decision.pr_tag}` at `{decision.pr_digest}`.\n\n"
        "Opened by the release watcher. Only the `FROM` line of `Dockerfile` changes.\n"
    )
    pull = github.open_pull(branch, PR_BASE, f"Move Ghost base image to {decision.pr_tag}", body)
    return f"opened PR {pull.get('html_url', '(no url returned)')}"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="release-watcher")
    parser.add_argument("--dockerfile", default="Dockerfile")
    parser.add_argument("--state", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args(argv)

    with open(args.dockerfile, encoding="utf-8") as handle:
        dockerfile_text = handle.read()
    pin = core.read_pin(dockerfile_text)
    state = load_state(args.state, args.bootstrap, pin.version[0])

    registry = DockerHubRegistry()
    decision = core.decide(
        pin, registry.list_tags(), registry.resolve_digest, state["last_noticed_major"]
    )

    notes = [decision.reason]
    if decision.notify_major is not None:
        notes.append(f"new major {decision.notify_major} seen; notice only, nothing started")
        print(f"::notice::Ghost major {decision.notify_major} is available; no PR opened")
        state["last_noticed_major"] = decision.notify_major

    if decision.pr_tag is not None:
        token = os.environ.get("RELEASE_WATCHER_TOKEN")
        if not token:
            notes.append("no PR: RELEASE_WATCHER_TOKEN is not set")
            print("::warning::pin is behind, but RELEASE_WATCHER_TOKEN is unset; no PR opened")
        else:
            github = GitHubApi(os.environ["GITHUB_REPOSITORY"], token)
            notes.append(open_digest_pr(github, dockerfile_text, decision, os.environ["GITHUB_SHA"]))

    now = time.time()
    with open(args.state, "w", encoding="utf-8") as handle:
        json.dump({"last_noticed_major": state["last_noticed_major"], "last_successful_poll_epoch": int(now)}, handle, indent=2)
        handle.write("\n")
    with open(args.metrics, "w", encoding="utf-8") as handle:
        handle.write(core.render_age_metric(now))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("### Release watcher\n\n" + "".join(f"- {note}\n" for note in notes))
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
