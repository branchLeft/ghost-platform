# image-harness.mjs

Shared plumbing for the image tests that boot the built Ghost image in the
required `docker build` job: the break-glass and provisioning tests in
`adapters/sso`, the scanning-storage tests in `adapters/scanning-storage`, and
the export re-import test in `services/export-bundler`. Node built-ins only, so
none of them needs an install. It has one home on purpose: those tests used to
carry nine copies of the port helper and four of the boot poll.

## What went wrong without it

Three different causes showed up as "a whole suite cancelled within a second".

1. **A lost promise.** `node:test` cancels every test below a `before` hook whose
   promise is never settled once the event loop has nothing left to wait for. The
   report is `cancelledByParent` with "Promise resolution is still pending but the
   event loop has already resolved", and no error naming the step. `runStep`
   gives every setup step a ref'd deadline timer, so such a step ends as a named
   failure (`setup step "<name>" did not settle in <n>ms`) instead.
2. **A port race.** Each test file asked the kernel for a free port by binding
   port 0 and closing, then handed the number to Docker later. The test files run
   as concurrent processes, so two of them (or one of them and a Docker
   allocation not yet bound) can be given the same port, and `docker run` fails
   with "port is already allocated" in a `before` hook. `reservePort` claims the
   port first.
3. **A Docker command that fails.** `dockerSync` names the step, the argv (with
   `-e` values redacted), the exit code and the first 400 bytes of stderr.

## Interface

- `reservePort()`: claims an unused port in 20000-29999 by creating
  `<tmpdir>/bl-image-test-ports/<port>` (atomic) holding the process id, checks
  that nothing is bound to it on 127.0.0.1, and releases it at process exit. A
  claim whose process is dead is reaped. The range is below the Linux and macOS
  ephemeral ranges and Docker's dynamic range. The port is known before
  `docker create` because Ghost's `url` has to carry it.
- `dockerSync(step, ...args)` and `docker(...args)` (step named after the verb).
- `runStep(name, fn, { deadlineMs })`.
- `pollHttp200(url, { containerName, deadlineMs, attemptMs, sleepMs, probe })`:
  returns `{ ok, detail }` and never throws. Each attempt has its own abort
  timer; a hung attempt is logged and the poll continues. `detail` holds the
  last error and the container's `Running` state.

## Self-test

`adapters/sso/test/image/image-harness.selftest.test.mjs` runs on every pull
request, needs no image and no Docker, and shows each failure mode red and then
green: a bare lost promise against the same hang inside `runStep`, the legacy
port probe against `reservePort` across concurrent processes, and a failing
`docker` against `dockerSync`.
