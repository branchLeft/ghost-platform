#!/usr/bin/env python3
"""Check that the tenant-provisioning environment can be used from main only.

A workflow job that names `environment:` runs on whatever branch dispatched
it, using that branch's copy of the workflow. Only the environment's deployment
branch policy stops a non-main ref from reaching the environment's secrets.
This script asserts that policy is "selected branches", with exactly one rule:
the branch `main`.

The two JSON documents are fetched by the caller (`gh api`), so this script
takes no network access itself. See assert-tenant-provisioning-branch-policy.md.
"""

from __future__ import annotations

import argparse
import json
import sys

REQUIRED_BRANCH = "main"


def check(environment: dict, branch_policies: dict) -> list[str]:
    """Returns the list of problems. An empty list means the policy passes."""
    problems: list[str] = []
    policy = environment.get("deployment_branch_policy")
    if policy is None:
        problems.append(
            "the environment has no deployment branch policy: any branch can dispatch it"
        )
        return problems
    if policy.get("protected_branches") is not False:
        problems.append(
            "the environment allows protected branches, not only the selected branch"
        )
    if policy.get("custom_branch_policies") is not True:
        problems.append(
            "the environment has no selected-branches restriction: any branch can dispatch it"
        )
        return problems
    rules = branch_policies.get("branch_policies") or []
    names = sorted(rule.get("name", "") for rule in rules)
    types = {rule.get("type", "branch") for rule in rules}
    if names != [REQUIRED_BRANCH]:
        problems.append(
            f"the environment's deployment branch rules are {names or 'empty'}; "
            f"they must be exactly ['{REQUIRED_BRANCH}']"
        )
    if types - {"branch"}:
        problems.append(
            f"the environment has a non-branch rule (types {sorted(types)}); "
            "only a branch rule may reach it"
        )
    return problems


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--environment-json",
        required=True,
        help="output of: gh api repos/<owner>/<repo>/environments/tenant-provisioning",
    )
    parser.add_argument(
        "--policies-json",
        required=True,
        help=(
            "output of: gh api "
            "repos/<owner>/<repo>/environments/tenant-provisioning/deployment-branch-policies"
        ),
    )
    args = parser.parse_args(argv)

    problems = check(_load(args.environment_json), _load(args.policies_json))
    for problem in problems:
        print(
            "::error::tenant-provisioning environment branch policy: " + problem,
            file=sys.stderr,
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
