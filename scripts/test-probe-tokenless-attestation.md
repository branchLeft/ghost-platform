# test-probe-tokenless-attestation.sh

## What this does

Proves the placeholder probe refuses what it should, offline. A stub `gh` on
`PATH` decides each call from files beside it, because the probe runs gh under a
scrubbed environment that drops variables the test sets.

Each case asserts the exact text of the assertion it should trip:

| Stub mode | Expected result |
| --- | --- |
| `needs-token` | `verification needs a GitHub token` |
| `accept-all` | `forged digest accepted: the probe is vacuous` |
| `fault-forged` | `forged digest refused by a fault, not by identity` |
| `identity` | exit 0, `VERIFIED with a placeholder GH_TOKEN; no GitHub API call observed`, forged refused with neither a token need nor a fault, gh saw only the placeholder |
| `api-call` | exit 0, the logged `api.github.com` call is counted and the "no GitHub API call" wording is absent |

The test exports `GH_TOKEN` and `GITHUB_TOKEN` itself. The stub accepts
anything when a real token reaches it, so a probe that did not scrub the
environment fails the green case. Like the real gh, the stub refuses to run with
no `GH_TOKEN` at all, so a probe that dropped the placeholder fails the green
case on the token-need assertion. The stub also prints TUF debug text, as the
real gh does, so a probe that read debug text as a verdict fails.

Run it with `./scripts/test-probe-tokenless-attestation.sh`. It needs no network.
