# ring-controller

The per-tenant bump state machine and its abort flag
(branchLeft/workspace#1274; design: `ghost-platform-docs/19-try-it-now-design/04-version-and-upgrades.html`
§04/§05, with §03 for the gate set and the watcher this component sits
beside). Deterministic software with no model in its path (owner ruling
D37) -- it compares a released digest against a pinned one, drives one
tenant's bump through backup, apply, verify and, on failure or abort,
revert, and pages a person when it runs out of moves. It exercises no
judgement of its own: every genuine decision (a major version, an
irreversible migration, a failed gate) is somebody else's call, upstream
of this module.

## What this module is, and is not

`src/bumpStateMachine.ts` is pure sequencing and abort logic. Every side
effect -- taking a backup, running the blue/green migration, checking
health, flipping the traffic flag back, tearing down a colour, paging --
is passed in as a `BumpDependencies` object, never called directly. That
is what keeps this story's own tests pure-code against a fake slot, and
what keeps this module from reimplementing:

- the backup worker's on-demand, per-tenant dump and its floor assertion
  (branchLeft/ghost-platform#261) -- `backup()`'s result shape is modelled
  on that PR's `DumpResult`, not a second implementation of it;
- the broker's colour swap (workspace#1267) -- `apply()` stands in for
  whatever call starts the swap and is awaited to completion, never
  interrupted;
- the drained-colour restore (branchLeft/ghost-platform#272) -- out of
  this story's scope entirely. `revertTraffic()` is a flag change back to
  the still-running old colour, never a restore; the restore path is the
  incident branch LLD-4 U7 keeps unreachable for the whole bake window,
  and this component does not open it.

Wiring these dependencies to the real broker `/reconcile` call, the
backup worker, and the drain flag is integration work for whatever
constructs a `BumpStateMachine` for a real tenant -- not built here.

## The state names are incidental; the behaviour is not

workspace#1274 marks the state names incidental and four things
load-bearing, all proven by test (`test/unit/bumpStateMachine.test.ts`):

1. A tenant in `applying` is never interrupted -- `apply()` is always
   awaited to completion, abort requested or not.
2. Abort acts per tenant, per the table in LLD-4 §05
   (`pending`/`backing-up`/`backed-up` cancel; `applying` waits;
   `verifying`/`done` revert). There is no fleet-wide undo.
3. At most one tenant is ever in `applying`. `src/applyLock.ts` enforces
   this structurally, beneath whatever serial iteration the ring itself
   does -- proven by a sabotage pair: the same `apply()` body, run through
   the lock, never overlaps; run directly with nothing serialising it, it
   does.
4. `failed-unsafe` pages exactly once, ever, per bump, and `run()` refuses
   to be called a second time on the same instance -- there is no
   automatic retry path to disable, because there is no path back into
   `run()` at all once a bump has reached any terminal state.

## What this story deliberately does not build

Per the issue's own "Open question", resolved by Rob's recorded ruling on
this issue (2026-09-23, "the controller never undoes a migration
automatically"): there is no automatic migration-down, anywhere in this
module. `revertTraffic()` is always a routing decision, never a schema
one. Once `closeBakeWindow()` has run -- the old colour stopped, nothing
wrong found -- a later fault is `failed-unsafe`: it pages, it does not
retry, and it does not reach for the restore path LLD-9 already rules no
design may depend on routinely.
