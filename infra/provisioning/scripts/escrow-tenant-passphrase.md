# escrow-tenant-passphrase.py

## Module overview

Prints one base64 line: the passphrase under RSA-OAEP/SHA-256 to the platform
owner's escrow public key. Nothing else reaches stdout, so the caller captures
it with plain command substitution.

**Why a ciphertext rather than a secret channel.** A machine-minted passphrase
whose only copy is a GitHub Actions secret is unrecoverable the moment that
secret is deleted, rotated, or lost with its repository — and a Pulumi stack
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
so that the passphrase has to be decrypted and used on day one — the tenant's
secret stack config cannot be set without it. An escrow first exercised years
later, during an incident, is not an escrow.

**It fails closed, and the ordering is what makes that mean anything.** The
caller runs `--self-test` and `--check-key` **before it creates anything**, and
only writes the tenant repository's `PULUMI_CONFIG_PASSPHRASE` secret after the
ciphertext exists. `--check-key` is why the second of those is a separate mode:
every substantive check on the committed key lives in `validate_public_key()`,
which the encrypt path reaches only once there is a passphrase to encrypt —
several steps after `gh repo create`. Without it, a 2048-bit key, an EC key or
the private half committed by mistake is caught only after a public repository
named `ghost-tenant-<slug>` exists, and on this estate the existence of that
repository is itself the disclosure that the tenant is a customer.
