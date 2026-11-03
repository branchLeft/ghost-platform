# ghost-send-timeout.image.test.mjs

Ghost awaits a reader's transactional send inside the reader's own web request
(workspace#1952). Against a frozen mail spool, the request waits as long as
nodemailer's defaults allow: a 30 s greeting timeout and a 2 min connection
timeout.

## What the test proves

- The timeouts render from `render-core/src/environment.ts` into the demo
  golden: `connectionTimeout` 5000, `greetingTimeout` 5000, `socketTimeout`
  10000 ms (ghost-platform#485).
- The request reaches the mailer. The members API rejects a magic-link POST
  with 400 unless it carries the integrity token from
  `GET /members/api/integrity-token` (`verifyRequestIntegrity`, on by default),
  so the test fetches one first. The listener logs every accepted connection
  with its time, and the test fails if Ghost never dialled it.
- The built Ghost image, booted with those values, sends a sign-up magic link
  to a listener that accepts and never greets. The reader's request ends with
  status 500 within 15 s (`BOUND_MS`), the status Ghost's mailer gives a send
  failure (`createMailError` in `ghost-mailer.js`: an `EmailError` with
  `statusCode` 500), and not before the 5 s greeting timeout, so the timeout
  is what ended it.
- The negative control boots a second Ghost with the three timeout keys
  omitted, against the same listener. Its reader's request is still open at
  `BOUND_MS`, and the listener saw that Ghost dial in. The check stops 2 s
  after `BOUND_MS`, so the run does not wait for nodemailer's 30 s default.

## Why a listener, not `docker pause`

A paused spool holds its sockets open and sends nothing, so Ghost sees a
connected peer that never greets. A listener that accepts and stays silent
gives Ghost the same observation. This runs in CI with no spool stack.

## Sabotage

The negative control runs in CI on every build, so the keys' effect is shown
each time, not by a manual step. Without the keys, nodemailer keeps its 30 s
greeting default, so the untimed Ghost's request is still open at `BOUND_MS`.
Removing the keys from the golden also fails the positive test's first
assertion by name: `the golden renders mail__options__connectionTimeout`.

## Not proven here

- The live proof on the demo host (ws#1272) is a separate owner step.
- The CI run is the first execution of this file. Local runs need the pinned
  Ghost base image, which is not on the agent machine.
