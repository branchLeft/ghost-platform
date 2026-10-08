# test-demo-mail-spool.sh

## What this proves

LLD-6 §03 and ISSUE branchLeft/workspace#1264: the demo host runs one mail
spool, a slot's Ghost submits to it on both paths, it has no route off the
host, and its queue survives a reboot. The proof runs the stack
`render-core` renders (`renderMailSpoolStack`) in a privileged
Docker-in-Docker stand-in named `demo1`, with the real
`branchleft_demo_egress.sh` policy applied, installed the way
`ghost-platform-docs/demo-host-mail-spool-runbook.md` installs it.

Asserted, each from inside a container rather than from the Compose file:

- control first: a container of the spool's image on an ordinary bridge reaches
  the outside, so the probe can see a route when there is one
- the spool cannot open a TCP connection to a host outside, nor to a service on
  its own host
- a slot's Ghost network, being `internal`, gives the Ghost no route off the host
- Ghost's SMTP path and its Mailgun-shaped path are each accepted, and the
  queue's `mailgun_shim_undrained_recipients` reads 2
- the drain port is published on `127.0.0.1` only, and refuses a caller with no
  token
- after `docker restart` of the whole stand-in (dockerd included, the policy
  re-run as the boot unit does), the spool is healthy, still holds both
  messages, and still cannot reach the outside

## Sabotage

`SABOTAGE=open-route` turns masquerade on for the spool's drain network (the
render-level control turned off) and removes the egress policy's jump from
`DOCKER-USER`. Either alone leaves the other layer holding; together they open
a real route, so it takes both. The no-route assertions must fail
and the script must exit non-zero; CI asserts that.

## Limits

- The spool image is pulled by digest from GHCR by the stand-in host, as the
  real host will. `SPOOL_IMAGE` overrides the pin.
- Docker-in-Docker is not demo1: its kernel, its systemd units and its
  Hetzner firewall are not exercised. The runbook's read-backs on the real host
  are the proof that it holds there.
- Docker's embedded DNS resolver runs in dockerd, outside the FORWARD policy.
  The proof observed the spool resolving a public name through it. That is a
  name-lookup channel off the host that the egress policy does not fence; the
  script reports it but does not assert on it, and it is filed as its own item.
