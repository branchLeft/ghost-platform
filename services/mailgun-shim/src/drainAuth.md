# drainAuth.ts

## requireDrainToken

The drain endpoint's only credential (LLD-6: "the drain endpoint hands
out mail, so it needs authentication"). A single shared bearer token
rather than the per-tenant scheme auth.ts uses for Ghost's Mailgun-shaped
calls: the drainer is not a tenant, it is the one caller this host ever
expects to reach in (mx1, or a test collector standing in for it), so
one credential naming that one relationship is the whole of what needs
proving — see docker-compose.drain-proof.yml for the network-level half
of this (no route off the host at all, so a stolen token still has
nothing reachable to replay against except this one service).
