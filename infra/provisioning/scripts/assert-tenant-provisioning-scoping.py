#!/usr/bin/env python3
"""Check that every provisioning-capable secret is environment-scoped and
not shadowed by a repository-level copy of the same name.

`secrets.X` in a workflow step resolves an environment secret first and
silently falls back to a repository secret of the same name. That makes two
checks necessary, not one: a required secret can be present at the
environment level and *still* be readable by any workflow run in the
repository, including one added on a branch, if a same-named copy also sits
at the repository level.

  - MISSING: a required secret is absent from the environment's own secret
    list.
  - SHADOWED: a required secret's name also appears in the repository-level
    list.

This script holds only the set logic and takes no network access itself --
the two secret-name lists are the caller's job to fetch (`gh api ... | jq`
in the workflow), which is what keeps this half testable offline. `--self-test`
proves the logic against the exact case branchLeft/workspace#284 could not
construct with the pre-rename names: `HETZNER_S3_ACCESS_KEY_ID` /
`HETZNER_S3_SECRET_ACCESS_KEY` genuinely need to exist at the repository
level for `infra-hosts-ci.yml`, so a required set that named them would
always fail SHADOWED and a required set that didn't would never test the
check at all.

    assert-tenant-provisioning-scoping.py --self-test
    assert-tenant-provisioning-scoping.py \
        --environment-secrets <file> --repository-secrets <file>

A failure message's remediation commands (`gh secret set ... --repo`) carry
the real owner/repo, read from $GITHUB_REPOSITORY -- which the Actions runner
always sets -- or an explicit --repo, so an operator can copy one straight
out of a failed run's log rather than reconstructing it by hand during a
failed provisioning run.
"""

from __future__ import annotations

import argparse
import os
import sys

# Used only when neither $GITHUB_REPOSITORY nor an explicit --repo is
# available -- outside a real Actions run, i.e. local testing. A real
# provisioning run always has $GITHUB_REPOSITORY set by the runner, so an
# operator reading a failed run's log always gets a pasteable command, never
# this placeholder.
REPO_PLACEHOLDER = "<owner>/<repo>"

# The tenant-provisioning environment's own credentials. Not
# HETZNER_S3_ACCESS_KEY_ID / HETZNER_S3_SECRET_ACCESS_KEY: those name the
# estate's hosts-stack credential and must stay readable at the repository
# level for infra-hosts-ci.yml, which declares no `environment:` on its plan
# job and so can only ever resolve a repository secret.
REQUIRED_SECRETS = frozenset(
    {
        "GH_PAT_TENANT_PROVISIONING",
        "TENANT_STATE_S3_ACCESS_KEY_ID",
        "TENANT_STATE_S3_SECRET_ACCESS_KEY",
    }
)


def check(
    environment_names: list[str], repository_names: list[str]
) -> tuple[frozenset[str], frozenset[str]]:
    """Returns (missing, shadowed). Both empty means the scoping passes."""
    env_set = frozenset(environment_names)
    repo_set = frozenset(repository_names)
    missing = REQUIRED_SECRETS - env_set
    shadowed = REQUIRED_SECRETS & repo_set
    return missing, shadowed


def _read_names(path: str) -> list[str]:
    with open(path, encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


def _missing_message(missing: frozenset[str], repo: str) -> str:
    return (
        "::error::these secrets are not scoped to the tenant-provisioning "
        f"environment: {' '.join(sorted(missing))}. They are "
        "provisioning-capable credentials and must sit behind the "
        "required-reviewer gate. Move each one with: gh secret set <NAME> "
        f"--repo {repo} --env tenant-provisioning, then delete the "
        "repository-level copy."
    )


def _shadowed_message(shadowed: frozenset[str], repo: str) -> str:
    return (
        "::error::these provisioning-capable secrets still exist at the "
        f"repository level: {' '.join(sorted(shadowed))}. Any workflow run "
        "in this repository can read them, including one added on a "
        "branch, which is the exact reach the environment scoping exists "
        f"to remove. Delete each with: gh secret delete <NAME> --repo {repo}"
    )


def _self_test() -> None:
    # The passing case, and the one the pre-rename names could never reach:
    # the estate's hosts secrets sit at the repository level, ours are
    # environment-scoped, and the two required sets no longer intersect.
    missing, shadowed = check(
        environment_names=[
            "GH_PAT_TENANT_PROVISIONING",
            "TENANT_STATE_S3_ACCESS_KEY_ID",
            "TENANT_STATE_S3_SECRET_ACCESS_KEY",
        ],
        repository_names=["HETZNER_S3_ACCESS_KEY_ID", "HETZNER_S3_SECRET_ACCESS_KEY"],
    )
    assert not missing and not shadowed, (
        "expected a pass with HETZNER_S3_* at the repository level and "
        "TENANT_STATE_S3_* environment-scoped -- this is the exact case "
        "branchLeft/workspace#284 could not construct before the rename"
    )

    # MISSING: nothing has been scoped to the environment yet.
    missing, shadowed = check(environment_names=[], repository_names=[])
    assert missing == REQUIRED_SECRETS
    assert not shadowed

    # SHADOWED: a required secret was moved to the environment but its
    # repository-level copy was never deleted.
    missing, shadowed = check(
        environment_names=[
            "GH_PAT_TENANT_PROVISIONING",
            "TENANT_STATE_S3_ACCESS_KEY_ID",
            "TENANT_STATE_S3_SECRET_ACCESS_KEY",
        ],
        repository_names=["TENANT_STATE_S3_ACCESS_KEY_ID"],
    )
    assert not missing
    assert shadowed == {"TENANT_STATE_S3_ACCESS_KEY_ID"}

    # A repository secret unrelated to this set (like the estate's hosts
    # credential, or something else entirely) is never a shadow.
    missing, shadowed = check(
        environment_names=[
            "GH_PAT_TENANT_PROVISIONING",
            "TENANT_STATE_S3_ACCESS_KEY_ID",
            "TENANT_STATE_S3_SECRET_ACCESS_KEY",
        ],
        repository_names=["SOME_OTHER_SECRET"],
    )
    assert not missing and not shadowed

    print("self-test OK")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--environment-secrets",
        help="file of newline-separated secret names scoped to the tenant-provisioning environment",
    )
    parser.add_argument(
        "--repository-secrets",
        help="file of newline-separated secret names at the repository level",
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("GITHUB_REPOSITORY") or None,
        help=(
            "owner/repo interpolated into the remediation commands in a "
            "failure message. Defaults to $GITHUB_REPOSITORY, which the "
            "Actions runner always sets during a real workflow run; falls "
            f"back to the placeholder '{REPO_PLACEHOLDER}' when neither is "
            "available, e.g. running this script locally."
        ),
    )
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    if not args.environment_secrets or not args.repository_secrets:
        parser.error("--environment-secrets and --repository-secrets are required unless --self-test")

    missing, shadowed = check(
        _read_names(args.environment_secrets), _read_names(args.repository_secrets)
    )
    repo = args.repo or REPO_PLACEHOLDER

    ok = True
    if missing:
        print(_missing_message(missing, repo), file=sys.stderr)
        ok = False
    if shadowed:
        print(_shadowed_message(shadowed, repo), file=sys.stderr)
        ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
