# test-probe-tokenless-attestation.sh

## What this does

Proves the token-less probe refuses what it should, offline. A stub `gh` on
`PATH` decides each call from files beside it, because the probe runs gh under a
scrubbed environment that drops variables the test sets.

Each case asserts the exact text of the assertion it should trip:

| Stub mode | Expected assertion |
| --- | --- |
| `needs-token` | `verification needs a GitHub token` |
| `accept-all` | `forged digest accepted: the probe is vacuous` |
| `fault-forged` | `forged digest refused by a fault, not by identity` |
| `auth-visible` | `probe environment is not token-less` |
| `identity` | exit 0, `TOKENLESS VERIFY OK`, forged refused for its identity, no token seen |

The test exports `GH_TOKEN` and `GITHUB_TOKEN` itself. The stub accepts
anything when a token reaches it, so a probe that did not scrub the environment
fails the green case.

Run it with `./scripts/test-probe-tokenless-attestation.sh`. It needs no network.
