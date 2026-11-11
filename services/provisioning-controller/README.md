# provisioning-controller

The tenant provisioning controller's core, in two halves. Real host adapters
are not here: every side effect is a port, and only test doubles exist today.

## Part 1: planning

`planOnboarding(approvalId, ports)` returns an ordered, typed plan of every
onboarding step from one recorded owner approval and the tenant register. It
executes nothing and writes nothing.

- The approval id is the only trigger; the tenant comes from the recorded
  approval and every input from the register. No approval, or one that does not
  cover setup, the web address and the first deploy, yields no plan.
- Each `PlannedStep` has a stable `key` (`<tenant>/<step id>`), its
  `dependsOn`, typed `inputs` (names of secrets, never values) and an
  `inputDigest`.
- The register and the approval ledger are ports (`src/ports.ts`). The portal
  data package owns the real register but is not importable from here, so an
  adapter is needed before this runs for real.

## Part 2: execution

`executeOnboarding(approvalId, ports, options?)` runs that plan. Every call is
a fresh start or a resume.

- **Approval gate.** All three scopes are checked once before the run, before
  the state is read and before any step is planned, so one withdrawn scope (or a
  narrowed approval) refuses the whole run with no step run. Each step's own
  scope is checked before every attempt of that step, retries included
  (`src/gate.ts`). An attempt already in flight is not interrupted; the check
  comes before the next attempt. So a scope withdrawn mid-run stops the run at
  the next attempt of a step that needs it, and that step is not started. The
  run then throws, so the steps after it do not run in that call, even those in
  scopes still granted; steps already complete stay recorded. Revoking the
  approval, or re-pointing it at another tenant, is refused at the next check.
  Before the run there is no tenant to compare, so the run takes the tenant the
  ledger names when it starts. Each stop appends a `run-halted` record, tells
  the console, and throws the part 1 approval error. If the store does not
  accept that record, `StateStoreWriteError` is thrown instead.
- **Recorded state, before acting and after.** A `started` record is appended
  before a step is tried and a `complete` record before the next step starts.
  The store is append-only (`StateStore`); `FileStateStore` writes one JSON
  line per record and fsyncs before it resolves. If the history cannot be read
  the call throws `StateStoreUnreadableError` and runs nothing. If a record
  cannot be written the step is not acted on.
- **Resume.** A step recorded complete under the same `inputDigest` is skipped.
  One recorded complete under a different digest stops the run (`input-changed`,
  a `digest-mismatch` record, a `step-refused` report) and is never re-run.
  A step that was started but not recorded complete runs again, so a host entry
  point must be idempotent on the `idempotencyKey` it is given (`<key>@<digest>`).
- **Retry.** A failing step is tried up to `maxAttempts` times (default 3) with
  doubling backoff from `baseDelayMs` (1000) capped at `maxDelayMs` (30000),
  waiting through the clock port. When attempts run out, or the host throws
  `PermanentStepError`, a `step-failed` record carries the reason and the run
  stops. Calling again retries with fresh attempts.
- **Console.** Progress is reported after the matching record is durable. It
  carries identifiers, counts and a reason, never inputs. A report that fails
  does not stop the run; `reportFailures` counts them.

Ports (`src/executePorts.ts`): `hosts` (one `HostEntryPoint` per entry point,
given only the step's inputs, returns nothing), `state`, `console`, `clock`,
plus part 1's `approvals` and `register` reads. No step in the plan writes the
register, so there is no register write port.

Known limits: one executor per state file is assumed (there is no lock); a
missing state file reads as an empty history; host error messages end up in
the state file and the console, so adapters must keep secret values out of them.
