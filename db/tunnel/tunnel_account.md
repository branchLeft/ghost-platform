# tunnel_account.py

## Module overview

The replica host's half of the replication tunnel. MySQL replication is
started by the replica, so the plain arrangement would have the tenant
database host dial into the org project, which the direction rule forbids.
Instead `db1` dials out with `ssh -R` and publishes its MySQL port on the
replica host's loopback. The replica connects to `127.0.0.1` and never leaves
its own machine. The `db1` half is `hetzner/provision/45-install-db-tunnel.sh`
and `branchleft-db-tunnel.service` in `branchLeft/shared-infra`.

This script creates the account `db1` logs in as, and nothing else. Run it as
root on the replica host:

```bash
python3 tunnel_account.py install --public-key-file <db1's tunnel public key> --from-address <db1's NAT egress IPv4>
```

`render-authorized-keys` and `render-sshd` print the two files without
touching the host, for review.

## What the one key may do

| Grant | Where it is enforced | Why |
|---|---|---|
| Listen on `127.0.0.1:13306` only | `permitlisten` on the key, `PermitListen` in sshd | the replica's source port; nothing else on the replica host may be published |
| Open `127.0.0.1:9104` only | `permitopen` on the key, `PermitOpen` in sshd | the replica's mysqld_exporter, read back to `db1` for monitoring |
| Run nothing | login shell `/usr/sbin/nologin`, `ForceCommand /usr/sbin/nologin`, `restrict` | the key holder gets no shell, pty, agent, X11 or user rc |
| Only from `db1`'s egress address | `from=` on the key | a copied key fails from anywhere else |

`permitlisten` is the option that limits `-R`. `permitopen` limits `-L`.
Both are needed: without `permitopen` the key could use the replica host as a
pivot into the tenant project, for example to its own MySQL port.

Every restriction is set twice, once on the key and once in a `Match User`
block, so either layer alone still refuses. The container proof shows this by
widening one layer at a time: the probes stay green, and only widening both
turns them red.

`AuthorizedKeysFile` points outside any home directory, at
`/etc/branchleft/db-tunnel/authorized_keys`, root-owned. The account has no
home and cannot change its own key.

## from_address

`db1` has no public interface. It reaches the internet through `edge1`'s NAT,
so the replica host sees `edge1`'s public IPv4. The key's `from=` names that
address. A private, loopback, link-local, carrier-grade NAT or multicast
address can never be it, so those are refused. One literal address only; no
CIDR, wildcard or negation. Documentation ranges (`203.0.113.0/24`) are
accepted because the container proof uses one.

## install

Idempotent. In order:

1. Create the system account with shell `nologin`, or confirm an existing one
   has that shell. An existing account with any other shell is refused rather
   than repaired, since it means something else created it.
2. Lock the password.
3. Write both files atomically. Unchanged files are not rewritten.
4. Run `sshd -t`. If sshd rejects the config, restore the previous files (or
   remove new ones) and stop, so a bad render never reaches a reload.
5. Reload ssh, only if something changed.
6. Read back `sshd -T -C user=dbtunnel,...` and compare every keyword with the
   rendered grant. The file on disk is not the claim; sshd's resolved value is.
   A drop-in sorting earlier, or a leaked `Match` block, would show here.
7. Print this host's ed25519 host key. `db1` pins it, so a changed key stops
   the tunnel rather than being trusted.

## Ports

`13306` and `9104` are fixed defaults, and `db1`'s unit names the same two
numbers. The replica's exporter must listen on `127.0.0.1:9104`. If the
replica host's build binds it elsewhere, change both sides together.
