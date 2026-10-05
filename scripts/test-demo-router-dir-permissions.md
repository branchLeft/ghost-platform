# test-demo-router-dir-permissions.sh

## What this proves

Runs `demo-host/provision/provision_socket_dirs.py` against real uids in a
throwaway container and shows the broker's account cannot rename the health
router's directory. The state root `/var/lib/branchleft` is root-owned 0755;
the broker owns only `/var/lib/branchleft/broker-slots`. So the broker can
write its slots file, but cannot rename or replace the router's directory, or
create anything beside it. `test_state_dirs.py` models the same ownership and
its root-only `RealUidTests` case runs here too, as root, dropping to the
broker's uid to try the rename.

Runs inside a throwaway container, never against the host or the runner,
because it creates system users and writes to a real filesystem path.
