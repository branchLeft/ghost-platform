# prove-replica-tunnel.sh

Builds the whole tunnel in throwaway containers and breaks each control. No
real host is touched. Needs Docker and a `branchLeft/shared-infra` checkout:

```bash
SHARED_INFRA_DIR=../shared-infra bash db/tunnel/prove-replica-tunnel.sh
```

Prints `ALL PASSED` last, or `PROOF FAILED: <step>` and exits 1.
`KEEP_ON_FAILURE=1` leaves the containers up for inspection.

## Topology

| Container | Stands in for | Network |
|---|---|---|
| `tunnelproof-db1` | `db1`'s MySQL, the pinned image with the committed `db/stack/conf.d/branchleft.cnf` unchanged | `10.20.1.20` on an internal network, plus `203.0.113.20` as its NAT egress |
| `tunnelproof-db1-client` | `db1`'s host: systemd, shares the MySQL container's network namespace, as the host network does on `db1` | same as above |
| `tunnelproof-dbt1` | the replica host: systemd and sshd | `203.0.113.30` only |
| `tunnelproof-replica`, `tunnelproof-exporter` | Percona replica and mysqld_exporter v0.20.0, in the replica host's namespace | same as above |

The replica host has no route to `10.20.1.20`, as in the real estate. The
installers are the real ones: shared-infra's `45-install-db-tunnel.sh` and its
unit run under real systemd, and this directory's `tunnel_account.py` runs
against real sshd.

## What it proves

1. `127.0.0.1:13306` on the replica host answers with `db1`'s MySQL handshake.
2. Socket listings on both ends show the only cross-network connection is
   `db1`'s outbound ssh.
3. Replication runs through the tunnel with TLS. `db1` sees the session come
   from `10.20.1.20`, its own address, so the source's replication account is
   `'<user>'@'10.20.1.20' REQUIRE SSL`.
4. The exporter's replica status is readable on `db1`'s `10.20.1.20:9105`.
5. Stopping the tunnel puts the IO thread in `Connecting` with
   `Seconds_Behind_Source` NULL, and the metrics forward stops answering. A row
   written during the outage arrives after it, so nothing is lost.
6. `SIGKILL` on ssh is restarted by systemd (`NRestarts` goes up).
7. The control cases, each green, then red under sabotage, then green again
   once reverted:
   - widen `permitopen` on the key only, then in sshd only: still green, as
     each layer holds alone. Widen both: red.
   - widen `permitlisten` on both: red.
   - give the account a login shell only, then remove `ForceCommand` only:
     still green. Both: red.
   - connect the replica host to `db1`'s network: the direct-dial probe goes red.

## Image notes

`SOURCE_IMAGE` defaults to the digest `db/RUNBOOK-db.md` pins (MySQL 8.0.46).
That digest's local copy is amd64; on an arm64 workstation without emulation,
set `SOURCE_IMAGE=mysql:8.0.46`, the same version. `REPLICA_IMAGE` is the
Percona 8.0.46-37 digest the promotion gate's proof used.

The lab containers run privileged with systemd as PID 1, which is the only way
to run the real unit. They exist for the length of the run.
