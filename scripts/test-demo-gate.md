# test-demo-gate.sh

## What this proves

Proves the demo gate's contract live: a real Caddy with `forward_auth` in
front of a stand-in slot, the gate image under test beside it, and visitors
arriving from distinct addresses on a Docker network -- the placement
`ghost-platform-docs/19-try-it-now-design/05-gate-and-edge.html` §03 draws.

What it shows, each against the real edge rather than the service alone:

- no cookie is refused on every path, `/ghost/` and `/ghost/api/admin/`
  included
- a wrong passphrase is refused and sets no cookie
- the right passphrase sets a HttpOnly, Secure, SameSite=Lax, host-only
  cookie, and that cookie reaches the slot
- the cookie does not open the other slot's host
- a tampered cookie and an expired cookie are refused, beside a control
  cookie forged the same way that is admitted -- so the refusals are the
  gate's verdict, not a forging mistake
- recycling the slot (a new lease record) kills the cookie at once
- a lease record untied from the slot's current hash refuses even the right
  passphrase (the recycle race: the hash and the lease are two files the
  broker writes independently, and only `hashId` proves they name the same
  tenancy)
- the per-source ceiling trips for one visitor while another still gets in,
  and neither a spoofed `X-Forwarded-For` through the edge nor one sent
  straight to the gate resets it
- a corrupt slots file and a stopped gate both deny, never admit
