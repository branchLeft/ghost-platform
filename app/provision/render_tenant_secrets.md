# render_tenant_secrets.py

## Overview

Run on the app host itself, as root, once per tenant onboarded and before that
tenant's `branchleft-compose@<slug>` unit is enabled. It is copied to
`/root/platform-provision/` with the rest of `app/provision/`, beside
`provision_tenant_volume.py` and `tenant-names.json`, which it needs.

```sh
render_tenant_secrets.py --slug=<slug> --template-file=<file> [--etc-dir=/etc/branchleft]
```

The tenant stack holds no secret value. Its `secretsEnvTemplate` output is the
render core's `secrets.env`: key names with empty values. This script fills
that template and writes `/etc/branchleft/<slug>.env`, root-owned, mode `0600`,
which the rendered Compose file reads as an `EnvironmentFile`.

The values are a JSON object of KEY to value on **stdin only**, never an
argument and never the environment of a long-lived process:

```sh
{"GHOST_DB_PASSWORD": "...", "GHOST_OWNER_EMAIL": "..."} | render_tenant_secrets.py ...
```

The caller is the storage controller (ws#1795) through the app-host entry
point (ws#1797); until they exist an operator pipes the values in, as
`RUNBOOK-tenant-onboarding.md` step 8b shows.

## What it refuses

Exit 1 on each, with a message that names keys and never a value:

- a key the template names with no value, and a value for a key it does not
  name (a dropped credential is a mismatch nobody sees);
- an empty value, and any control character in a value: systemd reads an
  `EnvironmentFile` line by line, so a newline adds a variable instead of
  breaking one;
- `GHOST_OWNER_EMAIL` with whitespace or no `@`. The full address shape stays
  the render core's `validateOwnerEmailSecret`; no pattern is copied here;
- a non-string value, a key given twice in the JSON, input that is not a JSON
  object, and input over 64 KiB;
- a template line that is neither a comment nor an empty `KEY=` line, so a
  template that already carries a value is not filled;
- a slug that `validate_slug` in `provision_tenant_volume.py` refuses. The rule
  has one home; this script imports it;
- a symlink or non-regular file at the target, and a file that already exists
  with different content. Rotating a credential is a separate step, so an
  existing file is never overwritten.

Exit 2 is a usage error, including a terminal on stdin. Exit 0 is done.

## The write

1. A fresh temp file in `/etc/branchleft` is created with `O_EXCL` and
   `O_NOFOLLOW`, mode `0600`, so it never exists at a wider mode.
2. `fchown` to `root:root`, `fchmod` to `0600`, write, `fsync`.
3. The temp file is hard-linked to `<slug>.env` and then unlinked. A link, not
   a rename, because it fails if a file or a symlink appeared at the target in
   the meantime instead of replacing it. A refusal at any step leaves no temp
   file.
4. The directory is synced.

A re-run with the same values finds an identical file and changes nothing,
except that it asserts owner and mode through the file's own descriptor, so a
resumed run is safe.

## Output

Stdout is `written` or `unchanged` with the path, mode and owner, then one
`key <NAME>` line per key. Stderr carries refusals. Neither ever carries a
value.

## Residual risk

The values pass through the operator's shell and the SSH session until the
controller exists. That is a hand step the code does not remove; it removes the
copy in stack state and stack outputs.
