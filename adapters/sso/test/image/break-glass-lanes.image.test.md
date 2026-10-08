# break-glass-lanes.image.test.mjs

## Why this test exists

ISSUE branchLeft/workspace#1245's "Done means", against a real Ghost at the
pinned version. Each case below runs the real code:

- the minter CLI, run as `ops1` runs it: in the pinned Node image, with no
  network, and with the key directory mounted read-only at
  `/etc/branchleft/break-glass`;
- the grant library, against a container found by its Compose labels, through
  `docker exec` and Ghost's own knex;
- Ghost's session middleware with the break-glass adapter.

| Case | Proves |
|---|---|
| lifetime | the minter refuses `--ttl 601`, a token carries `exp - iat = 600`, and the audit holds the `jti` but never the token |
| key mode | the minter refuses a key readable by others |
| suspended at rest | a valid token opens nothing |
| consented, not un-suspended | the grant is refused and no clock is left |
| incident | a deleted account is recreated; at the deadline the timer's `expire` kills the open session, and a fresh token is refused |
| requirement 2 | the timer purges a session left behind when the tenant re-suspended early, so nothing wakes when they un-suspend |
| requirement 1 | a session written between the two purges is removed |
| Owner | a grant naming the Owner is refused, and the Owner stays active |
| requirement 5 | a token minted before a Ghost restart is refused after it |
| key rotation | after the public half in the config changes, the old key's token is refused and the new key's is accepted |

The clock is injected, so the four-hour deadline is reached without waiting.
The systemd timer itself is not run here, because there is no systemd in the
test. `grant`'s refusal without an active timer is unit-tested.

## Usage

```sh
IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
```

`NODE_IMAGE` overrides the minter's Node image.
