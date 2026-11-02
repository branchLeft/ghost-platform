# sync-tenant-name-register.py

## Why this script exists

A tenant name is taken by something else, or by one tenant only, and that was
written five times: the TypeScript tenant component, the render core, the
provisioning workflow, and two Python scripts. Each is checked by code that
runs somewhere different, so they drifted. `registers/tenant-names.json` is now
the only list: `{version, names: [{name, kind, repo?}]}`, where `kind` is
`infrastructure` (refused to every tenant) or `tenant` (taken only by the
repository in `repo`).

The two TypeScript packages are published, and a published package cannot read
a repository file at run time. Their copies are therefore generated: this
script rewrites the block between the BEGIN/END GENERATED markers in
`infra/tenant/naming.ts` and `render-core/src/naming.ts`. The workflow and the
two Python scripts read the register itself, and refuse everything when it
cannot be read.

## Modes

- No argument: rewrite each block. Run it after editing the register and commit
  the result.
- `--check`: rewrite nothing; exit 1 if any block differs from the register.
  CI runs this on every change under `registers/`, `infra/tenant/` and
  `render-core/`.
- `--self-test`: prove `--check` sees a stale block and a hand edit inside one,
  and that the register validator refuses a tenant entry with no repository, a
  duplicate and an infrastructure entry carrying a repository.

Exit 2 is a usage error or an unreadable or invalid register.

## Not covered

The register is written by hand. A tenant created by hand and not yet entered in
it is not refused. A package already released carries the copy it was released
with until the next release. The register is public: customer tenant names must
not be entered until the owner says where they live.
