#!/usr/bin/env python3
"""Mint one tenant's own Pulumi secrets passphrase.

Prints exactly one high-entropy value to stdout and nothing else, so the
caller captures it with plain command substitution -- no prefix, no trailing
explanation, nothing a stray print could mix into the value that then gets
written into a GitHub Actions secret and an `encryptionsalt`-bearing config
file.

Uses `secrets.token_urlsafe`, the CSPRNG-backed generator, never `random`:
`random` is a Mersenne Twister, seedable and predictable from enough output,
and a passphrase is exactly the value that must not be.

    mint-tenant-passphrase.py [--bytes N]
"""

import argparse
import secrets
import sys

# 32 bytes is 256 bits of entropy before base64/URL-safe encoding: enough that
# brute-forcing this value is infeasible for the lifetime of the stack it
# protects, with headroom to spare. A caller asking for less is asking for a
# weaker floor than a machine-minted secret has any reason to accept.
MIN_BYTES = 32


def mint(num_bytes: int = MIN_BYTES) -> str:
    if num_bytes < MIN_BYTES:
        raise SystemExit(
            f"::error::refusing to mint a passphrase under {MIN_BYTES} bytes "
            f"of entropy (asked for {num_bytes})"
        )
    return secrets.token_urlsafe(num_bytes)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--bytes",
        type=int,
        default=MIN_BYTES,
        dest="num_bytes",
        help=f"entropy in bytes before encoding (default {MIN_BYTES}, minimum {MIN_BYTES})",
    )
    args = parser.parse_args(argv)
    # No trailing newline: `$(...)` in the workflow strips one anyway, but
    # writing exactly the value keeps this script's own output byte-for-byte
    # equal to the passphrase, which is what its unit tests assert against.
    sys.stdout.write(mint(args.num_bytes))


if __name__ == "__main__":
    main(sys.argv[1:])
