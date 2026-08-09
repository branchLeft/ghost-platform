#!/usr/bin/env python3
"""Rebuild a stack's `Pulumi.<stack>.yaml` secrets configuration from its own
deployment.

Pulumi writes that file only when it *creates* a stack, and it never leaves the
runner. A retry against a stack that already exists therefore has no secrets
provider configured at all: Pulumi falls back to the passphrase provider and
fails on a stack whose state says `gcpkms`.

The deployment records both the provider and its wrapped data key, and
exporting a deployment needs no secrets manager -- so the configuration is
restored from there. Naming the key again instead would mint a *fresh* data
key, which cannot decrypt the values already in that state.

    restore-stack-secrets-config.py <stack> <deployment-json> [<config-dir>]
"""

import json
import pathlib
import sys


def restore(stack: str, deployment_path: str, config_dir: str = ".") -> pathlib.Path:
    providers = json.loads(pathlib.Path(deployment_path).read_text())["deployment"][
        "secrets_providers"
    ]

    # Only `cloud` carries a wrapped data key that can be restored this way. A
    # passphrase-managed stack would need the passphrase itself, and writing a
    # cloud provider over it would silently orphan its encrypted values.
    if providers.get("type") != "cloud":
        raise SystemExit(
            f"::error::stack {stack} records a {providers.get('type')!r} secrets "
            "provider. Restoring its configuration would not reproduce the key "
            "its state was encrypted with."
        )

    state = providers["state"]
    for field in ("url", "encryptedkey"):
        if not state.get(field):
            raise SystemExit(
                f"::error::stack {stack} records a cloud secrets provider with no "
                f"{field}. Its state cannot be decrypted from this deployment."
            )

    config = pathlib.Path(config_dir) / f"Pulumi.{stack}.yaml"
    config.write_text(
        f"secretsprovider: {state['url']}\nencryptedkey: {state['encryptedkey']}\n"
    )
    return config


def main(argv: list[str]) -> None:
    if not 3 <= len(argv) <= 4:
        raise SystemExit(__doc__)
    written = restore(argv[1], argv[2], argv[3] if len(argv) == 4 else ".")
    print(f"Restored {written} from the stack's deployment.")


if __name__ == "__main__":
    main(sys.argv)
