# probe_tunnel_controls.sh

The tunnel's control cases as probes anyone can rerun, on the hosts or in the
container proof. Each prints `PASS` or `FAIL`; the script exits 1 if any
fails, and prints `GREEN` or `RED` last.

## key-holder (run on db1, as root)

```bash
bash probe_tunnel_controls.sh key-holder --host <replica IPv4> \
  --key /etc/branchleft/db-tunnel/id_ed25519 \
  --known-hosts /etc/branchleft/db-tunnel/known_hosts
```

It uses the tunnel's own key, so it tests exactly what `db1` holds.

| Probe | Passes when | Proves |
|---|---|---|
| `no-shell` | the key authenticates and nologin refuses the command | the key cannot run anything |
| `listen-elsewhere` (twice) | `-R 127.0.0.1:13307` and `-R 0.0.0.0:13308` are refused | the key cannot publish any other port |
| `open-elsewhere` | `-L` to the replica host's own `127.0.0.1:22` is "administratively prohibited" | the key cannot forward to anything else |
| `open-allowed` | `-L` to `127.0.0.1:9104` is not prohibited | the control for `open-elsewhere` |

`no-shell` also checks that the key authenticated. A key that fails to log in
also never runs a command, and would otherwise read as a pass.

`open-elsewhere` targets port 22 because sshd always listens there. A
refusal therefore comes from the forwarding rule, not from an empty port.
`open-allowed` shows the probe can tell the two apart.

Run it while the tunnel is up: it opens its own sessions and uses local port
`23306` on `db1`, which the tunnel does not use.

## direct-dial (run on the replica host)

```bash
bash probe_tunnel_controls.sh direct-dial --control <control host:port> \
  --target 192.0.2.20:3306
```

The control is a port the operator supplies, known to accept TCP connections
from this host. The script dials it first. A successful connect shows this host
can open TCP connections to that address, so a refused or timed-out target is
not just a probe that could not dial at all. It does not prove the route to a
target on a different network. A control on the probing host itself proves only
its local TCP stack. Choose a control on the same network as the target where
such a host exists. For a target on a network this host is deliberately cut off
from, there may be none, and the control then proves only that the dial works.
The control must not be the same `host:port` as any target. The script does not
check this, but a control equal to a target would simply read as a FAIL.

Each `host:port` (control and every target) must have a host of letters,
digits, `.`, `-` and `_`, non-empty, with no IPv6 literals, and a port of
decimal digits from 1 to 65535. Anything else exits 2 before any dial.

`PROBE_DIAL_TIMEOUT` sets the timeout for each dial, in seconds. It defaults to
10 when unset or empty. A set value must be a positive decimal such as `2` or
`0.5`. Zero, negative numbers, `.5`, exponent forms and text exit 2, and the
message names `PROBE_DIAL_TIMEOUT`.

The probe passes a target only when the control connected and the connection to
the target is not accepted within the timeout. If the control does not connect,
every target reads FAIL as inconclusive, and the exit is 1.

`192.0.2.20` is the database host's private address and the only one mysqld binds.
This is the replica dialling `db1` itself, which the direction rule forbids.
It must fail at the network, not merely be discouraged.
