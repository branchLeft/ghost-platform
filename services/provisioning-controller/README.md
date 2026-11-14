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
  carries identifiers, counts and a reason, never inputs. A report that fails,
  or that takes longer than `reportTimeoutMs` (default 2000), does not stop the
  run; `reportFailures` counts them. The wait is bounded so a slow console
  cannot stretch the time between the approval check and the host call.
- **Host error text.** Only the first 200 characters of a host's error message
  are kept, after anything shaped like a secret (tokens, key blocks, URL
  passwords, values of secret-named fields, long opaque runs) is replaced with
  `[redacted]` (`src/redact.ts`). This is a backstop: adapters still must not
  put secret values in errors, and the first real adapter needs its own test.
- **State file.** `FileStateStore` creates the file private (0600) and refuses,
  on read and on append, a symbolic link, anything that is not a regular file,
  and a file other users can reach (`StateFileUnsafeError`).
- **Approval id.** The ledger's answer must carry the approval id that was asked
  for; any other answer is treated as no approval.

Ports (`src/executePorts.ts`): `hosts` (one `HostEntryPoint` per entry point,
given only the step's inputs, returns nothing), `state`, `console`, `clock`,
plus part 1's `approvals` and `register` reads. No step in the plan writes the
register, so there is no register write port.

Known limits: one executor per state file is assumed (there is no lock); a
missing state file reads as an empty history; the state file has no integrity
check beyond its permissions (anyone who can write it as the same user can
append `complete` records, and a keyed check would need a secret this package
does not hold); the plan is computed once per call, so a register change during
a run reaches no step until the next call, where the digest check refuses any
step already complete under different inputs; the approval check and the host
call are never atomic, so a revocation that lands between them is seen at the
next check.

## Part 3: the provisioning API contract and its mock

`openapi.yaml` is the contract the customer portal and the owner console are
built against: read a demo, ask for the Essentials tier or open the Professional
enquiry, list the requests waiting on the owner, approve one, and read a
tenant. It is registered in `speckify.yaml` as `provisioning-api`. Nothing serves
it for real yet; the executor above is not wired to HTTP, and the real service is
a later waypoint's. The spec itself settles how a demo is named, the two
credentials, and what Approve records.

- **Generated client and server.** `src/generated/` is Speckify's output,
  committed as generated and never edited by hand. `scripts/assert-contracts-generated.py`
  fails a pull request whose tree is not what Speckify generates from the spec.
  To regenerate: `speckify build`, then
  `python3 scripts/assert-contracts-generated.py --write --contract provisioning-api .speckify/out`.
- **Importing it.** The built package exports the client and types as
  `ghost-platform-provisioning-controller/provisioning-api` and the typed
  `Handlers` interface with `createServer` as
  `ghost-platform-provisioning-controller/provisioning-api/server`. The portal
  links this package, and its image builds it.
- **The mock.** `mock/` is a hand-written, in-memory implementation of
  `Handlers`, served through the generated `createServer`, which checks every
  request and every success response against the spec. Its state is lost at exit.
  Start it from this directory, with test values of your own:

  ```sh
  pnpm install --frozen-lockfile
  pnpm run build
  MOCK_OWNER_CREDENTIAL=TEST_OWNER_CREDENTIAL \
  MOCK_TENANT_CREDENTIALS=11111111-1111-4111-8111-111111111111=TEST_TENANT_CREDENTIAL \
  pnpm run mock
  ```

  It listens on `127.0.0.1:8095` (`PORT`, `LISTEN_HOST`) and refuses to start
  without both credential variables. `MOCK_TENANT_CREDENTIALS` is a
  comma-separated list of `<tenant id>=<credential>`; each tenant starts with a
  `LIVE` demo. Presenting the tenant credential on the tenant's own paths,
  for example `GET /tenants/<tenant id>/demo` with `X-Tenant-Credential`, and the
  owner credential on `/promotion-requests` with `X-Owner-Credential`, walks the
  five operations. `mock/smoke.py` does exactly that against a running mock.
  Approving a request finishes provisioning at once (the tenant is `live`, with
  a placeholder invoice reference and hostname); `createMock({ settleOnApprove: false })`
  holds it at `provisioning` until `store.settle` is called.
- **What the generated server does not do.** It validates the path, query and
  body before any handler runs, so a request that is both invalid and
  unauthenticated is answered 400, not 401. It does not enforce
  `additionalProperties: false`: an unknown body field is dropped, never acted
  on. Only the success response is checked against the spec on the way out.
  Speckify 0.1.1 lets `beforeHandle` refuse a request with a declared status,
  which would move the credential check ahead of validation; this repository
  still runs 0.1.0.
- **Tests.** `contract/specAgreement.test.ts` compares the spec, the generated
  route table and the mock's handlers, and sweeps every operation with the
  right, the wrong and no credential, so a renamed route or an operation the mock
  lacks fails. `test/unit/provisioningMock.test.ts` runs the journey through the
  generated client.
