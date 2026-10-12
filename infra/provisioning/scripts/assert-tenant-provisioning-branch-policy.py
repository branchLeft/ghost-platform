#!/usr/bin/env python3
"""Exit 0 only if the tenant-provisioning environment deploys from main only.

Usage: assert-tenant-provisioning-branch-policy.py --environment-json ENV --policies-json RULES
Rules and the fetch commands: assert-tenant-provisioning-branch-policy.md
"""

from __future__ import annotations

import argparse
import json
import sys

REQUIRED_BRANCH = "main"


def check(environment: object, branch_policies: object) -> list[str]:
    """Returns the list of problems. An empty list means exactly: selected
    branches, exactly one rule, and that rule is a branch rule named main."""
    if not isinstance(environment, dict) or not isinstance(branch_policies, dict):
        return ["an API response is not a JSON object (unreadable or error body)"]
    if "deployment_branch_policy" not in environment:
        return ["the environment response has no deployment_branch_policy field (error body?)"]
    policy = environment["deployment_branch_policy"]
    if policy is None:
        return ["the environment has no deployment branch policy: any branch can dispatch it"]
    if not isinstance(policy, dict):
        return ["the environment's deployment_branch_policy is not an object"]
    problems: list[str] = []
    if policy.get("protected_branches") is not False:
        problems.append("the environment allows protected branches, not only the selected branch")
    if policy.get("custom_branch_policies") is not True:
        problems.append("the environment has no selected-branches restriction: any branch can dispatch it")
        return problems
    if not isinstance(branch_policies.get("branch_policies"), list):
        return problems + ["the deployment-branch-policies response has no branch_policies list (error body?)"]
    names: list[str] = []
    for rule in branch_policies["branch_policies"]:
        if not isinstance(rule, dict):
            return problems + ["a deployment branch rule is not an object"]
        name = rule.get("name")
        if not isinstance(name, str):
            return problems + ["a deployment branch rule has no name"]
        if rule.get("type") != "branch":
            problems.append(f"rule {name!r} is not of type branch (type: {rule.get('type', '<missing>')!r})")
        names.append(name)
    if names != [REQUIRED_BRANCH]:
        problems.append(f"the deployment branch rules are {names}; they must be exactly ['{REQUIRED_BRANCH}']")
    return problems


def _load(path: str) -> object:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--environment-json", required=True)
    parser.add_argument("--policies-json", required=True)
    args = parser.parse_args(argv)

    try:
        environment = _load(args.environment_json)
        policies = _load(args.policies_json)
    except (OSError, ValueError) as exc:
        print(f"::error::could not read the environment documents: {exc}", file=sys.stderr)
        return 1

    problems = check(environment, policies)
    for problem in problems:
        print(f"::error::tenant-provisioning environment branch policy: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
