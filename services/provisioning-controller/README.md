# provisioning-controller

The tenant provisioning controller's core, in two halves, and the command that
runs it (see "Running it"). Every side effect is a port. The programs that
serve the host entry points, the console adapter and the portal register
adapter are not here: today the command starts whatever programs a deployment
names, reads approvals and the register from files, and writes progress to
standard error.

## Part 1: planning

`planOnboarding(approvalId, ports)` returns an ordered, typed plan of every
onboarding step from one recorded owner approval and the tenant register. It
executes nothing and writes nothing.

- A tenant's owner account is created before its hostname is published: the
  edge step (`publish-hostnames`) depends on `create-owner-account`, which
  depends on the first deploy, so a fresh Ghost's setup route is never
  reachable at a published hostname by a first visitor. A failed owner step
  stops the run before the edge is asked to publish anything.
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

### The app host's tenant entry point (`src/tenantEntryHost.ts`)

`TenantEntryHost` is a `HostEntryPoint` for the app host's forced command (the
`tenant_entry` role in branchLeft/shared-infra holds its verbs, order and exit
codes). It serves four steps and passes every other step to a fallback entry
point, so the owner's single approval is the only hand step for a new tenant:

| Step                   | Verbs sent                                                         |
| ---------------------- | ------------------------------------------------------------------ |
| `render-host-secrets`  | `claim`, then `secrets`                                            |
| `render-compose-file`  | `stack`: three parameters (`size`, `mail`, `environment`) only     |
| `create-app-host-slot` | `enable`, then `key`                                               |
| `create-owner-account` | `owner`: `colour`, `name`, `site_url`, `site_title` only           |

- **Parameters, not text.** The host builds the compose file from its own
  template, the claim's uid and ports and these parameters, and judges it. The
  adapter sends exactly `size`, `mail` and `environment` (a literal, or a
  `{ secret: NAME }` reference to a key of the secrets file); it picks those
  three fields, so nothing else a provider returns is sent. It never sends
  compose text and never an image pin: the first pin is written by
  `branchleft-deploy` after it verifies the image's attestation, in the plan's
  `first-deploy` step, which runs after `create-app-host-slot`.
- **The host's claim.** `status` carries the uid and ports `claim` gave the slug.
  `TenantEntryInputs.stack` is given them, and `claimOf(slug)` returns them to
  any deployment step that needs the host's numbers (they are not the
  register's).
- **Plan order.** `render-compose-file` depends on `render-host-secrets` and
  `create-app-host-slot` depends on it, so a unit is never enabled before its
  compose file is in place. `status`'s `stack=yes` means the compose file alone.
- **The owner.** `create-owner-account` runs after the first deploy, so a colour
  is running, and before the edge publishes a hostname. The host's own script
  makes the Ghost owner from the address in the tenant's secrets file on the
  host. The controller reads that address in one place only, the secrets step
  (`GeneratedTenantEntryInputs`, from the secrets file's `literals`), and sends it
  once, on the standard input of the host's secrets verb; it is held in no field
  and written to no log, state record or file, and a host message that quotes an
  address is masked. The owner step never sees it: its request carries a display
  name, the site's address and title, and a colour (the
  owner is in the tenant's one database, so either colour does). The adapter
  refuses, before sending, anything the host's own patterns would refuse. A
  unit not yet enabled with its secrets and stack is a permanent stop; a colour
  not yet running (`container-not-running`) and a failed script (a host with no
  owner script says `failed: program-missing`) are retried, then the step is
  recorded failed and the edge step never runs. A second request, after a lost
  reply, is answered by the script as already set up; a Ghost claimed by a
  different address fails the step. Any email-shaped text in a host's message is
  replaced with `[address]`.
- **Idempotent.** Each step first asks `status` and sends only what is left, so
  a resume or a retry after a lost reply sends nothing twice. The host also
  accepts the same `stack` parameters again.
- **Errors.** A refusal (exit 1) is a `PermanentStepError` naming the verb and
  the host's word, with the host's sentences as detail; a usage error (2) is
  permanent; busy (3), a failed step (4) and an unknown code are retried. Values
  the request carried are withheld from any detail.
- **Inputs and transport are ports** (`TenantEntryInputs`, `EntryTransport`):
  the template, values, parameters and deploy key come from the deployment;
  none is kept.

### The database host's entry point and the hand-over (`src/dbEntryHost.ts`, `src/dbHandOver.ts`, `src/generatedSecrets.ts`)

`DbEntryHost` serves the plan's `create-database` step over the same ssh transport, to db-t1's
forced command (the `db_t1_tenant_entry` role in branchLeft/shared-infra). It sends `create-tenant-db
NAME` (the only request that program accepts) and reads the three lines it prints once
(`database=`, `user=`, `password=`). No person is in the path: the password goes from that reply to
the app host's secrets file by the controller alone.

- **Exit codes.** 0 created; 2 a refused request, permanent; 3 `exists`, permanent (and it says
  that no copy is held here, which is the one case a person has to clear on db-t1); 4 busy and 5
  failed, retried; any other code retried.
- **The hand-over.** db-t1 prints the password once and refuses a second create, so a crash between
  the create and the `secrets` verb would lose it. `FileDatabaseHandOver` holds it for that window
  in one file per slot, `db-handover-SLOT.json`, in `dbEntry.handOverDir` (the controller's own
  state directory): mode 0600, owned by the controller's user, one link, opened without following a
  link; the directory may not be written by group or other, nor reached by other. It is written the
  moment the reply is read (a temporary file, synced, then linked in, so it never exists half
  written and is never replaced), and discarded once the app host has the secrets file in place
  (just written, or found already there). Startup refuses a directory that is not usable.
- **Resume.** A `create-database` step run again finds the copy and sends nothing, so a crash
  between the create and the secrets, or before the step was recorded, completes without a second
  create.
- **The other secrets.** `GeneratedTenantEntryInputs` fills the render core's template at the
  `secrets` step: `GHOST_DB_PASSWORD` from the hand-over; the object-store keys as generated
  placeholders marked `placeholder-not-a-credential-` (the slot boots and uploads are refused until
  the storage gateway issues real keys); `GHOST_OWNER_EMAIL`, which is not a secret, from the
  secrets file's `literals`; every other key from the operating system's random source. Values go
  to the host on the verb's standard input and are kept nowhere. A typed value for any key the
  controller fills itself is refused, and so is a `values` section in the secrets file.
- **No value in a log.** Nothing here writes a log line. The adapter's errors are fixed text and a
  fixed reason code; `redactSecrets` stays as the backstop. `test/unit/dbHandOver.test.ts` runs the
  whole plan with a scan of the output, the state file, the console events and every file under the
  working directory for the password and each generated value, and checks that the scan finds one
  put there on purpose.
- **Configuration.** `dbEntry` is required with `sshEntry`: `target` (the db host's account and
  address) and `handOverDir`. The key, pinned known-hosts file, hops and limits are `sshEntry`'s.

Known limits: the SSH transport and its file-based inputs are wired (see "Running it"), but
something must still write those files on the controller host; `publish-hostnames` still takes
its port from the register, not from the claim (`claimOf` is the way a
deployment's edge step reads the host's number); the first deploy goes through the
fallback. The host needs the owner script and node installed before the `owner` verb
works; until a role does, the step is recorded failed as `program-missing`.

## Part 3: the provisioning API contract and its mock

`openapi.yaml` is the contract the customer portal and the owner console are
built against: read a demo, ask for the Essentials tier or open the Professional
enquiry, list the requests waiting on the owner, approve one, read a
tenant, and hold every contact request as a ticket the owner moves through its
lifecycle. It is registered in `speckify.yaml` as `provisioning-api`. Nothing serves
it but the service in Part 4; the executor above is not wired to HTTP. The spec itself settles how a demo is named, the two
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
  demo and promotion operations. `mock/smoke.py` does exactly that against a running mock.
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

## Part 4: the real service

`src/service/` is the contract served for real: the generated `createServer`
over the same rules the mock has (`src/service/store.ts`, which the mock also
uses), with these differences. The mock is for tests and is not in the image;
the service is.

- **Credentials are files, read on every call.** `PROVISIONING_OWNER_CREDENTIAL_FILE`
  holds the owner console's credential; `PROVISIONING_TENANT_CREDENTIALS_FILE`
  holds lines of `<tenant uuid>=<credential>`, the file format the portal reads
  (`PORTAL_PROVISIONING_CREDENTIALS_FILE`), so one file can serve both. A credential under 16
  characters, a credential shared by two tenants or equal to the owner's, an empty or
  malformed file or a missing one means no credential is valid: every call answers 401
  and the problem is logged as a code, never a value. A credential the owner places or
  changes takes effect on the next call. The checks are `src/service/auth.ts`: a tenant
  credential on an owner call, the owner's on a tenant call and one tenant's on another's
  path are each 403, and nothing a tenant presents lets it past its own paths.
- **Tenants come from a register of demos** (`PROVISIONING_DEMOS_FILE`): `{"demos":
  [{"tenantId", "demoId", "address", "state", "expiresAt"}]}`, written by the owner's tooling,
  never in the repository, refused if other users can write it, and looked at again
  whenever the file changes. Until a tenant is promoted its demo is what the register says;
  after, the service's own record is. A database adapter for the demo register is later work.
- **State survives a restart.** `PROVISIONING_STATE_DIR` holds `state.json` (replaced whole by
  a rename after the new content is on disk, mode 0600, refused at start if damaged,
  linked or readable by others) and `approvals.json`, the approval ledger in the shape
  `FileApprovalLedger` reads, so the executor can be given an approval the console recorded.
  A change that cannot be written down is undone and answered 500.
- **Tickets: every contact request, at every tier.** The state holds a `tickets` list beside
  the requests (a state file written before it existed starts with none). A ticket has a kind
  (`essentials`, `professional-enquiry` or `support`), the contact address and message the
  tenant gave (null for an Essentials request, which has no form), and a state: `new`, `open`,
  `replied` or `closed`, with every change kept in its `history`. An Essentials request or an
  enquiry made through `createPromotionRequest` records its ticket in the same change, a
  replay records none; the portal records a support ticket or a Professional enquiry with
  `createTicket` after it has sent the mail, which stays the delivery. The owner lists them
  with `listTickets` (filter by `state` and `kind`, oldest first) and moves one with
  `moveTicket`. The lifecycle is `src/service/ticketLifecycle.ts`: from `new` to `open`,
  `replied` or `closed`; from `open` to `replied` or `closed`; from `replied` to `open` or
  `closed`; from `closed` to `open`; never back to `new`, and a move to the state a ticket is
  in is refused. Any refused move is 409 `illegal-transition` and changes nothing. A tenant
  may hold 50 tickets that are not closed (409 `ticket-limit`). Approving a request does not
  move its ticket: the owner does.
- **Approve starts the move and does not finish it.** The tenant is `essentials` in state
  `provisioning` and the demo is `PROMOTING` until the executor, which is not wired to this
  service, says otherwise. `invoice_ref` stays null until something raises the invoice.
- **Run it** from this directory after `pnpm run build`, with the four paths and
  `LISTEN_HOST` (loopback by default; the container sets `0.0.0.0` and publishes no
  port): `PROVISIONING_STATE_DIR=... PROVISIONING_DEMOS_FILE=... pnpm run service`. It
  answers `GET /healthz` with no credential. `contract/smoke_service.py` does this
  from files of its own, walks the journey, restarts it and checks it kept its state.
- **Seen on the real portal** (the done check of a private tracker item): sign in to the
  tenant portal as a demo tenant's admin; `/demo` shows the register's address and
  state; `/essentials` asks and shows pending; in the owner console `/requests` lists the
  request and Approve takes it off the queue; the portal's `/site` then shows `provisioning`
  and the tier; a second Approve changes nothing. The service's log shows no problem code.
- **Not here**: the host programs the executor runs, wiring the executor to an approval,
  settling a tenant to `live`, and a source for the register other than a file.

## The SSH transport to a tenant host

`SshEntryTransport` (`src/sshEntryTransport.ts`) is the real transport behind a host
adapter's `EntryTransport` port: `send(verb, slug, payload?)` runs one ssh client, which
runs the host's forced command `VERB SLUG` once, with the payload as one JSON object on
standard input. It is selected for the app host only when the configuration has an `sshEntry` section (below).

- **Argument vector only.** `child_process.spawn` with `shell: false`; the verb is checked
  against a closed list and the slug against the register's slot pattern before a process
  starts. `BatchMode=yes` and `StrictHostKeyChecking=yes` are fixed, the only known-hosts
  file is the pinned one, `-F` always names a file (`/dev/null` unless configured).
- **Configuration, never a request.** Key file, known-hosts file, ssh config file, the jump
  chain (the controller runs on ops1, so the hops are edge1 and edge-t) and the target account and host come from `SshEntryConfig`;
  every path and name is validated when the transport is made.
- **Bounded.** A timeout kills the client; each output stream has a byte bound that kills
  it too; the payload has one. The client inherits only `PATH`, `HOME` and `LANG`.
- **Result.** The host program's own exit code and streams are returned for the adapter to
  map (0 done, 1 refused, 2 usage, 3 busy, 4 failed). A call that never reached the program
  is thrown: `SshTransportError` (retryable: timeout, connection, signal) or
  `SshTransportRefusedError`, a `PermanentStepError` (bad request, client cannot start,
  host key not matching the pin, output over the bound). Remote text is never put in an
  error message.
- **Hops need an ssh config file.** ssh takes a hop's key and host-key settings from its
  config file, not from the command line, so a configuration with `jumpHops` and no
  `sshConfigFile` is refused (`invalid-config`), as is one with no `jumpHops` list at all.
  `hopConfigProblems(config)` asks the real client (`ssh -G`) what it applies to each hop and
  names any setting that is not strict host keys, batch mode, the pinned known-hosts file
  alone, identities only and the key; `composeHostPorts` runs it at startup and refuses to start on any problem.
- **Argument vector.** `-F CONFIG -o BatchMode=yes -o StrictHostKeyChecking=yes
-o UserKnownHostsFile=KNOWN -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes
-o ForwardAgent=no -o ClearAllForwardings=yes -o LogLevel=ERROR -o ConnectTimeout=N -T
-i KEY [-p PORT] [-J HOPS] USER@HOST VERB SLUG`; the payload is one JSON object on standard
  input. Each `send` runs exactly one client, which runs the host's forced command once.
- **Not here**: the key and known-hosts files themselves.

## Running it

`node dist/bin.js --config <file> --approval-id <id>` runs one approval to done
or to the step that stopped it. The approval id is the only per-run input.

- **Configuration** (`src/runConfig.ts`): absolute `stateFile`, `approvalsFile`
  and `registerFile`; `hosts`, a map from entry point to `{ argv, timeoutMs? }`;
  optional `sshEntry`, `retry` and `reportTimeoutMs`. A key it does not know is refused.
  `argv[0]` must be an absolute path: the program is started directly, never
  through a shell and never found on the path.
- **SSH entry point** (`src/sshEntryConfig.ts`, `src/composeHostPorts.ts`): off unless the
  configuration has an `sshEntry` section, and it has no default host, key path or hop. It names
  `keyFile`, `knownHostsFile`, `jumpHops` (empty for a direct host), `target` and `inputs`, and optionally
  `sshConfigFile`, `sshProgram` and the transport's limits; every value is checked as the
  transport checks it. When present, startup asks `ssh -G` about each hop and refuses to run
  (exit 3, no step started) on any hop that is not pinned, and when the deployment supplies no
  inputs builder (`CliIo.tenantEntryInputs`; `bin.ts` supplies `FileTenantEntryInputs`). The app
  host is then the tenant entry adapter over the ssh transport; the program configured for
  `app-host` serves the steps it does not.
- **Tenant entry inputs** (`src/fileTenantEntryInputs.ts`): `sshEntry.inputs` names three
  absolute paths, with no default: `secretsFile` (`{ "template", "literals": { SLOT: { NAME:
  VALUE } } }`: key names and non-secret values only; no secret is ever written there), `stackFile`
  (`{ SLOT: { size, mail, environment, owner? } }`, where `owner` is `{ name, siteTitle, colour? }`,
  read only by the owner step, and the site address it sends is the stack's own `environment.url`)
  and `deployKeyFile` (`{ SLOT: PUBLIC_KEY }`). Each is opened without following a link and refused unless it is a
  regular file under 1 MiB, owned by root or the controller's user, with no group or other
  write; the secrets file is also refused if others can read it (a group may). Each file is read
  when a verb needs it and kept never. An error names the path, the slot and the field, never
  anything the file held, and not the parser's message.
- **Trusted files** (`src/trustedFile.ts`): the configuration, the approvals
  file (`{ "approvals": [...] }`) and the register file (`{ "entries": [...] }`)
  are refused unless they are regular files, not links, owned by the user the
  controller runs as, and not writable by group or others. Whoever can write the
  approvals file can approve onboarding. Approvals and the register are read
  again on every check, so a withdrawal is seen at the next one.
- **Host programs** (`src/commandHost.ts`): each is started with the step as
  one JSON object on standard input (`key`, `id`, `idempotencyKey`, `inputs`),
  and only `PATH`, `HOME` and `LANG` from the controller's environment. Its
  output is discarded unread. Exit 0 is success, exit 3 is permanent, anything
  else, a signal or a timeout is retried. An entry point with no program fails
  its step at once and acts on nothing.
- **Result**: one JSON line on standard output; one JSON line per progress
  event on standard error. Exit status: 0 complete, 1 stopped at a step, 2 the
  approval refused the run, 3 bad arguments or configuration, 4 anything else
  (an untrusted or unreadable file, an unreadable state file, a bad retry
  policy).
- **Not here**: the host programs themselves, the console and register
  adapters, and how the command is started and kept on a host. One run per
  state file at a time is still assumed.
