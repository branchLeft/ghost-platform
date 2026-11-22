# branchleft_demo_isolation_probe.py: isolation probe for one demo slot

Issue: a part of the demo-isolation work, tracked in the private tracker. Design: ghost-platform-docs
`19-try-it-now-design/02-broker-and-slot.html` and `00-high-level-design.html`.

## What it does

Run from inside one demo slot's network namespace, as that slot's own uid, it tries every route
the slot must not have and prints one line per route:

- `REFUSED <route>`: the connection was refused, timed out, or found no route or network
  (`ECONNREFUSED`, a timeout, `EHOSTUNREACH`, `ENETUNREACH`);
- `REACHED <route>`: the connection opened. Any `REACHED` exits 1;
- `UNCHECKED <route>: <reason>`: the route could not be tried, so it proves nothing. Every other
  error is `UNCHECKED`, including a name that does not resolve, a denied connect (`EPERM`,
  `EACCES`) and running out of descriptors. Any `UNCHECKED` exits 2, so it is never a pass. A path
  that does not exist is `UNCHECKED` too.

Before any route, it tries a control: the spool's allowed port, which must open. If the control does
not open, the namespace is not the slot's (or the spool is down), and the probe prints
`CONTROL NOT REACHED` and exits 2 with no route verdicts at all.

Every route class is mandatory: the peer slot's ports, the host's services, the estate addresses,
the mail spool (address, ports, and the allowed port), and the file paths. Leaving out any of them
is a usage error (exit 2), so a forgotten class cannot shorten the run into a pass. `--expect-uid`
is required, and the probe refuses to run as root, because root reads every file.

Network routes: the other slot's ports (Ghost, health router, sidecar) on loopback and on the bridge
gateway; the host's own services on the gateway (`--host-port`); estate private addresses
(`--estate ADDRESS:PORT`); the mail spool on each port given except its allowed port, which is the
control; and the cloud metadata address, public DNS and a public address, which are always probed.

## Proof

- `test_branchleft_demo_isolation_probe.py` runs against real loopback listeners and real file modes,
  with mocked connect errors for each error class. It runs in `repo-tooling-ci.yml` with the other
  `demo-host/provision` suites.
- `sabotage_branchleft_demo_isolation_probe.py` breaks each guarantee in a scratch copy and requires
  the suite red for each, then green on the untouched copy. The guarantees: each error class
  classified as the rules say (the gateway name that does not resolve, a denied connect, a timeout,
  an unreachable network); an UNCHECKED route never a pass; the control required to open; every
  route class and `--expect-uid` required; a completed connection, a readable directory and a missing
  path each read the right way; the spool's allowed port never probed; the public routes always
  probed; the gateway always probed; root and a wrong uid refused; a reached route exits 1.

## What it does not prove

- The live run from inside a real slot on demo1, which is #4046.
- That the policy is in place. The probe reports what the slot can reach at the moment it runs. The
  control cases (delete the egress jump, open the slot directory's mode, publish a slot port off
  loopback) are run against the live slot in #4046, not here.
- Anything across a reboot. The egress unit runs after `docker.service`, so the window in
  `branchleft_demo_egress.md` ("A window at every boot") is out of scope.
- Route values. The caller supplies the gateway, ports, estate addresses, spool and paths; the probe
  does not discover them. The control catches a wrong namespace, not a wrong port in a route.

## Follow-ups, not in this change

- IPv6 and UDP. Every route is IPv4 TCP. DNS is probed on TCP 53 only, so a slot with a UDP or IPv6
  route out is not caught here.
- Directory traversal. A directory with search (`x`) but no read (`r`) permission refuses `listdir`
  and reads as `REFUSED`, though files under it may still open by name.
- A FIFO on a file route would block `open()` with no timeout.
- The default `geteuid` binding in `main` has no test of its own.

## Running it

```
python3 -I branchleft_demo_isolation_probe.py --gateway 172.20.0.1 --peer-port 9303 \
  --host-port 22 --host-port 9100 --estate 10.0.0.2:443 --spool-address 172.20.0.1 \
  --spool-port 2525 --spool-allowed-port 2525 --file-path /opt/branchleft/demo-1 \
  --expect-uid 2001
```

The values above are examples; the real ones come from the slot's own configuration in #4046.
