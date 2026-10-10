# break-glass-container.image.test.mjs

## Overview

Proves the containerised grant and expire tools against the built Ghost image.
The host wrapper and the expire unit's own `ExecStart` line are run for real,
with only the three host directories swapped for temporary ones, so the pinned
Node image, the options, the mounts and the Engine socket are the production
ones. The Ghost is real (SQLite, the real adapter and session middleware); the
timer answer is a `systemctl` stub, because there is no systemd here.

Usage: `IMAGE=ghost-platform:ci npm run test:image` in `adapters/sso`. Needs
Docker with the Node image already pulled (the wrapper never pulls).

## Cases

| Case | What it proves |
|---|---|
| status | The wrapper starts the tool in the pinned image and it reads the state directory. |
| timer not active | A grant is refused, no clock is written, the account is untouched and nothing is recorded. |
| anti-lockout | A tenant that deleted the support account gets it recreated, then opened, with a four-hour deadline and an opened record. |
| second grant | A grant for a tenant with one open is refused. |
| real session | A minted token opens a real session as the support account. |
| not yet due | The expire unit leaves a grant before its deadline, and the session still works. |
| past deadline | The expire unit re-suspends the account, destroys its sessions (purged twice), removes the state, writes the closing record, and the open session is dead. |
| revoke | The wrapper closes a grant at once, with no state file. |
| isolation | Run with the wrapper's own options, the container has only `lo`, no outbound connection, a read-only root, and still reaches the Engine socket. |

## Sabotage

A deliberate break of each control turns its named case red: the wrapper
always reporting the timer active, `expire` leaving a due grant open, the
tool skipping the recreate, and `--network none` removed from the options.
