#!/usr/bin/env python3
"""Refuse to release the broker from a tag that is not a proper release tag.

broker-release.yml runs this in the release job, before anything is signed or
published. It fails closed: any input it cannot read, or that is not what it
expects, is a refusal. It exits 0 only when every rule below holds.

A release tag is:
  1. named broker-vMAJOR.MINOR.PATCH, nothing more;
  2. the same version as services/broker/package.json;
  3. annotated (a tag object), not a lightweight pointer at a commit;
  4. signed, with a signature GitHub itself reports as verified;
  5. pointing at a commit that is an ancestor of origin/main;
  6. pointing at the commit this workflow run is building.

Rule 6 closes the gap between the build job and the release job: a tag moved
or re-pushed in between no longer names the commit that was built.

What this does not prove is who pushed the tag, only that its signature is one
GitHub verifies. See "Release artifact and how to verify it" in
RUNBOOK-broker-deploy.md for how the consumer closes that.

Usage:
  check_release_tag.py --tag NAME --ref-json FILE --tag-json FILE \\
      --package-json FILE --expect-sha SHA --repo-dir DIR [--main-ref REF]
  check_release_tag.py --self-test

--ref-json is the GitHub API answer for git/ref/tags/<tag>; --tag-json is the
answer for git/tags/<sha> (or {} when the ref is not a tag object).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

TAG_PATTERN = re.compile(r"broker-v[0-9]+\.[0-9]+\.[0-9]+")
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")


def _get(obj, *path):
    """Walk nested dicts; None when any step is missing or not a dict."""
    for key in path:
        if not isinstance(obj, dict) or key not in obj:
            return None
        obj = obj[key]
    return obj


def check(tag, ref, tag_obj, package_version, expect_sha, on_main):
    """Return the list of reasons to refuse; empty means the tag is releasable.

    `on_main` is a bool: whether the tagged commit is an ancestor of main.
    Anything other than the exact value True counts as not on main.
    """
    problems = []

    if not isinstance(tag, str) or not TAG_PATTERN.fullmatch(tag):
        problems.append(f"tag name {tag!r} is not broker-vMAJOR.MINOR.PATCH")

    if not isinstance(package_version, str) or not VERSION_PATTERN.fullmatch(package_version):
        problems.append(f"package.json version {package_version!r} is not MAJOR.MINOR.PATCH")
    elif tag != f"broker-v{package_version}":
        problems.append(
            f"tag {tag!r} does not name package.json version {package_version!r} "
            f"(expected broker-v{package_version})"
        )

    if _get(ref, "ref") != f"refs/tags/{tag}":
        problems.append(f"ref answer is not for refs/tags/{tag}")

    ref_type = _get(ref, "object", "type")
    ref_sha = _get(ref, "object", "sha")
    if ref_type == "commit":
        problems.append("tag is lightweight (it points straight at a commit); cut an annotated, signed tag")
    elif ref_type != "tag":
        problems.append(f"ref object type {ref_type!r} is not an annotated tag")

    if ref_type == "tag":
        if not isinstance(ref_sha, str) or not SHA_PATTERN.fullmatch(ref_sha):
            problems.append("ref does not carry a tag object sha")
        elif _get(tag_obj, "sha") != ref_sha:
            problems.append("tag object answer is not the object the ref points at")

        if _get(tag_obj, "tag") != tag:
            problems.append("tag object names a different tag")

        if _get(tag_obj, "object", "type") != "commit":
            problems.append("tag object does not point at a commit")

        # `is True`, not truthiness: a string "false" or 1 must not pass.
        if _get(tag_obj, "verification", "verified") is not True:
            reason = _get(tag_obj, "verification", "reason")
            problems.append(f"tag signature is not verified by GitHub (reason: {reason!r})")

    commit = _get(tag_obj, "object", "sha")
    if not isinstance(expect_sha, str) or not SHA_PATTERN.fullmatch(expect_sha):
        problems.append("the commit being built was not given as a full sha")
    elif commit != expect_sha:
        problems.append(f"tag points at {commit!r}, not the commit being built {expect_sha!r}")

    if on_main is not True:
        problems.append("the tagged commit is not on main")

    return problems


def commit_on_main(repo_dir, commit, main_ref):
    """True only when `git merge-base --is-ancestor commit main_ref` exits 0.

    Exit 1 is "not an ancestor"; any other exit (a missing ref, a bad commit)
    is also treated as not on main.
    """
    if not isinstance(commit, str) or not SHA_PATTERN.fullmatch(commit):
        return False
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    result = subprocess.run(
        ["git", "-C", repo_dir, "merge-base", "--is-ancestor", commit, main_ref],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError) as err:
        print(f"refusing: cannot read {path}: {err}", file=sys.stderr)
        return None


def run(args):
    ref = _load_json(args.ref_json)
    tag_obj = _load_json(args.tag_json)
    package = _load_json(args.package_json)
    if ref is None or tag_obj is None or package is None:
        return 1

    commit = _get(tag_obj, "object", "sha")
    on_main = commit_on_main(args.repo_dir, commit, args.main_ref)
    problems = check(
        tag=args.tag,
        ref=ref,
        tag_obj=tag_obj,
        package_version=_get(package, "version"),
        expect_sha=args.expect_sha,
        on_main=on_main,
    )
    for problem in problems:
        print(f"::error::{problem}", file=sys.stderr)
    if problems:
        print(f"refusing to release {args.tag}: nothing signed or published.", file=sys.stderr)
        return 1
    print(f"{args.tag} is an annotated, GitHub-verified tag on main at {commit}.")
    return 0


# --- self-test ------------------------------------------------------------

_GOOD_TAG = "broker-v1.2.3"
_TAG_SHA = "a" * 40
_COMMIT_SHA = "b" * 40


def _good_inputs():
    ref = {"ref": f"refs/tags/{_GOOD_TAG}", "object": {"type": "tag", "sha": _TAG_SHA}}
    tag_obj = {
        "sha": _TAG_SHA,
        "tag": _GOOD_TAG,
        "object": {"type": "commit", "sha": _COMMIT_SHA},
        "verification": {"verified": True, "reason": "valid"},
    }
    return {
        "tag": _GOOD_TAG,
        "ref": ref,
        "tag_obj": tag_obj,
        "package_version": "1.2.3",
        "expect_sha": _COMMIT_SHA,
        "on_main": True,
    }


def _self_test_check():
    failures = []

    def expect(name, inputs, fragment):
        problems = check(**inputs)
        if fragment is None:
            if problems:
                failures.append(f"{name}: expected no problems, got {problems}")
        elif not any(fragment in p for p in problems):
            failures.append(f"{name}: expected a problem containing {fragment!r}, got {problems}")

    expect("a good release tag passes", _good_inputs(), None)

    lightweight = _good_inputs()
    lightweight["ref"]["object"] = {"type": "commit", "sha": _COMMIT_SHA}
    lightweight["tag_obj"] = {}
    expect("lightweight tag is refused", lightweight, "lightweight")

    unverified = _good_inputs()
    unverified["tag_obj"]["verification"] = {"verified": False, "reason": "unsigned"}
    expect("unverified signature is refused", unverified, "not verified by GitHub")

    truthy_string = _good_inputs()
    truthy_string["tag_obj"]["verification"] = {"verified": "true", "reason": "valid"}
    expect("a non-boolean 'verified' is refused", truthy_string, "not verified by GitHub")

    no_verification = _good_inputs()
    del no_verification["tag_obj"]["verification"]
    expect("a missing verification block is refused", no_verification, "not verified by GitHub")

    off_main = _good_inputs()
    off_main["on_main"] = False
    expect("a commit not on main is refused", off_main, "not on main")

    off_main_truthy = _good_inputs()
    off_main_truthy["on_main"] = "yes"
    expect("only a real True counts as on main", off_main_truthy, "not on main")

    mismatch = _good_inputs()
    mismatch["package_version"] = "1.2.4"
    expect("a tag that disagrees with package.json is refused", mismatch, "does not name package.json version")

    for bad in ("v1.2.3", "render-core-v1.2.3", "broker-v1.2", "broker-v1.2.3-rc1", "broker-v1.2.3\n", "xbroker-v1.2.3"):
        bad_name = _good_inputs()
        bad_name["tag"] = bad
        expect(f"tag name {bad!r} is refused", bad_name, "is not broker-vMAJOR.MINOR.PATCH")

    moved = _good_inputs()
    moved["expect_sha"] = "c" * 40
    expect("a tag that is not the built commit is refused", moved, "not the commit being built")

    wrong_ref = _good_inputs()
    wrong_ref["ref"]["ref"] = "refs/tags/broker-v9.9.9"
    expect("an answer for another tag is refused", wrong_ref, "ref answer is not for")

    swapped = _good_inputs()
    swapped["tag_obj"]["sha"] = "d" * 40
    expect("a tag object that is not the one the ref names is refused", swapped, "not the object the ref points at")

    empty = _good_inputs()
    empty["ref"] = {}
    empty["tag_obj"] = {}
    expect("empty answers are refused", empty, "not an annotated tag")

    return failures


def _git(repo, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    out = subprocess.run(
        [
            "git", "-C", repo,
            "-c", "user.name=self-test", "-c", "user.email=self-test@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main",
            *args,
        ],
        env=env, capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


def _self_test_git():
    failures = []
    with tempfile.TemporaryDirectory() as repo:
        _git(repo, "init", "--quiet")
        _git(repo, "commit", "--quiet", "--allow-empty", "-m", "on main")
        on_main_sha = _git(repo, "rev-parse", "HEAD")
        _git(repo, "checkout", "--quiet", "-b", "side")
        _git(repo, "commit", "--quiet", "--allow-empty", "-m", "side only")
        side_sha = _git(repo, "rev-parse", "HEAD")

        if not commit_on_main(repo, on_main_sha, "main"):
            failures.append("git: a commit on main was reported as not on main")
        if commit_on_main(repo, side_sha, "main"):
            failures.append("git: a commit only on a side branch was reported as on main")
        if commit_on_main(repo, "f" * 40, "main"):
            failures.append("git: an unknown commit was reported as on main")
        if commit_on_main(repo, on_main_sha, "no-such-ref"):
            failures.append("git: a missing main ref was reported as on main")
        if commit_on_main(repo, "not-a-sha", "main"):
            failures.append("git: a malformed sha was reported as on main")
    return failures


def self_test():
    failures = _self_test_check() + _self_test_git()
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if failures:
        return 1
    print("check_release_tag self-test: ok")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--tag")
    parser.add_argument("--ref-json")
    parser.add_argument("--tag-json")
    parser.add_argument("--package-json")
    parser.add_argument("--expect-sha")
    parser.add_argument("--repo-dir")
    parser.add_argument("--main-ref", default="origin/main")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    required = ("tag", "ref_json", "tag_json", "package_json", "expect_sha", "repo_dir")
    missing = [name for name in required if getattr(args, name) is None]
    if missing:
        parser.error("missing: " + ", ".join("--" + name.replace("_", "-") for name in missing))
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
