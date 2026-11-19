# demo-tier-gates.ts

## What it is

The demo tier's refusal, hold and age gates, written once as assertions, and run
by `../unit/demo-tier-gates.test.ts` through the real entry file Ghost loads,
the real decorator, the real unix-socket transport and the real host end of the
verdict channel (`../../verdict-host/`). A stand-in for the safety service
dials in on the inbound side, signing its requests as the contract says. The
decorator is configured as a demo is: `tier: demo`, `verdictSource: production`
and a local (no bucket) wrapped adapter.

## The assertions

Each is a `must(id, ...)` call. A failed one throws `GateFailure` naming its id.

| Id | Proves |
| --- | --- |
| `refusal.upload-refused` | after the service has answered the test-classification hash as a match, an upload of those bytes is refused with the typed 415 |
| `refusal.nothing-served` | neither that upload nor the one held before the answer is served, as an original or at a size |
| `refusal.nothing-stored` | the wrapped adapter holds no file at all |
| `hold.upload-accepted` | with the service not draining, or the host end stopped, the upload succeeds and returns a URL |
| `hold.original-not-served` | that URL serves nothing |
| `hold.size-request-empty` | a responsive-size request returns nothing and writes no derivative |
| `hold.stays-withheld` | still true after several retry rounds |
| `hold.promoted-on-clean-verdict` | once the service answers clean, the same size request returns the image |
| `age.grows-while-undrained` | `verdict_host_oldest_unverdicted_age_seconds` grows while nothing drains |
| `age.carries-across-restart` | it does not reset when the host end restarts |
| `age.returns-to-zero` | it is zero once the verdict is in |

## Every assertion has a case that must fail

Each id has a control in the test file: the same assertion run against a broken
setting (a slot with no scanning, a service that answers clean, a leak written
into the wrapped adapter at the phase the assertion watches, a journal deleted
before a restart). The control passes only if the assertion went red at that
exact id. `registry` records which ids have passed and which have been seen
red, and the last test in the file fails if any id lacks either.

Beyond these in-test controls, the gates were run red against the real source
(see the pull request): the production client stops recognising the test
classification, an unavailable answer is read as clean, the host end's age is
pinned to zero, and the host end does not settle a test match. Each turns the
suite red at the assertions above, and restoring the file turns it green.

## What is substituted, and why

**The hash stage.** The adapter's key is still a SHA-256 hex stand-in
(`../../src/pdq.js`), and the host end refuses anything that is not a 32-byte
perceptual-hash key, so on the real channel today the real key can only be held.
The harness replaces that one function with a map from each fixture to a key of
the right shape. Nothing else is replaced. `the substituted hash stage` in the
test file goes red the day `pdq.js` stops being the stand-in: delete
`loadEntryAdapter`'s substitution and run the gates on the real hash.

**Ghost.** The wrapped adapter is the suite's directory-free fake, and
`Slot.sizeRequest` follows Ghost's responsive-size route (serve a derivative
that exists, else read the original, resize and write; no original, nothing).
That the real route behaves so against a real Ghost is proven by
`../image/scanning-storage.image.test.mjs`; this harness does not start Ghost.

**The test-classification hash.** The real safety service holds the real one.
Here the fixtures are synthetic bytes, and the stand-in service decides which
of them it answers as a match.

## Not covered

- A run on a live demo host's first slot, over the real service and the hash
  source. That needs the host, the service and the adapter's real hash, and is
  a delivery step, not this file.
- The estate's Prometheus scraping the age. The series is read from the host
  end's own renderer, which is what the textfile it writes is made of.
- `video` and `audio` on the demo tier (`../unit/tier-policy.test.mjs`).
