# identity.ts

## Tenant identity

The fields whose change destroys or orphans live tenant data rather than
updating it.

Rename the content volume and the tenant's themes, settings and generated
assets are orphaned on the host under the old name; change the UID and the
tenant loses access to its own `0700` volume; change the database name and
Ghost boots against an empty schema. Rendered here as a plain artefact
rather than a Pulumi output so the same identity a delete guard can diff is
available to a reconciler that never touches Pulumi at all (the broker).

`maxUserConnections` is not carried: it lived on the old component's
`GhostTenantArgs`, not on anything `TenantDescriptor` carries today, and
fabricating a value here would be a config surface this schema does not yet
expose. A consumer that needs it still has `db/provision`'s own default.
