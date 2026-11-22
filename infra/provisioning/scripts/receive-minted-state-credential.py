#!/usr/bin/env python3
"""Take the new tenant's own minted state credential, or stop the run.

The pair arrives in two environment secrets of the `tenant-provisioning`
environment, filled by the provisioning controller's `mint-state-credential`
step. This script masks both values first, refuses anything absent or
malformed, and hands the pair to later steps as `STATE_GATEWAY_ACCESS_KEY_ID`
and `STATE_GATEWAY_SECRET_ACCESS_KEY` through `$GITHUB_ENV`.

It fails closed. There is no fallback to any other key: it reads no
`AWS_*` variable and no shared state credential, so a missing pair is a
stopped run and never a quiet use of a key that reaches other tenants' state.
See receive-minted-state-credential.md#module-overview.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping

ID_VARIABLE = "MINTED_STATE_ACCESS_KEY_ID"
SECRET_VARIABLE = "MINTED_STATE_SECRET_ACCESS_KEY"

# Printable, no whitespace, no control character: a value that carries a
# newline could add a line to $GITHUB_ENV, so it is refused, not escaped.
_TOKEN = re.compile(r"^[\x21-\x7e]{8,512}$")


def main(env: Mapping[str, str], github_env_path: str | None) -> int:
    values = {name: env.get(name, "") for name in (ID_VARIABLE, SECRET_VARIABLE)}

    # Masked before anything can print or fail, for the values that can be:
    # a mask registered here applies to every later line of the job.
    for value in values.values():
        if value and "\n" not in value and "\r" not in value:
            print(f"::add-mask::{value}")

    absent = [name for name, value in values.items() if not value.strip()]
    if absent:
        print(
            f"::error::the tenant's own state credential has not been delivered: {', '.join(absent)} "
            "is empty or unset on the tenant-provisioning environment. The provisioning "
            "controller's mint-state-credential step fills it for this run. Refusing: "
            "there is no fallback to any other state key.",
            file=sys.stderr,
        )
        return 1
    malformed = [name for name, value in values.items() if not _TOKEN.fullmatch(value)]
    if malformed:
        print(
            f"::error::{', '.join(malformed)} is not a usable credential (8 to 512 printable "
            "characters, no whitespace). Refusing to continue.",
            file=sys.stderr,
        )
        return 1
    if not github_env_path:
        print("::error::GITHUB_ENV is not set; there is nowhere to hand the credential to.", file=sys.stderr)
        return 1
    with open(github_env_path, "a", encoding="utf-8") as handle:
        handle.write(f"STATE_GATEWAY_ACCESS_KEY_ID={values[ID_VARIABLE]}\n")
        handle.write(f"STATE_GATEWAY_SECRET_ACCESS_KEY={values[SECRET_VARIABLE]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(os.environ, os.environ.get("GITHUB_ENV")))
