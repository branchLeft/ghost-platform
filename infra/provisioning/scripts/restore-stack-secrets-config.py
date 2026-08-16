#!/usr/bin/env python3
"""Rebuild a stack's `Pulumi.<stack>.yaml` secrets configuration from its own
deployment.

Pulumi writes that file only when it *creates* a stack, and it never leaves the
runner. A retry against a stack that already exists therefore has no secrets
provider configured at all: Pulumi falls back to the passphrase provider and
fails on a stack whose state says something else.

The deployment records the provider and everything needed to address it again
except the one thing that must never live in a deployment export: the secret
itself. Exporting a deployment needs no secrets manager, so restoring from
there is safe for the parts that aren't secret -- a wrapped data key (`cloud`)
or a salt (`passphrase`). What the deployment cannot supply, the passphrase
provider needs from its caller: `PULUMI_CONFIG_PASSPHRASE` in the environment,
sourced from a GitHub Actions secret in the workflow that calls this script.

Reconstructing this file on every run, rather than committing it once, is a
deliberate choice, not an oversight: `Pulumi.<stack>.yaml` has never been
committed for this stack, and neither half of the config -- a wrapped data key
or a salt -- decrypts anything by itself, so reconstructing it here each run
carries no more exposure than the `cloud` path already did. Committing it
would need a commit-back step this workflow does not have, for a value that
isn't a secret in the first place.

    restore-stack-secrets-config.py <stack> <deployment-json> [<config-dir>]
"""

import json
import pathlib
import sys


def restore(stack: str, deployment_path: str, config_dir: str = ".") -> pathlib.Path:
    providers = json.loads(pathlib.Path(deployment_path).read_text())["deployment"][
        "secrets_providers"
    ]
    provider_type = providers.get("type")

    if provider_type == "cloud":
        # Carries a wrapped data key that can be restored this way. Writing a
        # cloud provider over a passphrase-managed stack would silently orphan
        # its encrypted values, hence the hard failure on anything else below.
        state = providers["state"]
        for field in ("url", "encryptedkey"):
            if not state.get(field):
                raise SystemExit(
                    f"::error::stack {stack} records a cloud secrets provider "
                    f"with no {field}. Its state cannot be decrypted from this "
                    "deployment."
                )
        contents = (
            f"secretsprovider: {state['url']}\nencryptedkey: {state['encryptedkey']}\n"
        )
    elif provider_type == "passphrase":
        # The salt is not the secret -- it is mixed with the passphrase to
        # derive the key, and without the matching PULUMI_CONFIG_PASSPHRASE
        # this alone decrypts nothing. That's what makes restoring it from an
        # unauthenticated deployment export safe.
        state = providers["state"]
        if not state.get("salt"):
            raise SystemExit(
                f"::error::stack {stack} records a passphrase secrets provider "
                "with no salt. Its configuration cannot be reconstructed from "
                "this deployment."
            )
        contents = f"encryptionsalt: {state['salt']}\n"
    else:
        # Every other provider needs a secret this export does not and must
        # not carry. Restoring its configuration would not reproduce the key
        # its state was encrypted with.
        raise SystemExit(
            f"::error::stack {stack} records a {provider_type!r} secrets "
            "provider. Restoring its configuration would not reproduce the key "
            "its state was encrypted with."
        )

    config = pathlib.Path(config_dir) / f"Pulumi.{stack}.yaml"
    config.write_text(contents)
    return config


def main(argv: list[str]) -> None:
    if not 3 <= len(argv) <= 4:
        raise SystemExit(__doc__)
    written = restore(argv[1], argv[2], argv[3] if len(argv) == 4 else ".")
    print(f"Restored {written} from the stack's deployment.")


if __name__ == "__main__":
    main(sys.argv)
