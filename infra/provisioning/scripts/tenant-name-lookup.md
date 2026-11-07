# tenant-name-lookup.js

## Module overview

Asks the control plane whether one tenant name is already taken, so that
`provision-tenant.yml` can refuse a duplicate before it creates a repository.

Customer tenant names are not in this repository: they live in the control
plane's database. `registers/tenant-names.json` is public and keeps only tenant zero and
the infrastructure names, so it cannot say whether a customer name is taken. This
script is the half that can.

It runs inside the "Validate inputs" step, immediately after the register check
and before anything is created. It has no flags and no file input. It reads three
environment variables:

| Variable | Source | Meaning |
|---|---|---|
| `TENANT` | the workflow's job `env` | the name being checked |
| `CONTROL_PLANE_NAME_LOOKUP_URL` | repository variable | the https origin (and optional path prefix) of the lookup |
| `CONTROL_PLANE_NAME_LOOKUP_TOKEN` | environment secret, `tenant-provisioning` | a read-only bearer credential |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the control plane says the name is free |
| 1 | the control plane says the name is taken |
| 2 | anything else: the run is refused |

It fails closed. Code 2 covers an unset variable, a name that is not a plain
slug (`../x`), a URL that is not https (plain http is accepted for a loopback
host only, so tests can run a fake), credentials, a query or a fragment in the
URL, a redirect, a 401, 403, 404 or 5xx, a timeout, a body over 1 KiB, a body
that is not JSON, and any JSON whose `taken` is not a boolean. Until the control
plane serves this contract and the credential exists, every dispatch is refused.
That is the intended posture, the same as a missing register.

The name is validated here only as a URL-safe key. The slug rule itself is the
workflow's own regex, which runs first in the same step.

## The contract the control plane must serve

One request, nothing else:

```
GET {CONTROL_PLANE_NAME_LOOKUP_URL}/tenant-names/{name}
Authorization: Bearer {CONTROL_PLANE_NAME_LOOKUP_TOKEN}
```

The only accepted answer is HTTP 200 with a JSON object `{"taken": true}` or
`{"taken": false}`. Other fields are ignored and never printed.

The credential must be able to do this and nothing more: no list, no write, no
other path. A list endpoint is refused by design. A per-name boolean means no
customer name is ever pulled into a runner's memory or log.

## What it never does

- print the token or any part of the response body
- write a file, or write to the register
- send more than one request, or follow a redirect (a redirect would carry the
  bearer token to wherever it points)
- ask for a list

## Not covered

- The control plane does not serve this yet. `portal.tenant_register` holds no
  name column and no lookup endpoint exists. That server side is a separate item.
- Nothing records a name at tenant creation yet, because that needs a write
  credential, a separate boundary. Until it exists the lookup answers "free" for
  every real name, so a tenant created by hand is still not refused.
- `GhostTenant` and `render-core` still check tenant zero and the infrastructure
  names only. A published package cannot query the control plane.
- The template's generation script reads the repo register only, and should ask
  the same check.

## Creating the credential (owner)

```
read -rs CONTROL_PLANE_NAME_LOOKUP_TOKEN
gh secret set CONTROL_PLANE_NAME_LOOKUP_TOKEN --repo branchLeft/ghost-platform --env tenant-provisioning
gh variable set CONTROL_PLANE_NAME_LOOKUP_URL --repo branchLeft/ghost-platform
```

The secret is an environment secret, never a repository secret:
`assert-tenant-provisioning-scoping.py` refuses a repository-level copy.
