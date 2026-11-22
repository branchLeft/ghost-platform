# sweep-tenant-state-secrets.py

## Module overview

Check 2 of the per-tenant state design. It lists the secret names (never values)
of the `production` environment of every generated tenant repository and of
tenant zero, and fails if any lists `HETZNER_S3_ACCESS_KEY_ID` or
`HETZNER_S3_SECRET_ACCESS_KEY`.

- **Generated repositories** are the organisation's repositories whose template
  is `ghost-platform-tenant-template`, plus tenant zero.
- **The count is cross-checked.** It prints how many repositories it read and
  fails (exit 5) if that differs from the tenant register's count, given as
  `--register` (a names register, `kind: tenant` entries) or `--register-count`.
- **The seeded control.** `--control-repo` names a scratch repository whose
  `production` environment holds a secret under the old name. It is read in the
  same run and must be reported by name; if it is not, the sweep is blind and
  fails (exit 3). Remove the seed and rerun without the flag for the plain run.
- **Cannot read is not none found.** A repository whose names cannot be read
  (a permission failure, no `production` environment) is reported as
  `CANNOT READ` with the HTTP status and fails (exit 4). The GitHub App's
  permission to read environment secret names was unknown when this was written;
  the agent token returns HTTP 403, so a sweep run with it reports that.

The lister and the enumerator are injected, so the tests run offline.
Tests: `test_sweep_tenant_state_secrets.py`.
