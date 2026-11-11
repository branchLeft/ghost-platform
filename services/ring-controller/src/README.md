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

## bumpStateMachine.ts: `revertOrFailUnsafe`

A revert that cannot even run -- `revertTraffic()` throwing, or
`stopColour('new')` throwing after a successful revert -- is the "cannot
undo" case: it goes to `failed-unsafe` and pages, exactly like a throwing
`verify()`, rather than escaping with the state stuck at `reverting`.
This matters on recovery: `recoverFromRevertInFlight` reaches the same
call after a restart, and without the guard it would throw again on every
restart, so the tenant would never be paged (the startup sweep only logs
it under `failed`). A `failed-unsafe` record with `pageSent: true` is not
retried at restart, so that page is how a person learns the new colour
was left running.

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

## rings.ts

`RING_ORDER` is slot 0's canaries, then the demos, then entry, then
professional (LLD-4 §04/§06b). The order is the safety property: a fault
meets the fewest and most forgiving tenants first. It is a frozen constant
and no argument to `runRelease` can reorder it. The bake times are the
opposite: incidental, supplied by the caller as a `RingBakeConfig`
(`DEFAULT_BAKE_MS` holds the 15, 15, 30 and 30 minute starting values), and
validated before anything is touched. A ring with no `bakeMs` is a
configuration error, not a zero.

`MYSQL_CANARY_RING` and `MYSQL_GATED_RING` name the U6 rule: no tenant of
the entry ring is bumped unless the first ring held a MySQL tenant that
reached `done` and passed its bake.

## gates.ts

`assertGatesGreen` is pure. The gates run once, on slot 0 (LLD-3), against
the digest of an already-published image. The report must name that same
digest, because a green report for some other build says nothing about this
one. An empty result list is not green either: a gate runner that ran
nothing must not read as a pass. A report for another digest is checked
first, so its results are never read as if they applied.

## modelFreeEnvironment.ts

D37: no model, no agent and no token budget anywhere in the promotion path.
The check works in both directions. A controller that can promote with every
model key absent, and that also refuses to run when one is present, cannot
quietly start depending on a model.

The deny-list is documented as exported constants: any `*_API_KEY`, any
`ANTHROPIC_`, `OPENAI_` or `CLAUDE_CODE_` variable, and an agent binary
(`claude`) resolvable through the `PATH` it is given. Names are matched
ignoring case. A listed variable whose value is `undefined` is absent. The
error names the variable or binary and never a value, because it reaches
logs and the hold sink. The function reads only the environment passed to
it. Nothing in `src/` reads the process environment, so a test can hand it
any environment and a real child process can hand it its own.

## ringController.ts

`runRelease` is the whole sequencer: pre-flight, gates, then each ring in
order.

- **Pre-flight.** The environment check runs first. A release whose route
  is not `fast-path` (a major version, an irreversible migration) is held
  as `consent-required` with no gate run and no bump. Nobody consents to it:
  the route is decided upstream, and the release is refused, so tenants stay
  on the current version.
- **Hold, not page.** A red gate, a refused route or a regression is a
  hold: tenants stay on the current version, and the hold is raised as an
  operational alert and a filed work item. The only page is the
  one the state machine already raises for `failed-unsafe`. The `hold` sink
  is separate from `BumpDependencies.page` so the written register of what
  may page is untouched.
- **Serial.** Members of a ring are bumped one at a time. A member that
  does not reach `done` (or whose bump throws) stops the release, later
  members are never touched, and nothing is undone fleet-wide. One shared
  `ApplyLock`, created by the caller and handed to every machine
  `newBump` builds, is the structural backstop beneath this loop.
- **Bake.** The window opens when the ring's last member reaches `done`, so
  every member soaks the whole time. An empty ring opens it on entry and
  waits it out all the same: the decision was bake, then advance.
- **Not the timer alone.** Each pass reads every member's health and
  reported errors, never stopping at the first healthy one, and a last pass
  runs at or after the window's end. A tenant is healthy only if it says so
  and reports the release digest read from the running instance. A probe
  that throws blocks the ring (`probe-failed`) but reverts nothing, because
  failing to look is not evidence of a regression. Reported errors are read
  since the ring started.
- **Regression.** Each tenant with affirmative evidence of trouble gets the
  state machine's own `abortAfterDone()`, a flag change back to the old
  colour. Others in the ring are left as they are. No old colour has been
  stopped, so every revert is still only a flag change.
- **Advance.** Only when the window has elapsed, the last pass was clean and
  no errors were reported does the ring's old colours get stopped
  (`closeBakeWindow()`, serially) and the next ring begin. A close that
  throws or ends anywhere but `closed` holds the release as `bump-not-done`.

Not built here: persisting release and ring progress across a crash (each
tenant already recovers on its own, but a tenant rehydrated in `done` has no
controller left to close its bake window), and the real adapters (broker
reconcile, health and gate runners, the source of the ring assignments
and of each tenant's engine).

## promotionChainLog.ts

The controller's own record of which slot took which release, kept apart
from anything a person or another service can write to.

- **Format.** One JSON object per line, fixed key order, no whitespace:
  `version`, `seq`, `at`, `promotion`, `slot`, `digest`, `prev`,
  `signature`. `seq` counts from zero. `prev` is the SHA-256 of the previous
  entry's exact line, or sixty-four zeros for the first. `signature` is
  Ed25519 (`node:crypto`, no dependency) over a domain tag plus the seven
  fields before it. A line that is not byte-for-byte the one serialisation
  is refused, so a respaced entry cannot pass as the original.
- **One entry per slot per promotion.** A second entry for the same
  `promotion` and `slot` is refused at append and fails verification.
- **Append verifies first.** `append` reads the whole file and verifies it
  from the first byte before it writes, and refuses (a `ChainRefusedError`
  with a code) on any failure, writing nothing. It also signs, then checks
  its own signature against the public half, so a private key that is not the
  one the committed public half belongs to is refused before a byte is
  written. The file is opened for append, synced, and the directory synced
  when the file is new. Appends inside one process are queued; the process
  lock keeps it to one process.
- **What it detects.** An altered field (signature), a removed or reordered
  entry (sequence and hash link), an entry from another log (hash link), an
  entry signed by another key, a half-written last line, an extra or missing
  field.
- **What it cannot detect alone.** Removing the *last* entries leaves a
  shorter chain that is still valid. `verify({ head })` closes that when the
  caller holds the head (`seq` and hash) from somewhere else; where that
  anchor lives is not decided here.
- **A half-written last line** (a crash inside the append) makes the log
  refuse every later append until a person looks at it. That is deliberate:
  gluing onto it would hide the break.
- **Not here.** Reading the key from disk, the role that makes it, and wiring
  `append` into `runRelease`.
