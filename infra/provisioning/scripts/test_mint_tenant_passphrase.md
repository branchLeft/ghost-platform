# test_mint_tenant_passphrase.py

## Module overview

This script's output becomes a tenant's `PULUMI_CONFIG_PASSPHRASE` — the only
thing standing between that tenant's stack and permanent unavailability once
GCP KMS is gone. These tests check the properties that matter for that: the
generator is the CSPRNG one and not the predictable one, the entropy floor is
enforced rather than merely documented, two mints never collide in a sample
large enough to make a collision meaningful, and the value on stdout is
exactly the passphrase — no newline, no label, nothing a naive `$(...)`
capture in the workflow could get wrong.
