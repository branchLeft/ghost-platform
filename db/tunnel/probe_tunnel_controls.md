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
bash probe_tunnel_controls.sh direct-dial --target 10.20.1.20:3306
```

Passes when a TCP connection to the target is not accepted within 10
seconds. `10.20.1.20` is `db1`'s private address and the only one mysqld binds.
This is the replica dialling `db1` itself, which the direction rule forbids.
It must fail at the network, not merely be discouraged.
