#!/usr/bin/env python3
"""Choose the environment a Hetzner apply job runs in.

Rule: decide(). A non-zero exit writes nothing, and the workflow reads that
as the owner environment. Narrative: choose-apply-environment.md.
"""

import argparse
import os
import re
import sys

FREE_ENVIRONMENT = "production-free"
DEFAULT_OWNER_ENVIRONMENT = "production"
# A plain environment name: nothing in it can add a line to the output file.
OWNER_ENVIRONMENT_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,62}")


def decide(spend_verdict, preview_outcome, delete_guard_outcome, free_environment_ready,
           owner_environment=DEFAULT_OWNER_ENVIRONMENT):
    """Return (environment, reason). Only exact strings count as good.

    The reason is fixed text: no input is ever copied into it, so a hostile
    value cannot add a line to the output file.
    """
    if preview_outcome != "success":
        return owner_environment, "the preview did not succeed, so the plan is not read as free"
    if delete_guard_outcome != "success":
        return owner_environment, "the delete guard did not succeed, so the plan is not read as free"
    if spend_verdict == "":
        return owner_environment, "the spend gate gave no verdict, which is read as paid"
    if spend_verdict != "FREE":
        return owner_environment, "the spend gate did not say every change is free"
    if free_environment_ready != "true":
        return owner_environment, (
            "the production-free environment is not confirmed gated by the reviewer App's rule"
        )
    return FREE_ENVIRONMENT, "the spend gate says every change is free"


def owner_environment_name(value):
    """The owner environment argument, or an argparse error. It is never the
    free environment, so the fallback cannot be the route it falls back from."""
    if value == FREE_ENVIRONMENT or not OWNER_ENVIRONMENT_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError("not a plain owner environment name")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--github-output", required=True)
    parser.add_argument("--github-summary", required=True)
    parser.add_argument(
        "--owner-environment", type=owner_environment_name, default=DEFAULT_OWNER_ENVIRONMENT
    )
    args = parser.parse_args(argv)
    environment, reason = decide(
        os.environ.get("SPEND_VERDICT", ""),
        os.environ.get("PREVIEW_OUTCOME", ""),
        os.environ.get("DELETE_GUARD_OUTCOME", ""),
        os.environ.get("FREE_ENVIRONMENT_READY", ""),
        args.owner_environment,
    )
    line = "Apply environment: `%s`, because %s." % (environment, reason)
    with open(args.github_summary, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    # Written last and in one write: a failure before this leaves the output
    # unset, which the workflow reads as the owner environment.
    with open(args.github_output, "a", encoding="utf-8") as handle:
        handle.write("environment=%s\nreason=%s\n" % (environment, reason))
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
