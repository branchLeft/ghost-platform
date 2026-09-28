# test-drain-flag-dir-permissions.sh

## What this proves

Proves `demo-host/provision/drain_flag_dir.py`'s permission shape against
real uids in a real container, rather than against mocked chown/chmod
calls (`test_drain_flag_dir.py` covers the logic; this covers what the
bits actually permit): the broker account can create and remove flags, the
sidecar's own uid (1000, baked into the `node:*-bookworm-slim` base image)
can read and traverse the directory but never write to it, and a slot uid
gets exactly the same refusal -- proving the directory is not merely "not
broker" but genuinely nobody-else-writable.

Runs inside a throwaway container, never against the host or the runner,
because it creates system users and writes to a real filesystem path.
