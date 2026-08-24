#!/usr/bin/env python3
"""Encrypt a minted tenant passphrase to the escrow key, for a public log.

    escrow-tenant-passphrase.py --public-key <pem>   # passphrase on stdin
    escrow-tenant-passphrase.py --check-key <pem>    # validate only, no input
    escrow-tenant-passphrase.py --self-test

Prints one base64 line: the passphrase under RSA-OAEP/SHA-256 to the platform
owner's escrow public key. Nothing else reaches stdout, so the caller captures
it with plain command substitution.

**Why a ciphertext rather than a secret channel.** A machine-minted passphrase
whose only copy is a GitHub Actions secret is unrecoverable the moment that
secret is deleted, rotated, or lost with its repository -- and a Pulumi stack
whose passphrase is gone cannot even be `pulumi destroy`ed, because destroy
reads a checkpoint it can no longer decrypt. So there has to be a second,
human-reachable copy. `branchLeft/ghost-platform` is public, which rules out
printing the value: anything a run writes to its log or its job summary is
visible to anyone on the internet. A ciphertext is not, and publishing one is
what public-key encryption is for.

**What is escrowed where.** The base64 below is a *transport*, not the escrow of
record: run logs and job summaries are retained for a limited window, so a
ciphertext nobody ever decrypts expires. The escrow of record is the platform
owner's password manager, and the onboarding sequence is deliberately arranged
so that the passphrase has to be decrypted and used on day one -- the tenant's
secret stack config cannot be set without it. An escrow first exercised years
later, during an incident, is not an escrow.

**It fails closed, and the ordering is what makes that mean anything.** The
caller runs `--self-test` and `--check-key` **before it creates anything**, and
only writes the tenant repository's `PULUMI_CONFIG_PASSPHRASE` secret after the
ciphertext exists. `--check-key` is why the second of those is a separate mode:
every substantive check on the committed key lives in `validate_public_key()`,
which the encrypt path reaches only once there is a passphrase to encrypt --
several steps after `gh repo create`. Without it, a 2048-bit key, an EC key or
the private half committed by mistake is caught only after a public repository
named `ghost-tenant-<slug>` exists, and on this estate the existence of that
repository is itself the disclosure that the tenant is a customer.

Exit 0 on success, 1 on any refusal, 2 on usage error.
"""

from __future__ import annotations

import argparse
import base64
import os
import pathlib
import re
import subprocess
import sys
import tempfile

OPENSSL = "openssl"

# RSA-2048 is not refused because it is broken; it is refused because this key
# is a long-lived recovery credential for every tenant on the platform and there
# is no cost to the larger one. The generation command in the runbook produces
# 4096.
MIN_KEY_BITS = 3072

# SHA-256, so OAEP costs 2*32 + 2 bytes of the modulus. A 4096-bit key carries
# 446 bytes of plaintext; a minted passphrase is 43.
OAEP_HASH_OVERHEAD = 2 * 32 + 2

PUBLIC_KEY_HEADER = "-----BEGIN PUBLIC KEY-----"


class EscrowError(Exception):
    """Raised for anything a caller could have avoided, or that openssl refused."""


def _openssl(args: list[str], stdin: bytes | None = None) -> bytes:
    try:
        result = subprocess.run(
            [OPENSSL, *args], input=stdin, capture_output=True, check=False
        )
    except OSError as exc:  # openssl absent from the runner image
        raise EscrowError(f"could not run {OPENSSL}: {exc}") from exc
    if result.returncode != 0:
        raise EscrowError(
            f"openssl {args[0]} exited {result.returncode}: "
            f"{result.stderr.decode('utf-8', 'replace').strip()}"
        )
    return result.stdout


def key_bits(public_key: pathlib.Path) -> int:
    """Modulus size of an RSA public key, refusing anything that is not one."""
    text = _openssl(["pkey", "-pubin", "-in", str(public_key), "-noout", "-text"]).decode(
        "utf-8", "replace"
    )
    if "Public-Key:" not in text:
        raise EscrowError(f"{public_key} does not parse as a public key")
    match = re.search(r"Public-Key:\s*\((\d+) bit\)", text)
    if not match:
        raise EscrowError(f"could not read the key size of {public_key}")
    # An EC or Ed25519 key parses and reports a size too, and `pkeyutl -encrypt`
    # against one fails with a message about the operation rather than the key.
    # Named here so the refusal points at the file.
    if "rsaEncryption" not in text and "RSA Public-Key" not in text and "Modulus" not in text:
        raise EscrowError(
            f"{public_key} is not an RSA key. The escrow key is RSA because "
            "`openssl pkeyutl -encrypt` cannot encrypt to an EC or Ed25519 key at all."
        )
    return int(match.group(1))


def validate_public_key(public_key: pathlib.Path) -> int:
    if not public_key.is_file():
        raise EscrowError(
            f"the escrow public key {public_key} is missing. Provisioning refuses to mint a "
            "passphrase it cannot escrow: a value held only as a GitHub Actions secret cannot "
            "be read back, and a stack whose passphrase is lost cannot be destroyed either. "
            "Generate the keypair per the tenant-onboarding runbook and commit the public half."
        )
    text = public_key.read_text(encoding="utf-8", errors="replace")
    if PUBLIC_KEY_HEADER not in text:
        raise EscrowError(
            f"{public_key} does not look like a PEM public key. If this is the PRIVATE half, "
            "stop: it must never be committed, and it must never reach a runner."
        )
    if "PRIVATE KEY" in text:
        raise EscrowError(
            f"{public_key} contains a PRIVATE KEY block. Refusing outright -- the escrow "
            "private key belongs in the platform owner's password manager and nowhere else."
        )
    bits = key_bits(public_key)
    if bits < MIN_KEY_BITS:
        raise EscrowError(
            f"the escrow key is {bits} bits; the minimum is {MIN_KEY_BITS}. It is a long-lived "
            "recovery credential for every tenant on the platform."
        )
    return bits


def check_key(public_key: pathlib.Path) -> str:
    """Validate the escrow key with no passphrase in hand. Returns a report line."""
    bits = validate_public_key(public_key)
    capacity = bits // 8 - OAEP_HASH_OVERHEAD
    return f"escrow key OK: RSA-{bits}, {capacity} bytes of RSA-OAEP capacity"


def escrow(passphrase: str, public_key: pathlib.Path) -> str:
    if not passphrase:
        raise EscrowError("refusing to escrow an empty passphrase")
    bits = validate_public_key(public_key)
    capacity = bits // 8 - OAEP_HASH_OVERHEAD
    plaintext = passphrase.encode("utf-8")
    if len(plaintext) > capacity:
        raise EscrowError(
            f"the passphrase is {len(plaintext)} bytes and this key carries {capacity} under "
            "RSA-OAEP. Refusing rather than chunking: a multi-block escrow is a format nobody "
            "will remember how to reverse."
        )
    ciphertext = _openssl(
        [
            "pkeyutl",
            "-encrypt",
            "-pubin",
            "-inkey",
            str(public_key),
            "-pkeyopt",
            "rsa_padding_mode:oaep",
            "-pkeyopt",
            "rsa_oaep_md:sha256",
            "-pkeyopt",
            "rsa_mgf1_md:sha256",
        ],
        stdin=plaintext,
    )
    if len(ciphertext) != bits // 8:
        raise EscrowError(
            f"openssl produced {len(ciphertext)} bytes for a {bits}-bit key; expected "
            f"{bits // 8}. Refusing to publish a ciphertext this cannot account for."
        )
    return base64.b64encode(ciphertext).decode("ascii")


def decrypt(ciphertext_b64: str, private_key: pathlib.Path) -> str:
    """The recovery direction. Used by `--self-test`; the runbook gives the
    equivalent one-liner, because recovery must not depend on this repository
    being reachable."""
    plaintext = _openssl(
        [
            "pkeyutl",
            "-decrypt",
            "-inkey",
            str(private_key),
            "-pkeyopt",
            "rsa_padding_mode:oaep",
            "-pkeyopt",
            "rsa_oaep_md:sha256",
            "-pkeyopt",
            "rsa_mgf1_md:sha256",
        ],
        stdin=base64.b64decode(ciphertext_b64, validate=True),
    )
    return plaintext.decode("utf-8")


def self_test() -> None:
    """Prove the exact option strings above round-trip, on this runner.

    Not a formality. `rsa_oaep_md` and `rsa_mgf1_md` are separate options and
    default differently across OpenSSL versions, so an encrypt that succeeds
    here and a decrypt written from memory later can disagree about the hash and
    fail with a padding error -- at the one moment the value is needed. The
    keypair is ephemeral and never leaves the temporary directory.
    """
    with tempfile.TemporaryDirectory() as tmp:
        private = pathlib.Path(tmp) / "private.pem"
        public = pathlib.Path(tmp) / "public.pem"
        _openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072",
                  "-out", str(private)])
        os.chmod(private, 0o600)
        _openssl(["pkey", "-in", str(private), "-pubout", "-out", str(public)])
        secret = "self-test-" + base64.urlsafe_b64encode(os.urandom(24)).decode("ascii")
        recovered = decrypt(escrow(secret, public), private)
        if recovered != secret:
            raise EscrowError("escrow round-trip did not recover the input")

        # The refusals, exercised rather than asserted in prose.
        for bad, why in (
            (pathlib.Path(tmp) / "absent.pem", "a missing key"),
            (private, "the private half"),
        ):
            for entry, name in ((escrow, "escrow"), (lambda k: check_key(k), "check_key")):
                try:
                    entry(secret, bad) if name == "escrow" else entry(bad)
                except EscrowError:
                    continue
                raise EscrowError(f"{name} accepted {why}")
    print("escrow-tenant-passphrase.py self-test passed")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--public-key", type=pathlib.Path)
    parser.add_argument(
        "--check-key",
        type=pathlib.Path,
        help="validate the escrow public key and exit; reads no passphrase",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.self_test:
            if args.public_key is not None or args.check_key is not None:
                raise EscrowError("--self-test takes no --public-key and no --check-key")
            self_test()
            return 0
        if args.check_key is not None:
            if args.public_key is not None:
                raise EscrowError("--check-key and --public-key are alternatives")
            print(check_key(args.check_key))
            return 0
        if args.public_key is None:
            raise EscrowError("--public-key is required unless --self-test is given")
        # Validated before stdin is read, not after. Reading first means an
        # unusable key is reported only once a passphrase has been handed over
        # -- and when stdin is a terminal rather than a pipe it means blocking
        # forever instead of failing, which is how this surfaced.
        validate_public_key(args.public_key)
        passphrase = sys.stdin.read().strip("\n")
        # No trailing newline: the caller writes this into a job summary and an
        # artifact, and a stray one is a base64 line that no longer decodes as a
        # single value everywhere it is pasted.
        sys.stdout.write(escrow(passphrase, args.public_key))
    except EscrowError as exc:
        print(f"::error::escrow-tenant-passphrase: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
