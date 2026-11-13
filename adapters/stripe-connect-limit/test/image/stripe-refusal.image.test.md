# stripe-refusal.image.test.mjs

Boots two real Ghosts from the built image and shows that a demo slot cannot store a Stripe key by any
route, while the same requests are not refused for that reason when the host limit is off.

Run: `IMAGE=ghost-platform:ci node --test adapters/stripe-connect-limit/test/image/*.test.mjs`. Node
built-ins only, no install. `DEMO_COMPOSE_GOLDEN` names another Compose file to read the demo environment
from, so the test can be replayed against an older render.

## The two containers

- **Demo:** the `hostSettings__*` lines of `render-core/test/golden/demo.compose.yml`, which is what
  render-core renders for a demo. The test fails if that file has no
  `hostSettings__limits__limitStripeConnect__disabled` line.
- **Control:** the same image and the same lines minus that one key.

## Arms

| Arm | Route | Demo expects | Control expects |
|---|---|---|---|
| A | Connect token (`stripe_connect_integration_token`) | 403, `HostLimitError` (Ghost's own guard) | Ghost's key-format error |
| B | direct `stripe_secret_key` / `stripe_publishable_key` PUT | 403, `NoPermissionError`, the refusal text in `context` | Ghost's key-format error |
| C | content import carrying `stripe_secret_key` | the import job fails and rolls back whole | the job fails on the format check |
| D | admin tiers | a paid tier is still listed | not run |

Clearing a key (`null`) stays allowed. The key is never stored in any arm.

## Why arm C reads the log

Ghost runs a content import as a background job. The request answers 200 at once whatever the outcome;
a failure is logged ("[Background Job] site-content-import error") and mailed to the owner. So arm C waits for that
log line and reads the reason from it. Two imports run per container: one with only a marker tag (it must
appear, so an absent marker means something) and one with the marker tag plus a Stripe row (the marker must
be absent, proving nothing was partly applied).

## The refusal text

Read from the line the patch adds, so there is one home for it. Replacing the placeholder is an edit to the
patch and its pin only.

## Which failure arm C reads

The container log can hold more than one "[Background Job] site-content-import error". Arm C counts the failures
already logged before its import starts and reads the section of the next one, up to the failure after it
(`import-log.mjs`, tested without Docker by `import-log.test.mjs`). It does not read from the last
failure in the log to the end, so a later unrelated failure or a long log cannot change what it reads.
