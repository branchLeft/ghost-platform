# branchleft_demo_isolation_probe.py: isolation probe for one demo slot

Issue: branchLeft/workspace#4045, part of #3814 (demo isolation). Design: ghost-platform-docs
`19-try-it-now-design/02-broker-and-slot.html` and `00-high-level-design.html`.

## What it does

Run from inside one demo slot's network namespace, as that slot's own uid, it tries every route
the slot must not have and prints one line per route:

- `REFUSED <route>`: the connection did not open (a refusal or a timeout);
- `REACHED <route>`: the connection opened. Any `REACHED` exits 1.
- `UNCHECKED <route>: <reason>`: the route could not be tried, so it proves nothing. Any
  `UNCHECKED` exits 2. A path that does not exist is `UNCHECKED`, never a pass.

Network routes: the other slot's ports (Ghost, health router, sidecar) on loopback and on the bridge
gateway; the host's own services on the gateway (`--host-port`); estate private addresses
(`--estate ADDRESS:PORT`); the mail spool on each port given except its one allowed drain/submit port
(`--spool-allowed-port`, which is never probed); and the cloud metadata address, public DNS and a
public address, which are always probed.

File routes (`--file-path`): listing a directory or reading a file must be refused. Run as the
slot's uid (`--expect-uid`). The probe refuses to run as root, because root reads every file and a
pass would prove nothing.

## Proof

- `test_branchleft_demo_isolation_probe.py` runs against real loopback listeners and real file modes.
  It runs in `repo-tooling-ci.yml` with the other `demo-host/provision` suites.
- `sabotage_branchleft_demo_isolation_probe.py` breaks each guarantee in a scratch copy (a completed
  connection read as refused, a readable directory read as refused, a missing path read as refused,
  the spool's allowed port probed, public routes dropped, the gateway not probed, root allowed, a wrong
  uid allowed, a reached route exiting zero, an unchecked route passing) and requires the suite red for
  each, then green on the untouched copy.

## What it does not prove

- The live run from inside a real slot on demo1, which is #4046.
- That the policy is in place. The probe reports what the slot can reach at the moment it runs. The
  control cases (delete the egress jump, open the slot directory's mode, publish a slot port off
  loopback) are run against the live slot in #4046, not here.
- Anything across a reboot. The egress unit runs after `docker.service`, so the window in
  `branchleft_demo_egress.md` ("A window at every boot") is out of scope.
- Route values. The caller supplies the gateway, ports, estate addresses, spool and paths; the probe
  does not discover them. A wrong value gives a wrong verdict, which is why an `UNCHECKED` route is
  never a pass.

## Running it

```
python3 -I branchleft_demo_isolation_probe.py --gateway 172.20.0.1 --peer-port 9303 \
  --host-port 22 --host-port 9100 --estate 10.0.0.2:443 --spool-address 172.20.0.1 \
  --spool-port 25 --spool-allowed-port 2525 --file-path /opt/branchleft/demo-1 \
  --expect-uid 2001
```

The values above are examples; the real ones come from the slot's own configuration in #4046.
