# ring-controller

The per-tenant bump state machine and its abort flag
(design: `ghost-platform-docs/19-try-it-now-design/04-version-and-upgrades.html`
§04/§05, with §03 for the gate set and the watcher this component sits
beside). Deterministic software with no model in its path -- it compares
a released digest against a pinned one, drives one tenant's bump through
backup, apply, verify and, on failure or abort, revert, and pages a
person when it runs out of moves. It exercises no judgement of its own:
every genuine decision (a major version, an irreversible migration, a
failed gate) is somebody else's call, upstream of this module.

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

Wiring these dependencies to the real broker `/reconcile` call, the
backup worker, and the drain flag is integration work for whatever
constructs a `BumpStateMachine` for a real tenant -- not built here.

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
instance -- see the PR body's runbook for the unit file.

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
  still mid-migration.
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
  nothing to act on.
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
   with `SIGKILL`, twice: on this dev machine, against the portable
   filesystem-backed seam (`test/unit/processLock.test.ts`); and on real
   Linux, against the actual abstract-namespace path production uses,
   confirmed via `/proc/net/unix` -- via a standalone harness run in a
   `node:26` container against the compiled module (the PR body has the
   command and its output), because the borrowed `node_modules` this
   session runs `vitest` from is built for macOS and its native
   dependencies (`esbuild`) cannot load inside a Linux container. The
   equivalent `it.skipIf(process.platform !== 'linux')` test in the
   suite itself passes when run directly on a Linux host or container
   with its own `npm install`; it is not run by `vitest` inside the
   harness above. `recoverFromApplying` holds the same lock for its
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

## What this module deliberately does not build

Resolved by a recorded owner ruling: the controller never undoes a
migration automatically. There is no automatic migration-down, anywhere
in this module. `revertTraffic()` is always a routing decision, never a
schema one. Once `closeBakeWindow()` has run -- the old colour stopped,
nothing wrong found -- a later fault is `failed-unsafe`: it pages, it
does not retry, and it does not reach for the restore path the design
already rules no automation may depend on routinely.
