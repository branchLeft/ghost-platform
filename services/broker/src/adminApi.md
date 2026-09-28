# adminApi.ts

## Why this shape

The design documents that describe reconciliation name the Admin API step
("drive Ghost's Admin API over loopback") without saying what it configures —
that gap is left deliberate in the design text itself, rather than an
omission this module needs to resolve. No design document specifies the
call's content either: the tenant descriptor carries no admin-setup fields
beyond `ownerEmail`, and Ghost's own first-run flow needs more than this
schema states, for example a password.

What this module owns is that `configure()` is called, in order, between
starting the unit and clearing the drain flag, and that a failure here routes
through the same reset-and-retry path every other reconcile failure does.
