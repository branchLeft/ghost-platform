# ring-controller

The per-tenant bump state machine and its abort flag
(design: `ghost-platform-docs/19-try-it-now-design/04-version-and-upgrades.html`
§04/§05, with §03 for the gate set and the watcher this component sits
beside). Deterministic software with no model in its path -- it compares
a released digest against a pinned one, drives one tenant's bump through
backup, apply, verify and, on failure or abort, revert, and pages a
person when it runs out of moves. It exercises no judgement of its own:
every genuine decision (a major version, an irreversible migration, a
failed gate) is settled upstream of this module by refusal, never by a
person approving the release.

## What this module is, and is not

`src/bumpStateMachine.ts` is pure sequencing and abort logic. Every side
effect -- taking a backup, running the blue/green migration, checking
health, flipping the traffic flag back, tearing down a colour, paging,
and persisting the current step -- is passed in as a `BumpDependencies`
object, never called directly. That is what keeps this story's own tests
pure-code against a fake slot, and what keeps this module from
reimplementing:

- the backup worker's on-demand, per-tenant dump and its floor assertion
  -- `backup()`'s result shape is modelled on that worker's own dump
  result, not a second implementation of it;
- the broker's colour swap -- `apply()` stands in for whatever call
  starts the swap and is awaited to completion, never interrupted;
- the drained-colour restore -- out of this module's scope entirely.
  `revertTraffic()` is a flag change back to the still-running old
  colour, never a restore; the restore path is the incident branch the
  design keeps unreachable for the whole bake window, and this component
  does not open it.

## Rings

`runRelease` (`src/ringController.ts`) takes one already-published image
digest through four rings in a fixed order: slot 0's canaries, the demos,
entry, then professional (LLD-4 §04/§06b). It is the sequencer that sits
above the per-tenant state machine. It decides nothing a person should
decide, and it has no model in its path (D37).

1. **Pre-flight.** It refuses to run if the environment it is handed holds a
   model key or an agent binary is on its `PATH`. A major or irreversible
   release (`route: 'consent'`, the refused route) is refused with no gate
   run and no bump, so tenants stay on the current version. The refusal is
   raised as an operational alert and a filed work item by the hold sink the
   caller injects (`RingControllerDependencies.hold`).
2. **Gates.** The gates run once, on slot 0, and the report must be for the
   release digest. Any red gate, no gates at all, or another digest holds
   the release before any tenant is touched.
3. **Rings, in order, one tenant at a time.** A tenant that does not reach
   `done` stops the release. There is no fleet-wide undo.
4. **Bake, then advance.** A ring advances only when its bake window has
   elapsed, every member is healthy and reports the release digest, and no
   error was reported since the ring started. The timer alone never
   advances a ring. An empty ring still waits out its window.
5. **No ring 2 without MySQL.** The entry ring is not entered unless ring 0
   held a MySQL tenant that reached `done` and stayed healthy (U6).

Who is in which ring is data the caller supplies, never code in this
module: `parseRingAssignments` (`src/ringMembership.ts`) refuses anything but
all four rings named once with each tenant in exactly one, and
`createListMembers` turns it into `listMembers`. A tenant's engine is read
through an injected `engineOf`, never from the assignment data, so nothing
can satisfy rule 5 by being labelled MySQL. The tenant-zero MySQL canary
joins ring 0 by being listed there; the assignment data is held with the
controller's own host configuration, not in this public repository.

A red gate, a major release or a regression is a hold, not a page: tenants
stay on the current version, and the hold is raised as an operational alert
and a filed work item. No person approves a release to get past it. The only page is the state machine's own `failed-unsafe`.
Everything reaching a host is injected (`RingControllerDependencies`), the
clock included, so the tests drive whole releases against fakes and a fake
clock. `package.json` declares no runtime dependencies, and a test asserts it.
The narrative is in `src/README.md`.

## Running this: one long-lived process, not a pipeline job

This runs as a single, long-lived controller process, not as a scheduled
CI job. Two reasons, both structural rather than stylistic:

1. **Every tenant's ring, including private ones, would otherwise have to
   run against a public automation surface.** A workflow triggered from
   this repo executes in the open, and a private tenant's bump has no way
   to stay off it -- the automation itself would be the disclosure. A
   long-lived process run privately has no such leak.
2. **The step this exists to protect is operationally sensitive.** A
   tenant caught mid-`applying` when the runner disappears (a job
   cancelled, a runner evicted, a workflow timeout) is exactly the
   unrecoverable half-applied state the whole design exists to avoid --
   and a triggered job, by construction, can be killed between any two
   steps. A process this repo owns end-to-end can guarantee the one thing
   that matters instead: the migration step is always awaited to
   completion, and a crash anywhere else recovers safely on restart (see
   "Crash recovery" below).

`src/applyLock.ts`'s in-process mutex is therefore sufficient for "at
most one tenant ever in `applying`" only because exactly one process ever
runs it. `src/processLock.ts` enforces that structurally, on a kernel
primitive rather than a lock file: it binds a Unix domain socket in
Linux's abstract namespace (no filesystem entry, identified by a leading
NUL byte). The bind is one atomic kernel call, so there is no window
where a second process could observe the name as unclaimed; a second
`ring-controller` gets `EADDRINUSE` and refuses to run; and the kernel
itself frees the name the instant the holder exits, for any reason
including a crash, so there is nothing stale left to detect or reclaim.

**This targets Linux hosts.** The abstract namespace does not exist on
macOS or other BSDs; `acquireProcessLock`'s `path` option exists so tests
can bind a portable, filesystem-backed Unix socket instead (same
primitive, same guarantees, just visible on disk) and run everywhere,
while production always uses the default abstract path. A second,
coarser layer lives outside this code: deploy as a plain
`ring-controller.service` systemd unit (never a templated
`ring-controller@.service`), so systemd itself only ever manages one
instance.

## Crash recovery

Every state change is durably recorded (`src/tenantStateStore.ts`, an
atomic write -- temp file, fsync, rename, fsync the directory -- so a
reader never observes a half-written record) before the side effect for
that state runs. On restart, `src/recovery.ts` reads every persisted
record and resumes or cancels each one per the same table `abort()`
already drives at runtime:

- `pending` / `backing-up` / `backed-up` -- cancel cleanly; nothing
  uninterruptible was in flight.
- `applying` -- **never re-entered.** `apply()` is not called a second
  time, whatever the crash actually left mid-flight. Recovery first waits
  for `awaitApplySettled()` to confirm, with positive evidence (not
  merely a free `migrations_lock`, which is also true before a migration
  has even started), that *this* apply's migration has actually ended --
  bounded by a timeout, with a throw or a timeout both read as "cannot
  tell". Only once settled does it run the same verify-then-decide tail a
  live, successful `apply()` reaches; an outcome that cannot be confirmed
  settled goes straight to `failed-unsafe`, never to `verify()`,
  `revertTraffic()` or `stopColour()`, any of which could act on a colour
  still mid-migration. A saved abort on the record turns a settled, healthy
  outcome into a revert, never `done`.
- `verifying` / `reverting` -- revert; the process died before finding
  out whether the new colour was healthy, so the same rule as a live
  abort landing here applies.
- `reverted` -- retry the new colour's teardown; a flag change and a
  teardown are both safe to repeat.
- `closing` -- retry the old colour's teardown and record `closed`; the
  bake window had already elapsed clean and `done` had already been
  claimed, so nothing about that decision is re-made.
- `done` -- rehydrated with no action: the bake window is still open and
  the state on disk is already correct, but with no machine reconstructed
  for it, a later `closeBakeWindow()` or `abortAfterDone()` would have
  nothing to act on. A `done` whose record carries a saved abort is
  reverted instead: nobody will watch its bake.
- `closed`, `backup-failed`, `cancelled` -- already resting states; no
  action.
- `failed-unsafe` -- resting only once `pageSent: true`. A record still
  showing `pageSent: false` means the crash landed between recording the
  state and the page actually going out: recovery pages now (see "at
  least once" below), never treating an unpaged failure as settled.

## The state names are incidental; the behaviour is not

Four things are load-bearing, all proven by test
(`test/unit/bumpStateMachine.test.ts`, `test/unit/recovery.test.ts`):

1. A tenant in `applying` is never interrupted -- `apply()` is always
   awaited to completion, abort requested or not -- and never re-entered
   after a crash either.
2. Abort acts per tenant, per the table (`pending`/`backing-up`/`backed-up`
   cancel; `applying` waits; `verifying`/`done` revert). There is no
   fleet-wide undo.
3. At most one tenant is ever in `applying`. `src/applyLock.ts` enforces
   this structurally within the one process that ever runs it -- proven by
   a sabotage pair: the same `apply()` body, run through the lock, never
   overlaps; run directly with nothing serialising it, it does.
   `src/processLock.ts` enforces that there is only ever one such
   process, on a kernel primitive (a bound Unix domain socket) rather
   than a lock file and a reclaim protocol: a second process's bind fails
   with `EADDRINUSE`. Proven against a real, separate process, killed
   with `SIGKILL`, twice: against the portable filesystem-backed seam
   (`test/unit/processLock.test.ts`); and on real Linux, against the
   actual abstract-namespace path production uses, confirmed via
   `/proc/net/unix` -- via a standalone harness run in a `node:26`
   container against the compiled module. The equivalent
   `it.skipIf(process.platform !== 'linux')` test in the suite itself
   passes when run directly on a Linux host or container with its own
   `pnpm install`; it is not run by `vitest` inside the harness above. `recoverFromApplying` holds the same lock for its
   whole settle-and-verify tail, so the invariant holds structurally
   during recovery too, not by convention.
4. `failed-unsafe` pages **at least once**, ever, per bump -- not exactly
   once. A crash between `page()` returning and persisting `pageSent:
   true` pages again on the next restart, rather than risking the one
   page a tenant automation could neither verify nor undo being silently
   lost; the rare duplicate carries a stable per-bump `dedupeKey` so
   whatever real paging system this wires to collapses it. `run()`
   refuses to be called a second time on the same instance -- there is no
   automatic retry of the *bump itself* to disable, because there is no
   path back into `run()` at all once a bump has reached any terminal
   state.

`closeBakeWindow()` and `abortAfterDone()` are the only two calls that
ever act on a tenant sitting in `done`, and a single synchronous claim
(no `await` between the check and the write) guarantees only one of them
ever proceeds, even when both are called in the same tick -- otherwise a
bake-window close and a post-`done` health-regression revert could race
to stop or revert the same colour.

## Promotion record

`src/promotionChainLog.ts` is the controller's own append-only record of
every slot promotion: one Ed25519-signed entry per slot per promotion, each
carrying the hash of the entry before it. `append` verifies the whole file
first and refuses, writing nothing, when the chain or a signature does not
verify. Tests: `test/unit/promotionChainLog.test.ts`, and a sabotage pair for
each check in `test/unit/promotionChainLogSabotage.test.ts`. The format, what
it detects and the one thing it cannot detect alone (removal of the last
entries, closed by a head held elsewhere) are in `src/README.md`.

`runRelease` records each member before it stops that member's old colour
(`recordPromotion`), and holds the release when a record cannot be written.
`src/signingKeyFile.ts` loads the key from a file only the service account
can read, and `src/promotionRecorder.ts` keeps the recorded head beside the
log; the permission model, the four path variables and what the head does and
does not anchor are in `src/README.md`. The role that makes the key and the
copy kept off the host are not built here.

## What this module deliberately does not build

Resolved by a recorded owner ruling: the controller never undoes a
migration automatically. There is no automatic migration-down, anywhere
in this module. `revertTraffic()` is always a routing decision, never a
schema one. Once `closeBakeWindow()` has run -- the old colour stopped,
nothing wrong found -- a later fault is `failed-unsafe`: it pages, it
does not retry, and it does not reach for the restore path the design
already rules no automation may depend on routinely.
