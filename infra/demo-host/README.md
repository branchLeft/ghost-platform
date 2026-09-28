# infra/demo-host

One Pulumi program, one stack (`branchleft-ghost-platform-demo-host/production`),
for the demo host `demo1` in the `branchLeft demos` Hetzner project: the
server, its primary IPv4 and IPv6, and its firewall. Nothing here installs the
broker, the slots, the demo edge or the container egress policy; those reach
the host over SSH from edge1.

## Why its own stack, and not `infra/hosts`

A Hetzner token has full power over its project. `infra/hosts` runs with the
estate project's token, so a `demo1` declared there would be created inside
the estate project. The demos project gets its own stack and its own token.

## Why not `@branchleft/hetzner-host`'s `Host`

`Host` attaches every host to the estate network, opens SSH to the internet
and installs a CI deploy account. demo1 needs none of those: networks do not
span projects, its SSH is open to edge1 alone, and nothing deploys to it from
CI. The program keeps `Host`'s create-time decisions instead:

- the firewall is declared on the server, the only form in effect from first
  boot;
- the primary IPs are their own resources with `autoDelete: false`, so the
  address survives a rebuild of the server;
- delete and rebuild protection are on;
- `userData`, `image` and `sshKeys` are in `ignoreChanges`, because the
  provider treats each as replacing.

## The firewall (`firewall.ts`)

Exactly three inbound rules, from the owner's ruling of 2026-09-28:

| Port | Source | Why |
|---|---|---|
| 22/tcp | edge1's public IPv4, `/32` | The owner reaches demo1 by jumping through edge1. ops1 has no public address and leaves through edge1's NAT, so its SSH tunnel to the broker arrives from the same address. |
| 80/tcp | anywhere | The demo edge: HTTP-01 and the redirect. |
| 443/tcp | anywhere | The demo edge. |

Nothing else: no ICMP and no UDP 443 (Caddy falls back from HTTP/3 to TCP).
There are no outbound rules. Hetzner switches a firewall to default-deny
outbound as soon as it carries one outbound rule, and the host has to keep NTP
and its security updates. Container egress is denied on the host instead, by
`demo-host/provision/branchleft_demo_egress.sh`.

edge1's address is read from the estate stack's applied `edge1PublicIpv4`
output rather than configured. A hand-copied value would go stale unnoticed.
The output is read only when this stack runs, and CI runs it only when
`infra/demo-host/**` changes. So if edge1's address ever changed, demo1's rule
would stay stale, and the owner and ops1 would be locked out, until the next
apply of this stack corrects it. edge1's primary IP survives a server rebuild,
which keeps this unlikely. `edge1SshSource` accepts one public dotted-quad IPv4 address
only. It refuses a CIDR, IPv6, private, loopback, link-local, CGNAT,
documentation and multicast addresses, each of which is a plausible wrong
value to wire here.

## The project guard (`projectGuard.ts`)

It passes only when the token can see `project-marker-demos` and cannot see
any other project's marker or hosts. Both halves are needed:

- **Its own marker.** Before its first apply the demos project holds no
  server, and neither do tenants, dns, backup or demo-dns. A check that only
  rules other projects out passes all five alike, and the wrong one gets a
  clean create of demo1. The marker firewalls come from shared-infra's
  `hetzner/RUNBOOK-seven-projects.md`.
- **No other project's marker or host.** A marker is only a firewall, and a
  copy of it in the wrong project would pass the first half alone.

Every resource awaits the guard, so a wrong token plans no Hetzner resource at
all. `index.guard.test.ts` proves that through the program. The inventory is
duplicated from shared-infra's `hetzner/projects.ts`, because
`@branchleft/hetzner-host` does not export it, and the two must match.

## First-boot user-data (`cloudInit.ts`)

It is deliberately almost empty. It sets the host's name and closes SSH to
passwords, and does nothing more. Hetzner refuses user-data over 32 KiB, and
the demo host's provisioning scripts come to about twice that, so they cannot
ride here. Cloud-init runs once, and everything that must stay true over the
host's life is delivered afterwards over SSH and can be re-run. The tests hold
the document under a quarter of the limit.

## Operating it

State is in the same Hetzner Object Storage bucket as every other Hetzner
stack. The stack config carries no salt and no token (PUL-12). The owner sets
up the token, the passphrase and `stack init` by hand. The first apply then
runs from CI after merge, held for approval by the `production` environment.
Pull requests run typecheck and unit
tests only (`.github/workflows/infra-demo-host-ci.yml`), and no cloud
credential touches PR code.
