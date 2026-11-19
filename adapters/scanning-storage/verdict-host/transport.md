# How the safety service reaches a host end

Status: **an owner decision, not yet taken.** Nothing below is built. This file
is the one home of the options until the owner rules; the ruling then replaces
it with what was chosen.

## What has to be true

- The safety service runs on `ops1` (`shared-infra`, `ansible/roles/safety_service`),
  a private-only host at `10.20.1.50` whose only way out is `edge1`'s NAT.
- It dials each host end at an origin from its own configuration and accepts
  plain `http` for a loopback address only; anything else must be `https`
  (`content-safety`, `src/config.ts`, `transportUrl`). It calls the global
  `fetch`, so it trusts the image's public certificate authorities and nothing
  else.
- Its unit runs the container with no network option, no published port and no
  environment value but the configuration path. Its README makes any change to
  the unit the owner's merge. So "loopback" inside that container is the
  container's own, and a tunnel ending on `ops1`'s loopback cannot be reached.
- A host end is one `verdict-host` sidecar per slot (`render-core`,
  `compose.md#the-verdict-host-sidecar`), on a per-slot `internal: true`
  network, with no published port. Something outside the sidecar has to carry
  the inbound request to it.
- The `branchleft.co.uk` zone (`shared-infra`, `hetzner/dns/zone.json`) has no
  demo or verdict record today.

## The options

| | A. Public name, private address | B. Pinned private TLS (recommended) | C. Through edge1 | D. Tunnel to loopback |
|---|---|---|---|---|
| Name the service dials | `https://<slot>.<host>.verdict.branchleft.co.uk` | `https://<host private IP>:<port>` | `https://<new public name>` | `http://127.0.0.1:<port>` |
| Who holds the certificate | each host, a wildcard by DNS-01 | each host, self-signed, made on the host | `edge1`, one per name | none |
| What the service trusts | the public CAs (no change) | that host's certificate only, named in its config | the public CAs | nothing |
| Path | `ops1` to host, private network | `ops1` to host, private network | `ops1` to `edge1` to host | SSH or WireGuard to host |
| Owner list | criterion 5 (zone records), criterion 2 (DNS-01 token per host) | criterion 2 (a key made on each host; what the service trusts) | criterion 5 (records), names in the public certificate log | the service unit (owner's merge), criterion 2 (tunnel keys) |
| Spend | none | none | none | none |
| Other cost | private addresses in public DNS; ACME and a DNS token on every host | a contract change (an endpoint carries its certificate); trust code in `content-safety` | a public hop for a private channel; per-name certificates | breaks the service's container isolation |

**Recommendation: B.** The channel has two fixed parties, so pinning one
certificate per host is narrower than trusting every public CA for it, needs no
DNS record, puts no name in a certificate log, and needs no DNS token on a
host. The service's configuration gains a public value per host (the PEM of that
host's certificate), passed as the only CA for that host's connections. The
cost is code in a security path, which gets the deep review.

## How it fits the sidecar, whichever option

The sidecar keeps no TCP listener a peer can reach. Its inbound end listens on a
unix socket on the slot's verdict volume, beside the local socket, and a
TLS terminator in the host's network namespace (on `demo1`, a listener of its
own on the private address, not the public demo edge) proxies each slot's
origin to that socket. The host firewall admits only `10.20.1.50` to the
terminator's port. The sidecar then needs no network at all, so
`network_mode: none` can replace the internal network.

That matters because an `internal: true` network is not "no route": Docker
still puts the network's gateway address on the host's bridge, and a container
on it reaches the host's own stack. Observed on Docker 29.9.3, 19 Nov 2026: a
container on a fresh `--internal` network had a route to its subnet and its
gateway (`172.19.0.1`) answered a ping. Any host service listening on all
addresses is reachable from the sidecar that way.

## What is built after the ruling

1. The descriptor: the inbound socket path and, for B, the terminator port and
   certificate per host (render-core `descriptor.ts`, `validate.ts`).
2. The host end: the inbound end on a unix socket (`inbound.js`, `config.js`).
3. The terminator and firewall rule on each host, by Ansible (`shared-infra`).
4. For B, the per-host certificate in the service's configuration
   (`content-safety` `src/config.ts`, `src/host-channel.ts`; the
   `safety_service` role's host shape).
5. A test that a signed poll from the service side, over the chosen transport,
   reaches a slot's host end and is answered.
