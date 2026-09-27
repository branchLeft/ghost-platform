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
runs it. `src/processLock.ts` enforces that structurally: a second
`ring-controller` process started against the same lock file refuses to
run rather than silently sharing the fleet with the first.

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
  time, whatever the crash actually left mid-flight; recovery jumps
  straight to the verify step a completed apply would have reached, and
  treats an outcome that cannot even be verified as `failed-unsafe`
  rather than as a pass.
- `verifying` / `reverting` -- revert; the process died before finding
  out whether the new colour was healthy, so the same rule as a live
  abort landing here applies.
- `reverted` -- retry the new colour's teardown; a flag change and a
  teardown are both safe to repeat.
- `done`, `closed`, `backup-failed`, `cancelled`, `failed-unsafe` --
  already resting states; no action.

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
   this structurally within the one process that ever runs it, and
   `src/processLock.ts` enforces that there is only ever one such
   process -- proven by two independent sabotage pairs: the same
   `apply()` body, run through the lock, never overlaps; run directly with
   nothing serialising it, it does; and a second process against the same
   lock file is refused outright.
4. `failed-unsafe` pages exactly once, ever, per bump, and `run()` refuses
   to be called a second time on the same instance -- there is no
   automatic retry path to disable, because there is no path back into
   `run()` at all once a bump has reached any terminal state.

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
