# render_broker_tunnel.py

## Module overview

The demo host's half of the broker tunnel. The control plane on ops1 calls the
demo broker (`services/broker/src/controlPlaneDemoBroker.ts`), and the broker
listens on `127.0.0.1:8090` on demo1 only. The owner's ruling `control=a`
settles the transport: ops1 dials demo1 over SSH and holds an `ssh -L`
forward to that one port. Port 22 on demo1 is open to edge1's address only,
and ops1 leaves the estate through edge1's NAT, so the firewall decides where
a connection may come from. This program decides what the connection may do.

It renders two files and checks one. It writes nothing on a host: the
`demo1_build` role in `branchLeft/shared-infra` installs the account and the
two files, and carries golden copies of this program's output.

```bash
python3 render_broker_tunnel.py authorized-keys --public-key-file ops1-broker-tunnel.pub
python3 render_broker_tunnel.py sshd
python3 render_broker_tunnel.py check-authorized-keys /etc/ssh/branchleft-broker-tunnel/authorized_keys
```

## What the one key may do

| Grant | Where it is enforced | Why |
| --- | --- | --- |
| Open `127.0.0.1:8090` only | `permitopen` on the key, `PermitOpen` in sshd | the broker; nothing else on demo1 may be reached |
| No reverse forward | `restrict` on the key, `AllowTcpForwarding local` and `PermitListen none` in sshd | the demo host never publishes anything on ops1's side, or its own |
| Run nothing | login shell `/usr/sbin/nologin`, `ForceCommand /usr/sbin/nologin`, `restrict` | no shell, pty, agent, X11 or user rc |

The account is `brokertunnel`, a locked system account with no home. Its
`AuthorizedKeysFile` is `/etc/ssh/branchleft-broker-tunnel/authorized_keys`,
root-owned, so the account cannot change its own key. The drop-in is
`/etc/ssh/sshd_config.d/50-branchleft-broker-tunnel.conf` and ends with
`Match all`.

Every restriction is set twice, once on the key and once in sshd, so either
layer alone still refuses. `expected_effective()` lists the thirteen settings
`sshd -T -C user=brokertunnel,...` must report; the installer reads them back.

`check-authorized-keys` passes a file only when it holds exactly one key whose
options are `restrict,port-forwarding,permitopen="127.0.0.1:8090"`, in that
order and no others, before a well-formed ed25519 key.

## The proof

`prove_broker_tunnel.py` runs in a throwaway Debian container
(`.github/workflows/demo-host-broker-tunnel-ci.yml`) against a real OpenSSH
server. A stand-in broker answers on `127.0.0.1:8090` and a second listener on
`127.0.0.1:8091`. For each case it installs the files, checks `sshd -t` and
the effective settings, and runs six probes: a `-L` to the broker reaches
`/status`; a `-L` to `8091` and to `22` gets nothing; a command gets no shell;
a `-R` is refused; and the installed file passes `check-authorized-keys`.

| Case | Expected red |
| --- | --- |
| the grant as rendered | none |
| `permitopen` widened on the key only | the file check (sshd still refuses) |
| `PermitOpen` widened in sshd only | none (the key still refuses) |
| both widened | the `8091` and `22` forwards, and the file check |

The run passes only when every probe gives exactly its expected result, so a
probe that cannot go red fails the proof.

## When the tunnel is down

The broker's callers see a refused connection on the local end, which
`controlPlaneDemoBroker.ts` reports as `unanswered` (reconcile, reset) or
`undefined` (status). No call reaches any other host instead.
