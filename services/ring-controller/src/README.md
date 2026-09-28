# src

Narrative moved out of long comment blocks in this directory's source
files, each of which leaves a one- or two-line pointer back here. See
`../README.md` for the module-level design.

## applyLock.ts

Enforces "bumps within a ring are serial, so at most one tenant is ever
in `applying`" (LLD-4 §04, load-bearing) as a structural guard beneath
the ring's own serial iteration -- so a scheduling bug that fired two
bumps at once still could not put two tenants in the uninterruptible
migration step together.

Same queued-promise shape as services/broker's own `asyncMutex.ts`:
every `run` call chains onto whichever call is already in flight, and
the tail is reset to a settled (never-rejecting) promise so one
caller's failure can never wedge the queue for callers behind it,
while still propagating to *that* caller.

## atomicFile.ts

`writeFileAtomic` writes `content` to `path` by writing a temp file in
the same directory, fsyncing it, renaming it into place, then fsyncing
the directory. `rename` within one filesystem is atomic, so a reader
(a restarted controller recovering this same tenant) never observes a
partially-written file -- either the old content or the new content,
never a mix. The directory fsync matters as much as the file's:
without it, a crash can persist the rename in the page cache but lose
it on disk, so a recovering process reads the state from *before* the
write that supposedly already happened -- exactly the gap this exists
to close for a tenant crashing mid-`applying`.

Same shape as services/broker's own atomic-write helper (not imported
across the service boundary -- each service is its own package, so
this is the same well-understood pattern re-derived locally, not a
second design).

## processLock.ts

The single-process assumption is a settled design decision, and it
makes the in-process `ApplyLock` sufficient -- but only for as long as
exactly one controller process exists. `ProcessLockHeldError` and
`acquireProcessLock` are the structural half of that invariant, held
by a single kernel primitive rather than by a lock file and a reclaim
protocol layered on top of it: a bound Unix domain socket.

Two file-based designs were tried and both grew a second version of
the same defect one layer down (an empty-content window between
creating a marker and writing its content, and a stale-reclaim race
between two starters both deciding to clear the same dead marker). A
bound socket has neither failure mode: `bind` is one atomic kernel
call -- there is no intermediate state where the name exists but is
unclaimed -- and the kernel itself frees the name the instant the
binding process exits, for any reason including a crash, with no
marker left behind to go stale, no pid to record and so no pid-reuse
case either.

## recovery.ts

`recoverPersistedTenants` runs once at controller startup, before any
new bump is admitted, for every tenant a crash left with a persisted
record still owing something. A crash is treated as an abort request
the process never got to record -- every action below matches a live
`abort()`'s own table -- except `applying`, whose rule ("WAIT... then
treat as verifying") is followed literally: `apply()` is never called
again for a tenant recovered here, and recovery waits for the
migration to actually settle before doing anything else with the
colour.

`done` is deliberately NOT settled: the bake window is still open,
and with no machine rehydrated for it, neither a later
`closeBakeWindow()` nor a later `abortAfterDone()` would have anything
to act on. It is rehydrated with no recovery action of its own -- the
state is already correct, only the in-memory object was lost.

## bumpStateMachine.ts: `BumpDependencies`

Every side effect is injected, never called directly, so this state
machine stays pure code and is tested against a fake slot -- and so it
coordinates with the broker's colour swap, the backup worker's
on-demand dump and the drain-flag revert rather than reimplementing
any of them. Wiring these to the real broker `/reconcile` call, the
backup worker's `run_tenant_dump`, and the drain flag is integration
work for whatever runs this state machine; this module owns only the
sequencing, the abort behaviour above it, and (via `persist`) the
durability of which step it is in.

## bumpStateMachine.ts: `awaitApplySettled`

Only used by recovery: probes whether a migration a crash interrupted
mid-`apply()` has since settled. `ok: true` requires POSITIVE evidence
that *this* apply's migration has ended -- for example, the container
or process `apply()` started has exited, or a recorded
lock-acquired/released pair post-dates the persisted `applying`
record's own timestamp, joined with Ghost's recorded schema state (its
migrations table, or equivalent) actually matching the target version.

A free `migrations_lock` alone is NOT such evidence: knex-migrator
reports it free both after a migration and before one has taken it, so
a controller that crashes and restarts while `apply()` is still
booting the container -- before Ghost has even reached the migrate
step -- would see a free lock immediately and read it as "settled",
when the migration has not started. "Cannot tell" always includes "may
not have started yet", not only "may still be running".

`ok: false` covers every case short of that positive evidence: a
timeout, the signal itself unreachable, or a genuinely unsettled
migration. The caller bounds this call itself (`recoverFromApplying`
races it against `applySettleTimeoutMs` and never trusts it to settle
or to stay resolved) -- but a throw or a hang here is always read as
`ok: false`, never as a pass: reverting traffic or stopping a colour
while the migration might still be live, or might not yet have
started, is exactly the unrecoverable state this whole design exists
to avoid.

## bumpStateMachine.ts: `page`

The one page signal for a tenant automation could neither verify nor
undo. At-least-once, not exactly-once: `pageSent` is only persisted
once this call has returned, so a crash between the call and that
write pages again on restart (`recoverUnpagedFailure`) rather than
risking the only page a broken tenant will ever get being silently
lost.

`dedupeKey` is `${bumpId}:${reason}` -- never random, and identical on
both the live page and any later recovery page for the exact same
bump and the exact same reason, because `bumpId` itself is
constructor-supplied (required, see `BumpStateMachineOptions`) and
persisted so recovery reconstructs the identical value. Pass it
through to whatever real paging system this wires to (PagerDuty, ntfy,
or similar all support a dedupe/idempotency key): the rare
live-then-crash-then-recovery duplicate collapses to one alert there,
while a genuinely different reason for the same bump, or the same
reason for a different bump, still pages as its own alert.

## bumpStateMachine.ts: `BumpStateMachineOptions.bumpId`

A stable identity for this bump, constant across a crash and restart.
Required, and never generated internally: `page()`'s own dedupe key is
`${bumpId}:${reason}`, and the one case that key exists for -- a live
`failUnsafe` page followed by a crash and a recovery page for the same
fault -- only collapses if both sides used the identical value, which
nothing but the caller can guarantee. Recovery reads the persisted
`bumpId` back off the record it is recovering (falling back to the
tenant id only for a record written before this field existed); a
live caller constructing a fresh bump must supply one too --
something that identifies this specific bump, not just the tenant, so
a second, later bump for the same tenant does not collapse into an
already-open incident (for example, tenant id plus the target
version).

## bumpStateMachine.ts: `recoverFromApplying`

A tenant recovered from a persisted `applying` record after a crash.
`apply()` runs inside the Ghost container on the app host, not inside
this process, so a controller crash does not stop it -- it is never
called again, but it may still be running for real. This waits for
`awaitApplySettled()` to confirm the migration is over before doing
anything else: an outcome that cannot be confirmed goes straight to
`failed-unsafe`, never to `verify()`, `revertTraffic()` or
`stopColour()`, any of which could act on a colour still mid-migration.

Held under the same `ApplyLock` as a live `apply()`: "at most one
tenant ever in `applying`" should not depend on whatever runs this
remembering to keep new bumps out until every recovered one has
finished settling -- holding the lock here makes that true
structurally, the same way `run()`'s own `apply()` call does.

## bumpStateMachine.ts: `verifyAndFinish`

The shared tail of a completed, settled, successful `apply()` (real or
recovered): check health, then land on `done` or hand off to the
revert path. Never entered on an apply failure, a pending abort, or an
unsettled recovery -- `run()` routes the first two straight past
`verify()` to the revert path, and `recoverFromApplying` routes the
third to `failed-unsafe` instead of calling this at all. Verify itself
throwing -- not answering ok or not-ok, just failing to run -- is the
"can't be verified" case: it goes straight to `failed-unsafe` rather
than being treated as either a pass or an ordinary failure.

## bumpStateMachine.ts: `failUnsafe`

Pages at least once, ever, for this bump: never on a second call from
a single live instance (the `pageSent` guard), but not relied on to be
exactly once across a restart either. `failed-unsafe` is persisted
with `pageSent: false` *before* `page()` runs, so a crash between the
call and the write that would have recorded `pageSent: true` recovers
as unpaged (`recoverUnpagedFailure` pages again then) rather than as
silently settled. That is the deliberate trade: a duplicate page for
the same tenant collapses at the pager via `page()`'s own `dedupeKey`;
a page for a tenant this automation could neither verify nor undo,
lost to a crash, does not.

## bumpStateMachine.ts: `probeApplySettled`

Never trusts `awaitApplySettled()` to bound or contain itself: a throw
(the migration signal itself unreachable, a case the dependency's own
contract names) or a hang past `applySettleTimeoutMs` both collapse to
the same `ok: false` result `recoverFromApplying` already treats as
unsettled. Without this, a throwing or hanging probe would reject out
of `recoverFromApplying` entirely, aborting the whole startup recovery
sweep for every other tenant still waiting behind this one --
including one sitting in `failed-unsafe` with `pageSent: false`, whose
one page would then never go out.
