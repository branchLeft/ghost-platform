# branchleft_demo_egress.sh: demo container egress deny

This implements the owner's ruling `egress=a` of 2026-09-28: outbound traffic
is denied for the demo containers only, and the host keeps NTP and its
security updates.

## What it denies

Every connection a bridged container on demo1 opens itself is refused. It
gets `REJECT`, not `DROP`, so a blocked attempt fails at once instead of
waiting out a connect timeout. That matters because Ghost awaits transactional
mail inside the request. The connections refused are:

- off the host, which covers the internet, the Hetzner metadata service and
  DNS;
- to the host's own services. A container can reach a service bound to
  `0.0.0.0` through its bridge gateway, and demo1's sshd listens there.

What still works, and must:

- a connection the host or the demo edge opens into a container (the
  published slot ports), and its replies;
- container to container inside one Docker network.

The host itself is untouched. Its own traffic never crosses `FORWARD` and
never arrives on a container bridge.

## Which containers count as "demo containers"

Every bridged container on the host. The demo edge runs in the host's network
namespace, so here it is the host. Every container on a bridge is a slot, a
sidecar or a spool, and none of them has a reason to open a connection
anywhere but inside its own network.

The policy matches on the bridge interface (`docker0` and `br-+`), not on an
address range. A network created with a subnet of its own is still covered.

A host service that a container must reach, such as a mail spool bound on a
bridge gateway, needs an explicit accept in `BRANCHLEFT-DEMO-INPUT`. None
exists today.

## Known limits

- **A window at every boot.** The unit runs after `docker.service`, and
  containers with a restart policy start with dockerd. For those few seconds
  at each boot, slots have unrestricted egress.
- **A failed unit is quiet.** A failure shows only in the journal, and nothing
  alerts on it.
- **The proof has no systemd.** It runs in Docker-in-Docker, so neither a
  reboot nor a dockerd restart is exercised.
- **IPv6 is checked by rule presence only.** Both families get the same
  ruleset text, but no IPv6 traffic is sent.

## How it applies

- **Two chains, rebuilt in one step.** `BRANCHLEFT-DEMO-EGRESS` is jumped to
  from `DOCKER-USER`, and `BRANCHLEFT-DEMO-INPUT` from `INPUT` for each
  bridge. Both are rebuilt in a single `iptables-restore --noflush` commit, so
  a re-run never leaves a window with a chain empty. The jumps are added only
  if absent, so a re-run adds nothing.
- **IPv4 and IPv6.** Both families are covered and neither is optional. A
  network created with IPv6 would otherwise give its containers a route out
  that the policy never saw.
- **Refuses to run.** It refuses on any host not named `demo1`. On an app
  host it would be an outage, because tenants need outbound mail, and edge1
  forwards the estate's egress. It also refuses where `DOCKER-USER` is
  missing, whether Docker is not up yet or its nftables backend is active. No
  other chain is a safe substitute, because the order of `FORWARD` is Docker's
  to rewrite.
- **Installed as** `/usr/local/sbin/branchleft-demo-egress`, and re-run by
  `branchleft-demo-egress.service` at every boot and every Docker restart.
- **POSIX sh.** It runs on Debian's dash on the host and on busybox in its
  container proof.

## Proof

- `test_branchleft_demo_egress.py` runs the script against fake `iptables`,
  `ip6tables`, their `-restore` tools and `hostname`, and asserts the exact
  ruleset and the refusals.
- `scripts/test-demo-container-egress.sh` runs it against a real dockerd and
  real iptables, inside a privileged Docker-in-Docker container named
  `demo1`. Every "cannot reach" check has a control run before the policy,
  which shows the same probe reaching the same target. The host is still
  checked afterwards: it reaches the outside and the published slot port, and
  containers still reach each other within a network.
