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

## The metrics volume and the re-run

A fresh provision must create exactly the three volumes, and the metrics
volume must be owned to the tenant's uid at `0755`, beside the content volume
at `0700` and the adapters volume at root `0555`. A tenant provisioned by the
earlier two-volume script is topped up by a re-run: the tests drive it with a
host holding only the first two volumes and assert that exactly one volume is
created and that the content volume, its seed file and the register entry are
unchanged. A host with all three reports "already existed" for each, creates
nothing and changes no ownership. The rendered stack declares the metrics
volume `external`, so a re-run that failed to create it would stop a live
tenant's stack from starting.
