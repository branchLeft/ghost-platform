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

A saved abort (`abortRequested: true` on the record) is honoured on
restart. Every machine is rehydrated with it, so a recovered `applying`
that settles reverts instead of finishing, and a recovered `done` is
reverted at once: the process that asked for the abort had given up on
that tenant's bake, so nobody will ever watch it. `persist` writes are
chained, so a slow write of an earlier step never lands over the abort
that interrupted it.

Each call the sweep makes that nothing else bounds has its own limit per
call, taken from the optional `deadlines` argument (any left out take
`DEFAULT_RECOVERY_DEADLINES`; a limit that is not a finite number above
zero is refused before any record is read): `revertTrafficMs`,
`stopColourMs`, `verifyMs` and `pageMs`. A call that misses its limit is read as a
throw, so one hung host costs its own record that long and no record
after it anything. What follows depends on the call:

- `revertTraffic()` (a `verifying`, `reverting`, saved-abort `applying` or
  saved-abort `done` record): the machine already turns a throw into
  `failed-unsafe` and pages, so the record is paged by its own machine.
- `stopColour()` in a `reverted` or `closing` record: nothing pages for a
  throw there, so the sweep pages the record itself, once, with the dedupe
  key `${bumpId}:${reason}`, and reports it in `failed` with `paged: true`.
  The record is left as it is, so the next restart retries the teardown.
- `verify()` (a recovered `applying` whose migration settled): the machine
  turns a throw into `failed-unsafe` and pages, so the record is paged by
  its own machine and the sweep moves on.
- `page()`: nothing can page for a page. The record stays `failed-unsafe`
  with `pageSent: false`, is reported in `failed` with `paged: false`, and
  is retried on the next restart.

Not bounded here: `persist`, which is the caller's own write to its store
and not a call to a host. A `persist` that never settles still stalls the
sweep and every record after it.

`persistToStore` is what turns each `PersistSnapshot` into a saved
`PersistedTenantState`. It names every field, `abortRequested` included,
so an abort saved by the live process is the one a restart reads back.

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
it, so a test can hand it any environment.

## processEntry.ts

`runReleaseFromProcess` is the entry a real process calls, and the one file
in `src/` that reads the process environment. It takes no environment
argument and hands `process.env` to `runRelease` as it stands, so a caller
cannot pass a scrubbed copy while the process itself holds a model key. A
static test pins it as the only reader and pins the exact call; sabotage
pairs pass an empty or filtered environment and watch a key get through.
`runRelease` itself is not exported from the package entry (`index.ts`), so
a caller outside this package cannot hand it an environment of its own.

## deadlines.ts

Every outside call `runRelease` awaits has a bound: `runGates()` once,
`listMembers()` once per ring, each member's `machine.run()` and, if that
times out, the save of its abort, each `health()` and `reportedErrors()`
call on every soak pass, each `clock.sleep()` between passes (its own length
plus `sleepOverrunMs`), each `recordPromotion()`, each `closeBakeWindow()`,
each regression revert (`abortAfterDone()`), and each `hold()`. The caller
sets them in `deps.deadlines`; any left out take `DEFAULT_CALL_DEADLINES`,
whose values are incidental. A bound that is not a finite number above zero
is refused before anything is touched, because one that could never fire
puts the hang back.

A call that misses its bound is read exactly as if it had thrown: hung gates
hold as `gate-red`; a hung member list, probe or bake clock holds as
`probe-failed` and reverts nothing; a hung recorder holds as
`promotion-record-failed` before that member's old colour is stopped; a
hung bake-window close holds as `bump-not-done`; a hung revert is named in
the regression's hold. A hung `hold()` rejects `runRelease` with
`DeadlineExceededError`, because a hold nobody received must not be
returned as if it had been raised.

A hung bump fails its member as `bump-not-done`, later members are never
touched, and the machine is asked to `abort()`: a promise cannot be
cancelled, so the request lands at the machine's own safe point (cancel
before apply, never interrupt apply, revert after it). `run()` checks the
flag once more inside the apply lock, just before `applying` is entered,
because both the `backed-up` write and the wait for the lock yield; an abort
that lands in either still cancels, and the migration never starts. One that
lands while `done` is being written reverts. `abort()` saves the request
before it settles, and the controller waits for that save, up to `abortMs`,
before it holds and moves on; a save that fails or hangs is named in the
hold. A bump that finishes late therefore ends reverted or cancelled, never
`done` with nobody watching its bake, and a restart honours the saved abort
too (see recovery.ts above). The calls are wrapped once, where `runRelease`
takes its dependencies or at the one call site of each machine method, so
no call site can forget one.

A recorder that answers after its bound may still append its record. The
hold already stopped the release before that member's old colour was
stopped, so the late record names a promotion whose old colour still runs:
an inconsistency for whoever clears the hold to read, not an unsafe state.

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
  does not reach `done` (or whose bump throws or misses its deadline) stops the release, later
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
  that throws or misses its deadline blocks the ring (`probe-failed`) but reverts nothing, because
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
- **Not here.** The role that makes the key. Reading it, keeping the head
  and the call from `runRelease` are in the next three sections.

## signingKeyFile.ts

Reads the record-signing keys from files. The private key is a PKCS8 PEM
Ed25519 key; the committed public half is an SPKI PEM Ed25519 key.

**The permission model for the private key file.** It must be a regular
file, reached without following a symlink, owned by the uid the controller
runs as (the `ring-controller` account), with no group or other permission
bit set: `0400`, or `0600`. The loader opens the file with `O_NOFOLLOW`, then
checks type, owner, mode and size on the opened descriptor, and only then
reads and parses it. Any other file is refused before it is read.

- **Why not a root-only `0400` file.** The account cannot open it, so the
  controller could never sign; the loader reports `not-permitted`.
- **Why not root-owned `0440` with the service group.** It gives the key to
  every member of that group, and needs a group the role must create and keep
  right. The controller holds the key in memory to sign with it, so a
  root-owned file buys no isolation from the controller itself.
- **What the model protects.** Other local accounts, and a bug elsewhere on
  the host that reads files it should not. A planted file is refused for its
  owner, so the directory's own mode is a second line, not the first.
- **What it does not protect.** A compromise of the controller account or of
  root. The signature proves the record was made by something that held the
  key, not by a step isolated from the controller. The independent anchor is
  the copy kept off the host, which is not built here.
- **Two ways to meet it, both accepted unchanged.** The role writes the file
  owned by the account at `0400`, in a directory only that account can write;
  or the unit loads a root-only source file through a systemd credential and
  points the variable at the delivered copy, which the loader then checks like
  any other file. The role decides, after reading the owner and mode systemd
  gives that copy on the host.

Every refusal is a `KeyFileError` with a code and the path. Its message never
carries file content, and the loader writes to no log. `loadPublicKeyFile`
refuses a file holding a private key: Node would derive the public half from
it, and the signer-key check would then compare a key with itself.

## promotionRecorder.ts

The recorder is the log plus the recorded head. `record` does, in order: read
the log and verify it from its first byte, compare it with the head file,
append one signed entry, read the log back, write the new head atomically
(`atomicFile.ts`: temp file, fsync, rename, fsync the directory). One record at
a time.

- **What the head is for.** Removing the last entries of the log leaves a
  shorter chain that still verifies. The head file keeps the last sequence
  number and hash, so a shorter or rewritten log is refused rather than
  continued. This guards the log against loss and rollback by itself. Someone
  who can write both files can rewrite both; the independent anchor is the copy
  kept off the host, which is not built here.
- **Agreement rule.** The log must verify, the entry at the recorded sequence
  number must still hash to the recorded hash, and the log may be at most one
  entry longer than the head. One longer is a crash between the append and the
  head write, and is healed by writing the head. A missing head is accepted
  only beside a log of at most one entry, for the same reason. Anything else
  is refused (`log-behind-head`, `log-ahead-of-head`, `head-missing`,
  `head-malformed`) and nothing is appended.
- **Head write failure.** The append has happened, the call throws
  `head-write-failed`, and no further entry is appended until the head can be
  written.
- **Configuration.** `createPromotionRecorderFromEnv(env, now)` reads four
  absolute paths, none with a default, and refuses to start if one is unset or
  relative:

  | Variable                                | Holds                                                    |
  | --------------------------------------- | -------------------------------------------------------- |
  | `RING_CONTROLLER_PROMOTION_LOG_FILE`    | The promotion log. Owned by the account, mode `0600`.    |
  | `RING_CONTROLLER_PROMOTION_HEAD_FILE`   | The recorded head, beside the log. Mode `0600`.          |
  | `RING_CONTROLLER_RECORD_SIGNING_KEY_FILE` | The private key, as above.                             |
  | `RING_CONTROLLER_RECORD_PUBLIC_KEY_FILE`  | The committed public half, SPKI PEM.                   |

  `env` is passed in; nothing here reads the process environment.

## ringController.ts: recording

`runRelease` calls `recordPromotion` once per member after the ring has
baked clean and before that member's old colour is stopped. The record names
the promotion (the release digest), the slot (the member's tenant id) and the
digest. Stopping the old colour is the last step that can be undone by a flag
change, so the record is durable first.

A record that cannot be written holds the release as `promotion-record-failed`
at that ring, naming the tenant. The member stays in `done` with its old
colour running, nothing later is touched, and no member is reverted: failing to
write is not evidence that the tenant regressed, the same as a failed probe.
Members already recorded and closed stay so. A recorder that is not wired holds
the same way. A tenant id the log refuses (outside `A-Z a-z 0-9 . _ : -`, 128
characters) or a digest it refuses holds the release too, before anything is
stopped. A second run of the same digest is refused by the log's one entry per
slot per promotion.
