# break-glass-mint.mjs

## Overview

Mints the token the break-glass adapter verifies (`../README.md`, "Token"),
signed with the one Ed25519 private key in the estate. It is LLD-5's
`mint(tenant, reason, ttl)`: `ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html`, section 05.

It runs on `ops1` and nowhere else. Only the owner runs it, because the key
directory `/etc/branchleft/break-glass/` is on the agents' never-list. The
host steps are in `ghost-platform-docs`, `break-glass-runbook.md`.

The script uses Node built-ins only, so it needs no install. On `ops1` it runs
in the pinned Node image the repo already uses
(`node:26.5.0-bookworm-slim@sha256:2d49d876…`, as in
`services/drain-sidecar/Dockerfile`). The container has no network, and the
key directory is mounted read-only.

## Commands

```sh
node break-glass-mint.mjs keygen
node break-glass-mint.mjs public-key
node break-glass-mint.mjs mint --tenant <slug> --identity <support email> \
  --reason <one line> [--ttl <seconds, 1-600, default 300>] [--site https://<host>]
```

- `keygen` creates `/etc/branchleft/break-glass/signing-key.pem`, mode 0600.
  It refuses if the file exists, because a key is rotated, never replaced in
  place. It prints the public half (base64 SPKI DER, the form a tenant's
  `breakGlass.publicKey` takes) and a 16-hex fingerprint.
- `public-key` prints the same two lines for the existing key.
- `mint` prints one line. Without `--site` that line is the token, two
  base64url parts joined by a dot, the second 86 characters. With `--site`
  it is the full `/ghost/` URL.

## Refusals, and why each exists

Each refusal exits 2 with a `refused:` line and mints nothing.

| Refusal | Why |
|---|---|
| `--ttl` above 600 | The adapter caps at 900 seconds from `iat` and allows 60 seconds of forward skew. A token minted near that cap is refused whenever the `ops1` clock runs ahead (adapter review, requirement 4). |
| `--site` with a path, query, login or `http:` | The adapter is mounted on `/ghost/` only. A token sent anywhere else is logged by Ghost but never consumed, so it stays usable until it expires (requirement 3). The only URL this script builds is `<origin>/ghost/?bl_break_glass=…`. |
| A key file readable by group or others | The key opens an Administrator session on every tenant. |
| A key that is not Ed25519, or a file that is not a key | The adapter verifies Ed25519 only. |
| The audit record cannot be written | A token never exists without its record (below). |

The key path is a constant, not a flag. The registry's never-list row names
that exact directory, so the code reads nothing else.

## The audit record

Each mint appends one JSON line to `/var/log/branchleft/break-glass-mint.jsonl`
(mode 0600) before the token is printed. The line holds `tenant`, `identity`,
`reason`, `jti`, `iat`, `exp` and the key's fingerprint, and never the token.
The `jti` ties a mint to the tenant's own Ghost log and sessions table.

## What a token is good for

A token opens a session only while the support account is active, and
suspension is set by a grant lane (`break-glass-grant.md`). The token is
single-use, lasts at most 600 seconds, and dies when the tenant's Ghost
restarts (requirement 5): mint again after a restart.
