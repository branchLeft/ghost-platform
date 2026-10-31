#!/usr/bin/env python3
"""Gate for provisioning a private tenant repository.

A private tenant is provisioned only when the owner's register attests both a
paid GitHub plan and a dedicated Hetzner private-CI runner. This script is the
only code that reads the register. The provisioning workflow calls it and
parses nothing itself.

Exit 0: both attestations are the literal JSON true, and the runner label starts
with the Hetzner private-CI prefix.
Exit 1: refused. One ::error:: line per missing attestation.
Exit 2: the register is missing, unreadable, not valid JSON, has a duplicate
key, or has the wrong version or shape. Fails closed, with its own message.

Both attestations are the owner's spend. No agent procures or attests either,
and a personal Mac never qualifies as the dedicated runner.

The default register is $GITHUB_WORKSPACE/registers/private-tenant-plan.json,
or the repository root above this script when GITHUB_WORKSPACE is unset. There
is no environment switch that skips the gate.
"""

import argparse
import json
import os
import sys

REGISTER_RELPATH = os.path.join("registers", "private-tenant-plan.json")
RUNNER_LABEL_PREFIX = "private-ci-hetzner"
EXPECTED_VERSION = 1
FIELDS = (
    "version",
    "paid_plan_confirmed",
    "dedicated_runner_confirmed",
    "dedicated_runner_label",
)

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_UNUSABLE = 2

TRAILER = (
    "Both attestations are the owner's spend. An agent does not procure or "
    "attest either one. A personal Mac never qualifies as the dedicated runner."
)


class Unusable(Exception):
    """The register cannot be read as a valid plan. Exit 2."""


def _reject_duplicate_keys(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise Unusable("it repeats the key %r" % key)
        seen[key] = value
    return seen


def default_register():
    workspace = os.environ.get("GITHUB_WORKSPACE", "")
    if workspace:
        return os.path.join(workspace, REGISTER_RELPATH)
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "..", "..", REGISTER_RELPATH)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        raise Unusable("the file is missing at %s" % path)
    except (OSError, UnicodeDecodeError) as exc:
        raise Unusable("the file cannot be read: %s" % exc)
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except Unusable:
        raise
    except ValueError as exc:
        raise Unusable("it is not valid JSON: %s" % exc)


def check_shape(data):
    if not isinstance(data, dict):
        raise Unusable("the top level is not a JSON object")
    if set(data) != set(FIELDS):
        missing = sorted(set(FIELDS) - set(data))
        extra = sorted(set(data) - set(FIELDS))
        raise Unusable(
            "the fields are wrong (missing %s, unknown %s)"
            % (missing or "none", extra or "none")
        )
    version = data["version"]
    if type(version) is not int or version != EXPECTED_VERSION:
        raise Unusable("version must be %d" % EXPECTED_VERSION)
    for field in ("paid_plan_confirmed", "dedicated_runner_confirmed"):
        if type(data[field]) is not bool:
            raise Unusable(
                "%s must be the literal JSON true or false" % field
            )
    if not isinstance(data["dedicated_runner_label"], str):
        raise Unusable("dedicated_runner_label must be a string")


def refusals(data):
    lines = []
    if data["paid_plan_confirmed"] is not True:
        lines.append(
            "::error::paid_plan_confirmed is false: the owner has not "
            "confirmed a paid GitHub plan for private-repository CI. This is "
            "the owner's spend."
        )
    if data["dedicated_runner_confirmed"] is not True:
        lines.append(
            "::error::dedicated_runner_confirmed is false: the owner has not "
            "confirmed a dedicated Hetzner private-CI runner. This is the "
            "owner's spend, and a personal Mac never qualifies."
        )
    elif not data["dedicated_runner_label"].startswith(RUNNER_LABEL_PREFIX):
        lines.append(
            "::error::dedicated_runner_label does not start with %s. The "
            "attestation names a Hetzner runner, and a personal Mac never "
            "qualifies." % RUNNER_LABEL_PREFIX
        )
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Refuse a private tenant unless the owner's plan register "
        "attests both a paid plan and a dedicated runner."
    )
    parser.add_argument(
        "--register",
        default=None,
        help="path to the register (default: registers/private-tenant-plan.json "
        "under GITHUB_WORKSPACE)",
    )
    args = parser.parse_args(argv)
    path = args.register or default_register()
    try:
        data = load(path)
        check_shape(data)
    except Unusable as exc:
        print(
            "::error::the private-tenant plan register is unusable: %s. A "
            "private tenant is refused until it reads cleanly." % exc
        )
        return EXIT_UNUSABLE
    problems = refusals(data)
    if problems:
        for line in problems:
            print(line)
        print(TRAILER)
        return EXIT_REFUSED
    print(
        "private tenant plan attested: paid plan confirmed, dedicated runner "
        "confirmed with label %s" % data["dedicated_runner_label"]
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
