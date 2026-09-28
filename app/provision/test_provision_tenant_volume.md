# test_provision_tenant_volume.py

## Coverage rationale

This script owns the one runtime-isolation control that fails open: without
it every tenant container still starts, on a volume the Ghost image leaves
world-writable. Its refusals — a UID another tenant already holds, a UID
change on a provisioned volume, a reserved slug, an allocation it cannot
establish — are what stand between a mistyped number and one tenant reading
another's content, so they are covered here rather than left to a live host
to discover.

The UID-freeing case has its own tests, in both directions. An earlier form
of this script kept the claim inside the tenant's own `0700` content volume,
where the tenant could unlink it; a missing claim then read as "unclaimed",
and because a missing claim never compares equal to a real UID, a second
tenant was accepted onto the same number. Asserting that the *slug* is not
freed did not catch it — the UID is the thing that has to stay claimed.
