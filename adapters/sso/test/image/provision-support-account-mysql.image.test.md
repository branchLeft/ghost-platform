# provision-support-account-mysql.image.test.mjs

## Why this test exists

The mysql2 half of `provision-support-account.mjs`'s own proof: an earlier
review found the fix "portable across both database backends" was proven
only against sqlite, the one backend `render-core/src/descriptor.ts`'s own
doc comment calls demo-only — and demo tenants never carry break-glass at
all (`breakGlass.kind` is forced to `disabled` for a demo). This drives the
same script against a real MySQL 8 server and a real Ghost 6.55.0 booted
with `database__client: 'mysql'`, the backend every paying tenant actually
runs.

## Usage

```sh
IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
```
