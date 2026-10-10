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
- the two messages drained are the two that were sent: each subject carries a
  marker unique to the run, `drainack.js` prints every subject it is handed
  before acking it, and that set must equal the two sent subjects, so a dropped
  message replaced by another cannot keep the count at 2
- with the spool stopped, both paths raise an error in under 3 seconds; with it
  frozen (`docker pause`, sockets still held) both paths raise only when the
  client's own timeout fires. In neither case does a message appear or vanish
  from the queue
- the drain and ack run inside the spool's container (`drainack.js`, the same
  block the delivery runbook runs), and the queue then reads 0
- the drain port is published on `127.0.0.1` only, and refuses a caller with no
  token
- after `docker restart` of the whole stand-in (dockerd included, the policy
  re-run as the boot unit does), the spool is healthy, still holds both
  messages, and still cannot reach the outside

## Running it

`./scripts/test-demo-mail-spool.sh` must exit 0. It needs `npm ci && npm run
build` in `render-core` first, and creates only containers and a network under
one prefix. `SABOTAGE=open-route`, `SABOTAGE=no-spool` and
`SABOTAGE=wrong-message` each must exit 1.

## Sabotage

Each run must exit non-zero, and CI also checks that the named assertions are
the ones that failed, so a crash cannot pass for a red.

- `SABOTAGE=open-route` turns masquerade on for the spool's drain network (the
  render-level control turned off) and removes the egress policy's jump from
  `DOCKER-USER`. Either alone leaves the other layer holding; together they open
  a real route, so it takes both. The no-route assertions must fail.
- `SABOTAGE=no-spool` stops the spool just before Ghost submits. Both
  "accepted" assertions and the "queue holds both messages" assertion must fail.
- `SABOTAGE=wrong-message` sends the bulk message under a different subject.
  The count still reads 2, so only the identity assertion may fail.

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
- The client is a Python script, not Ghost. It proves what the spool does with a
  well-formed submission on each path. It does not prove Ghost's own transport
  configuration: the nodemailer options Ghost builds from `mail__options__*`,
  the Mailgun client's base URL handling, or any timeout Ghost applies. Those
  are proved only by a run against a real Ghost.
- A down or hung spool is measured from the stand-in client. Ghost awaits a
  transactional send inside the reader's request, and the rendered Ghost
  environment sets no connection, greeting or socket timeout, so against a hung
  spool what bounds the reader's wait is the library default, which this proof
  does not exercise. The 6 second timeout above is the stand-in's own.
