# Tenant passphrase escrow key

`tenant-passphrase-escrow.pub.pem` is the **public** half of the platform
owner's escrow keypair. `provision-tenant.yml` encrypts each newly minted tenant
stack passphrase to it and publishes the ciphertext in the run, because
`branchLeft/ghost-platform` is public and there is no other channel a run can use
to hand a human a secret.

**This directory must never contain a private key.** The repository-wide
committed-secret guard is not a key detector, so the check that matters is the
one in `scripts/escrow-tenant-passphrase.py`: it refuses a file carrying a
`PRIVATE KEY` block outright, and the workflow calls it before it mints anything.

## Generating the keypair — once, by the platform owner

Run on the workstation, not in CI. Nothing about this keypair may exist on a
runner.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out ~/tenant-passphrase-escrow.key
chmod 600 ~/tenant-passphrase-escrow.key
openssl pkey -in ~/tenant-passphrase-escrow.key -pubout \
  -out infra/provisioning/escrow/tenant-passphrase-escrow.pub.pem
```

Then commit the public half, and put the private half in the password manager
and in the off-site archive **before** the first tenant is provisioned. A lost
escrow private key makes every ciphertext this flow ever published useless at
once, which is a strictly worse failure than having no escrow: the flow would
still report success on every run.

## Recovering a tenant's passphrase

The ciphertext is in that tenant's provisioning run — its job summary, and the
`tenant-passphrase-escrow` artifact. Recovery deliberately does not depend on
this repository being reachable or on any script in it:

```bash
base64 -d < escrow.b64 > escrow.bin
openssl pkeyutl -decrypt -inkey ~/tenant-passphrase-escrow.key \
  -pkeyopt rsa_padding_mode:oaep \
  -pkeyopt rsa_oaep_md:sha256 \
  -pkeyopt rsa_mgf1_md:sha256 \
  -in escrow.bin
```

`test_escrow_tenant_passphrase.py` asserts that exact command against a
ciphertext the escrow script produced, so the two cannot drift apart. The hash
options are named on both sides on purpose: `rsa_oaep_md` and `rsa_mgf1_md` are
separate options that default differently across OpenSSL versions, and a decrypt
written from memory later fails with a padding error at the one moment the value
is needed.

## The escrow of record is not this ciphertext

Run logs, job summaries and artifacts are retained for a limited window, so a
ciphertext nobody decrypts expires. The escrow of record is the password
manager. Onboarding is arranged so that this cannot be skipped: the tenant's
secret stack config has to be set with the passphrase before the handover pull
request can merge, so the escrow is exercised on day one rather than first tried
during an incident years later.
