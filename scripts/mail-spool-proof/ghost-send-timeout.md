# ghost-send-timeout.image.test.mjs

Ghost awaits a reader's transactional send inside the reader's own web request
(workspace#1952). Against a frozen mail spool, the request waits as long as
nodemailer's defaults allow: a 30 s greeting timeout and a 2 min connection
timeout.

## What the test proves

- The timeouts render from `render-core/src/environment.ts` into the demo
  golden: `connectionTimeout` 5000, `greetingTimeout` 5000, `socketTimeout`
  10000 ms (ghost-platform#485).
- The built Ghost image, booted with those values, sends a sign-up magic link
  to a listener that accepts and never greets. The reader's request ends with
  a status of 400 or more within 15 s (`BOUND_MS`), and the listener saw Ghost
  dial in.

## Why a listener, not `docker pause`

A paused spool holds its sockets open and sends nothing, so Ghost sees a
connected peer that never greets. A listener that accepts and stays silent
gives Ghost the same observation. This runs in CI with no spool stack.

## Sabotage

With the three keys removed from the golden, the first assertion fails by name:
`the golden renders mail__options__connectionTimeout`. Without them, nodemailer
keeps its 30 s greeting default, and the reader's-request assertion fails with
an elapsed time past 15 s.

## Not proven here

- The live proof on the demo host (ws#1272) is a separate owner step.
- The CI run is the first execution of this file. Local runs need the pinned
  Ghost base image, which is not on the agent machine.
