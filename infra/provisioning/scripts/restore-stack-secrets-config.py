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
committed for this stack, and reconstructing it here each run carries no more
exposure than the `cloud` path already did -- *provided the passphrase itself
stays high-entropy and out of the deployment*, which the RUNBOOK's own A.0
already requires. Committing it would need a commit-back step this workflow
does not have, for a value that isn't itself the secret.

A restored `encryptionsalt` is still an offline verifier, not a harmless
scalar: it is `v1:<salt>:v1:<nonce>:<ciphertext of a known plaintext>`, so
anyone holding it can brute-force the passphrase offline without ever
touching a state bucket. That is fine for a caller whose output never leaves
the runner. It stops being fine the moment a caller commits that file
somewhere else -- which is why passphrase restoration is opt-in per caller
via `--allow-passphrase` rather than the default: a call site has to decide,
not inherit, that committing this value is acceptable for what it's about to
do with it.

    restore-stack-secrets-config.py <stack> <deployment-json> [<config-dir>] [--allow-passphrase]
"""

import json
import pathlib
import sys


def _scalar_field(state: dict, field: str, stack: str, provider_label: str) -> str:
    """A value read from an exported deployment, destined for a Pulumi config
    file written with an f-string rather than a YAML serialiser. Anything
    other than a plain single-line string either produces a useless config
    file (wrong type) or, if it contains a newline, lets content from an
    exported deployment inject extra YAML keys into that file -- and this
    file is read by a job holding project-admin-equivalent GCP credentials.
    """
    value = state.get(field)
    if not isinstance(value, str) or not value or "\n" in value:
        raise SystemExit(
            f"::error::stack {stack} records a {provider_label} secrets "
            f"provider whose {field!r} is not a single-line string. Refusing "
            "to write it into the stack's config."
        )
    return value


def restore(
    stack: str,
    deployment_path: str,
    config_dir: str = ".",
    *,
    allow_passphrase: bool = False,
) -> pathlib.Path:
    try:
        deployment = json.loads(pathlib.Path(deployment_path).read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"::error::{deployment_path} is not valid JSON ({exc}). Expected "
            "the output of `pulumi stack export`."
        ) from exc

    deployment_block = deployment.get("deployment") if isinstance(deployment, dict) else None
    providers = (
        deployment_block.get("secrets_providers")
        if isinstance(deployment_block, dict)
        else None
    )
    if not isinstance(providers, dict):
        raise SystemExit(
            f"::error::{deployment_path} has no deployment.secrets_providers "
            "block to restore from. Expected the output of `pulumi stack "
            "export`."
        )

    provider_type = providers.get("type")
    state = providers.get("state")

    if provider_type == "cloud":
        # Carries a wrapped data key that can be restored this way. Writing a
        # cloud provider over a passphrase-managed stack would silently orphan
        # its encrypted values, hence the hard failure on anything else below.
        if not isinstance(state, dict):
            raise SystemExit(
                f"::error::stack {stack} records a cloud secrets provider "
                "with no state block to restore from."
            )
        url = _scalar_field(state, "url", stack, "cloud")
        encryptedkey = _scalar_field(state, "encryptedkey", stack, "cloud")
        contents = f"secretsprovider: {url}\nencryptedkey: {encryptedkey}\n"
    elif provider_type == "passphrase":
        if not allow_passphrase:
            raise SystemExit(
                f"::error::stack {stack} records a passphrase secrets "
                "provider, but this caller has not opted into restoring one "
                "(pass --allow-passphrase). Restoring it writes an offline "
                "passphrase verifier (`encryptionsalt`) into this caller's "
                "output -- safe only for a caller whose output never leaves "
                "the runner, which this one has not confirmed."
            )
        if not isinstance(state, dict):
            raise SystemExit(
                f"::error::stack {stack} records a passphrase secrets "
                "provider with no state block to restore from."
            )
        salt = _scalar_field(state, "salt", stack, "passphrase")
        if not salt.startswith("v1:"):
            raise SystemExit(
                f"::error::stack {stack}'s passphrase salt does not look like "
                "a Pulumi-generated value (expected a 'v1:' prefix). Refusing "
                "to write it into the stack's config."
            )
        contents = f"encryptionsalt: {salt}\n"
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
    allow_passphrase = "--allow-passphrase" in argv
    positional = [arg for arg in argv[1:] if not arg.startswith("--")]
    if not 2 <= len(positional) <= 3:
        raise SystemExit(__doc__)
    written = restore(
        positional[0],
        positional[1],
        positional[2] if len(positional) == 3 else ".",
        allow_passphrase=allow_passphrase,
    )
    print(f"Restored {written} from the stack's deployment.")


if __name__ == "__main__":
    main(sys.argv)
