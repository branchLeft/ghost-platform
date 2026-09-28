# store.ts

The shim's storage seam: tenant keys, delivery events, suppressions and the
durable send queue, in one SQLite file reached through Drizzle ORM on the
`better-sqlite3` driver. The driver is synchronous, so every store method and
every transaction is synchronous too.

SQLite is durable across restarts with nothing to provision, which is what a
single host with a persistent disk needs: no cloud database, no separate queue
service. It is not built for multi-instance coordination — a local file is not
shared between hosts — and this service needs none at its single-instance,
single-tenant-credentials scale.

## Opening the file

`createSqliteStore(filename)` opens the file, switches it to write-ahead
logging, then migrates it ([`migrate.ts`](migrate.ts)) before building the
store.

- **The busy timeout (5 seconds) is set when the connection opens**, before any
  statement runs. SQLite's own default is 0 — fail at once on `SQLITE_BUSY` —
  and the `journal_mode = WAL` switch itself takes a lock that another process
  opening the same file (the CLI, run directly against it) can hold at that
  moment. With the timeout already in force, even that first statement waits
  rather than failing.
- **WAL, not SQLite's default rollback journal**: the CLI (`register`, `list`,
  `events`) opens this same file while the service runs, and a
  snapshot-consistent backup must read the file without blocking the service's
  writes. `PRAGMA journal_mode` returns the mode it actually ended up in — it can
  silently fall back, for example on some network filesystems — so the store
  reads it back and refuses to start rather than run every write unprotected
  without saying so. `assertWalEnabled` is exported so that refusal, which a
  real local file never reaches, can be tested directly. `:memory:` databases
  report `memory` and are exempt.
- If the WAL check or the migration throws, the connection is closed before the
  error propagates.

## Schema and migrations

[`schema.ts`](schema.ts) is the current schema. [`drizzle/`](../drizzle) holds
the versioned migrations drizzle-kit writes from it, with a snapshot per
migration in `drizzle/meta/`:

| # | Migration | What it does |
|---|---|---|
| 0 | `0000_pre_drain_baseline` | The schema as a host running the pre-drain release has it: the baseline. Generated. |
| 1 | `0001_drain_handover` | Converts the queue to the drain shape in place. Hand-written; see [the drain-handover migration](#the-drain-handover-migration). |
| 2 | `0002_sender_domain` | Adds `tenants.sender_domain`. Generated. |

To change the schema: edit `schema.ts`, run
`npx drizzle-kit generate --name <what-it-does>` in this package, and commit
the new SQL and its `meta/` files together. `npx drizzle-kit generate` with no
changes pending must report nothing to migrate, and `npx drizzle-kit check`
must pass. A migration is an expand (new tables, new nullable or defaulted
columns) or a contract (removing what nothing reads any more), never both, so
the previous release keeps working against the new schema.

The runner, `migrateStore`, reads the same files and the same ledger table
(`__drizzle_migrations`) as drizzle's own migrator, so drizzle-kit sees one
history. It differs from drizzle's `migrate()` in one way that matters here:
**the whole run is one `IMMEDIATE` transaction** — creating the ledger, reading
it, baselining an old database and applying every pending migration. drizzle's
own migrator reads the ledger before it takes a write lock, so two processes
opening the same file at once can both decide a migration is pending and the
second then fails on the first one's work. Under one `IMMEDIATE` transaction the
second opener waits (up to the busy timeout) and then reads a ledger that
already records everything: it has nothing to do. A failed statement rolls back
the whole run, including the ledger rows; nothing is ever half-applied.

A statement's failure is reported as `Migration <n> failed: <SQLite's reason>`,
with drizzle's own error kept as the cause: drizzle's message on its own names
only the statement, never the reason.

### Databases older than the ledger

A file written before this release has no `__drizzle_migrations` table. When the
ledger is empty but a `tenants` table exists, the runner records every migration
the file's shape already reflects, then applies the rest as usual:

| `queue_recipients` columns | `tenants` has `sender_domain` | Recorded as applied |
|---|---|---|
| pre-drain (`attempts`, `next_attempt_at`) or no table at all | no | 0 |
| drain-shaped (`id`, `drain_count`, `available_at`, `held_until`) | no | 0, 1 |
| drain-shaped | yes | 0, 1, 2 |

For the first row it also creates any baseline table or index the file lacks,
which is what the pre-drain release's own `CREATE TABLE IF NOT EXISTS` did on
every start. Any other shape — a half-renamed queue, a counter column added
twice, `sender_domain` beside a pre-drain queue — matches no release that ever
shipped, so the runner throws `Unrecognised schema …` and changes nothing
rather than guess.

The baseline declares `NOT NULL` on the text primary keys, which the pre-drain
release's own `CREATE TABLE` statements left out. A baselined host keeps its
original table definitions for the tables migration 1 does not rebuild; nothing
reads or writes a null key, so the difference has no effect.

### The drain-handover migration

[`0001_drain_handover.sql`](../drizzle/0001_drain_handover.sql) converts a
pre-drain `queue_recipients` table in place, losing no queued mail. It rebuilds
the table (a new table, a copy, a drop, a rename — the pattern drizzle-kit
itself generates for SQLite), so a migrated table and a freshly created one end
with exactly the same definition, `NOT NULL` on `id` included.

- **`attempts` becomes `drain_count`.** The old column counted delivery
  attempts; the new one counts hand-over generations. Nothing caps or
  interprets `drain_count` beyond the generation check in `ackDrain`, so a row
  with `attempts = 3` is simply drained next at generation 4.
- **`next_attempt_at` becomes `available_at`**: in both models, "not claimable
  before this time". A row already in backoff keeps its delay — at worst the
  old retry ladder's top rung — and no mail is lost.
- **`last_error`** is kept as it was.
- **`status`** strings (`pending`, `sent`, `failed`, `suppressed`) mean the same
  in both models. The new model adds `held`, but no old row is ever `held` —
  the old worker never left one mid-lease — so no status is rewritten. A
  migrated terminal row stays exactly as terminal as it was, kept as history the
  same way a new row is (`cleanupCompletedBatches` removes it once its batch is
  old enough), and a migrated `pending` row becomes drainable through
  `claimForDrain` like a freshly enqueued one. Nothing is dropped, and nothing
  already sent can be re-offered.
- **`id` is new**: the old table had no stable drain-facing identity. Every row
  gets a random version-4 UUID, the same shape `enqueueBatch` gives a new row,
  generated in SQL (`randomblob`) because a migration file cannot call
  JavaScript. The copy keeps the old `rowid` order, which is the claim order
  within a batch.
- The old `(status, next_attempt_at)` index goes with the old table; the three
  indexes the drain protocol uses are created on the new one.

**One way only, and never beside an old process.** An old-release process with
the file open never runs this migration, so it cannot be the waiting second
opener described above: once any new-release process migrates the file under
it, every one of its own statements names `attempts` or `next_attempt_at` and
fails for as long as it runs — its enqueue with `no such column: attempts`, its
worker's claim likewise. The old release also cannot reopen a migrated file (it
fails at startup on its own `next_attempt_at` index). So the old process is
stopped before the first new-release open, and the file (with any `-wal` and
`-shm` beside it) is copied aside first; rolling back means restoring that copy
together with the old image. The redeploy runbook sequences stop, backup,
migrate, start.

## Sender domain

`Tenant.senderDomain` is the domain a tenant sends From. It is held apart from
`domain`, the credential's lookup key, because the two need not be equal: tenant
zero's credential key is its Mailgun `bulkEmailDomain`
(`blog.branchleft.co.uk`), while its newsletters go out From the apex
(`branchleft.co.uk`).

- It is `null` for a tenant that predates the field (every row the
  sender-domain migration adds the column to) or was never given one. Callers
  fail closed on `null` and never fall back to `domain`.
- The migration adds the column with every existing row `NULL`, never a guessed
  default such as the credential key: a migrated tenant fails closed until an
  operator sets its real sending domain (`setSenderDomain`, the CLI's
  `set-sender-domain`), never silently bound to a value nobody confirmed.
- `registerTenant` requires it and never defaults it from `domain`: a caller
  that has only the credential key must decide explicitly, which is why the
  CLI's `register` refuses to run without `--sender-domain`
  ([`cli.ts`](cli.ts)). Passing `null` is only for a test reproducing a
  pre-migration row.
- `setSenderDomain` is the operator path for a tenant that already exists: it
  sets the sending domain without re-registering, which would rotate the
  tenant's credential out from under it. It returns `false` when the domain is
  not a registered tenant, and `true` for a registered one even when the value
  is unchanged.
- `listTenants` returns each domain with its sender domain, because an operator
  checking whether the sender-domain control is live for a tenant (the
  shim-upgrade runbook's post-redeploy check) needs both: a bare list of
  credential domains shows a tenant with no sender domain identically to a
  fully configured one.

`verifyTenant` looks the tenant up by the domain always present in the URL path
and checks the presented key against that tenant's salted hash. It collapses
"unknown domain" and "wrong key for a domain that exists" into one check,
because both get the same 401 (`requireTenantForDomain` in
[`auth.ts`](auth.ts)).

## Suppressions

`SuppressionType` is compile-time only. The suppressions route filters to known
types before it reaches the store ([`routes/suppressions.ts`](routes/suppressions.ts)),
but that guard does not cover other callers, and a mistyped type stored under a
real-looking value would silently never match a real `isSuppressed` lookup
rather than fail loudly. So every suppression method checks the type first.

## Events

`listEvents` does not reimplement mailgun.js's search syntax
(`event: 'delivered OR opened OR ...'`). Ghost only ever sends an OR-list of
exact type names (its `email-analytics-provider-mailgun`), so a list match
covers every real caller without a query-language parser. The match is applied
to the page after `limit` and `offset` cut it, and `nextOffset` advances by the
unfiltered page, so a page can hold fewer matches than `limit` while later pages
still hold more.

## Claiming for drain

`claimForDrain` atomically claims up to `limit` recipients for hand-over: every
`pending` row whose `available_at` has come, plus every `held` row whose lease
has lapsed (`held_until` has come), re-offered under its original id — nothing
mints a new one. Candidates come oldest batch first and, within a batch (or
between batches enqueued at the same moment), in enqueue order: SQLite's
`rowid`, the one ordering key the schema does not otherwise carry.

- A suppressed recipient (any of the three types, for that domain) is resolved
  in place — recorded, excluded, no event — rather than ever handed to a
  drainer. An unsafe address is failed in place the same way, and a `failed`
  event is recorded for it so Ghost's own events polling learns of it: the
  deleted outbound worker recorded a `failed` event for every terminal failure
  it produced, and an unsafe address is a terminal failure produced here now.
  Both still count toward `limit`, so a caller wanting more calls again rather
  than assume it always gets `limit` drainable rows.
- `canSend` gates the hourly throttle: one bucket per shim process, shared by
  every tenant that process holds — the deleted worker's own `tryTake()` check
  immediately before dispatch ([`throttle.ts`](throttle.ts)). It is asked once
  per row that would otherwise become `held`, in claim order; the first `false`
  stops the whole claim rather than skipping that row, so a throttled candidate
  and every candidate after it stay as they were for the next call, never
  reordered around the one that was throttled. A re-offer candidate that loses
  the throttle keeps its original `held_until` — and so its current generation,
  which can still ack — rather than being pushed further out by an unrelated
  rate limit. Suppressed and unsafe rows are resolved regardless of the
  throttle: they were never going to consume a send. Omitting `canSend` means
  unthrottled.
- A claimed row becomes `held` with `drain_count` incremented and
  `held_until = now + leaseSeconds`. Being handed out again is not itself an
  error; only an unacked row left forever would be.
- A batch is stamped complete, with the caller's `now`, the moment its last
  recipient reaches a terminal state, and only once.

## Acks name a generation

An ack names the id and the claim generation — the `drainCount` the drainer was
handed alongside that id. An id alone cannot tell "the drainer holding this row
now" from "a drainer whose lease lapsed and whose row was re-offered to someone
else": the id never changes across a re-offer, only `drain_count` does.

`ackDrain` moves a `held` id at the same generation the ack names to `sent`,
where this store's job for that message ends. A duplicate ack (already `sent`)
is reported as `alreadyHandled` rather than an error — the drainer may refuse a
duplicate. Anything else is reported as `unknown` for the caller to decide
about, never silently swallowed: an id this store has no record of; one that
lapsed and was reclaimed (`pending` again), or was resolved `failed` or
`suppressed` on a later claim; or one still `held` but at a newer generation.

The generation check is load-bearing. An id is stable across a re-offer — the
row stays `held`, with a new `held_until` and an incremented `drain_count` — so
without the check a late ack from the drainer that held it before the re-offer
would still find it `held` and be accepted, crediting an outdated claim and
discarding the mail the new holder is responsible for while the old holder
wrongly believes it done. What "held" means here is the generation the ack was
issued against, not just the id.

`ackDrain` deliberately records no "delivered" event: an ack means the drainer
took responsibility for the message, not that anyone received it. That
distinction is why the old worker's premature "delivered" event was a defect,
and synthesizing one here would be the same defect one hop later.

## Queue metrics

`oldestUndrainedAgeSeconds` is the time since the oldest recipient still owed a
hand-over (`pending` or `held`) was enqueued, or `null` when none is. `held`
counts as outstanding on purpose: a drainer that keeps polling but never acks
must show here as a growing number, exactly like one that stopped calling at
all. `countUndrainedRecipients` counts the same two states across every batch
and domain.

`cleanupCompletedBatches(olderThan)` deletes batches completed strictly before
`olderThan`, with their recipients, and returns how many batches it deleted. A
batch with any recipient outstanding is never deleted however old it is, and
the events table is never touched.

## Database-specific code

Three things in this module are specific to SQLite, each because Drizzle has no
portable form for it:

- the migration ledger's `CREATE TABLE`, copied from drizzle's own migrator so
  the ledger stays drizzle's;
- ordering claim candidates by `rowid`;
- the driver's `pragma()` calls: switching to WAL, and reading a pre-ledger
  table's columns to baseline it.

The hand-written drain-handover migration is the fourth.
