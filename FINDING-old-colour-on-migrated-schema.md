# branchLeft/workspace#1249 — does the old colour keep serving on a schema the new one migrated?

Measured 2026-09-27 against real containers: `ghost:6.55.0-alpine` (blue) and
`ghost:6-alpine` (green, resolved to `6.65.0` at pull time — Docker Hub's
current tip of the real first bump range the issue names), on `mysql:8.0.46`
and on SQLite. Reproducible with `scripts/measure-1249-schema-drift.sh
<mysql|sqlite>`. Every container, network and temp file the script creates is
torn down at exit, including on failure.

## What was measured

One database (MySQL) or one shared SQLite file, two real Ghost containers.
Blue boots first, serves the prescribed smoke suite, is never restarted.
Green then boots against the *same* data and runs its own real migrations
(6.56 through 6.65 — ten minors of Ghost's own shipped migration files,
unmodified). Blue is checked again afterwards, still running, still
unrestarted — this is the "drained but serving" window U3b/U7 describe.

## Result 1 — the prescribed smoke suite (owner session, publish, render, member creation)

**Passes, on both engines, before and after green's migration.** Full
transcripts: the script's own stdout. Blue's pre-existing admin session
(opened before green ever ran) still authenticates after the migration;
publish, render (with an absent-marker control) and member creation all
still return the expected codes and content. On SQLite specifically, this
extends U4 (LLD-3 04-version-and-upgrades.html) — U4's spike never actually
ran a migrating green concurrently with a serving blue on one SQLite file;
this one does, across a real ten-minor contracting range, with no
`SQLITE_BUSY` observed.

*Caveat recorded honestly:* the smoke suite's "member sign-in" was
implemented as member creation plus a magic-link *request* through the real
public Members API (`POST /members/api/send-magic-link/`); actual mail
delivery was not exercised (no mail provider was wired up for this spike,
and building one was out of scope for a measurement about schema
compatibility). The request itself does not error on either engine, before
or after migration.

## Result 2 — the load-bearing mechanism the smoke suite does not reach

Source inspection (`ghost/core/core/server/services/email-service/
batch-sending-service.js:612-614`, the exact file and mechanism LLD-3's U5
cites) shows blue's own code, on every successful bulk-email send, does:

```
await batch.save({
    status: 'submitted',
    provider_id: response.id,
    ...
```

The real migration `6.58/2026-08-11-21-22-48-rename-email-batches-
provider-id.js`, shipped inside `ghost:6-alpine` and applied by green during
this measurement, renames `email_batches.provider_id` to
`mailgun_message_id`. Confirmed live, on both engines, after green's
migration:

```
columns on email_batches after green's migration (MySQL):
  ... fallback_sending_domain, mailgun_message_id, member_segment, status ...
columns on email_batches after green's migration (SQLite, PRAGMA table_info):
  2|mailgun_message_id|varchar(255)|0||0
```

Reproducing blue's exact write against its own, real, migrated MySQL
database (a synthetic `emails`/`email_batches` row was inserted directly,
since driving delivery through Ghost's Mailgun-only bulk-email path needed a
live provider this spike did not wire up — the write under test is
identical either way):

```
UPDATE email_batches SET status='submitted', provider_id='...' WHERE id='...';
ERROR 1054 (42S22) at line 1: Unknown column 'provider_id' in 'field list'
```

**Control case**, the identical write against a second, standalone,
never-migrated `ghost:6.55.0-alpine` on its own fresh database — proving the
probe is sensitive and the failure above is caused by the schema move, not
by the reproduction method:

```
UPDATE email_batches SET status='submitted', provider_id='...' WHERE id='...';
(no error)
resulting row: <id>  submitted  i1249-synthetic-message-id
```

## The finding

**U7's "keeps serving correctly throughout" holds for the four smoke-suite
checks Done means names, across the real first bump (6.55.0 → 6.65.0, ten
minors), on both MySQL 8.0.46 and SQLite. It does not hold unconditionally
across the range**: the same range contains a real, shipped, contracting
migration (a column rename, not a drop, but blue's code has no more
knowledge of the new name than it would of a dropped column) against a
table blue's own core mail-sending code writes to on every successful send.
The break is real, reproduced against the real migrated schema, and paired
against a control that shows the identical write succeeding when the
schema hasn't moved. It sits entirely outside the four checks the smoke
suite runs, so a green smoke suite does **not** mean the drained colour is
safe against every code path for the whole bake window — only against the
paths that suite exercises. Whether the register of what the gate set
checks needs to grow to cover the bulk-mail path, or whether the design
should route any release containing a rename/drop against a table on the
mail-send path the way it already routes irreversible migrations, is the
owner's call per the issue's open question — this measurement changes the
answer to "no, not unconditionally," which the issue asked for.

## Dated note for LLD-4 (ghost-platform-docs, out of this worktree's scope)

This worktree and PR are confined to `branchLeft/ghost-platform`; the design
doc lives in the private `ghost-platform-docs` repo, which this session has
no access to edit. The following is text to apply there, under LLD-4 §08
near U7 (`04-version-and-upgrades.html`) — dated and headed per that repo's
own convention when it is applied, not here:

> U7's "the old colour stays drained for the whole bake window ... keeps
> rollback a flag change" was tested against the real first bump range,
> 6.55.0 → 6.65.0 (ten minors), on real MySQL 8.0.46 and SQLite containers.
> The prescribed smoke suite (owner session, publish, render, member
> sign-in) passes on blue throughout, on both engines — U7 holds for that
> coverage. It does not hold unconditionally: the range ships a real
> migration (`6.58/…-rename-email-batches-provider-id.js`) renaming
> `email_batches.provider_id`, a column `batch-sending-service.js:612-614`
> (U5's own batch-claim mechanism) writes on every successful send. The
> write was reproduced failing against the real migrated schema
> (`ERROR 1054: Unknown column 'provider_id'`) and, paired as a control,
> succeeding against an identical unmigrated database. No smoke-suite check
> reaches this path. **Open question for the owner, unresolved by this
> measurement:** does the gate set need a check on the mail-send path, or
> does a rename/drop touching a mail-send table route like an irreversible
> migration? Script: `ghost-platform/scripts/measure-1249-schema-drift.sh`.
