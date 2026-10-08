# render_demo_site.py

## What it renders

A gated Caddy site block for one demo slot, from render-core's
`EdgeSiteBlock` JSON, plus the whole Caddyfile (`render_caddyfile`): the
global options and every slot's upstream snippet from `render_demo_edge.py`,
then one site block per occupied slot. The block imports the slot's own
snippet, so the two colours and their per-colour health check
(`X-Colour-Upstream`, answered by the slot's health router) are the same ones
`render_demo_edge.py` already pins.

## The gates

- **Every path is gated.** There are exactly two handlers: the gate's own
  login (it carries a body, which `forward_auth` does not forward) and a
  catch-all that opens with `forward_auth`. No path matcher can stand in front
  of the catch-all, so `/ghost/` and `/ghost/api/admin/` cannot be exempted
  without adding a handler, which the unit test counts.
- **Members import refused, export left alone.** `POST
  /ghost/api/admin/members/upload/` answers 403, after the gate, so a visitor
  with no cookie still gets 401. `GET` on that path is not matched.
- **`noindex` on every response**, set with the deferred `>` form so the
  gate's own copy of the header is replaced rather than doubled (the live
  proof caught the doubled value).
- **The content policy** the descriptor was rendered with: `Content-Security-Policy`
  when the hash set was derived, `...-Report-Only` when it was not. Never
  guessed here.
- **Refusals.** A gate kind other than `passphrase`, an admitted hostname, a
  hostname, size or policy that could escape the quoted Caddyfile text, a
  `tls` argument that is not one directive, a duplicate host or slot.

## What it does not do

The wildcard certificate (`--tls`) for the real demo domain waits on the DNS
move; the default is `tls internal`, the local CA the proof uses. The real
descriptor-to-JSON step is render-core's; this reads its output.

## Sabotage

`sabotage_render_demo_site.py` breaks each gate in a scratch copy and requires
the suite red, then the real copy green. `scripts/test-demo-edge.sh` repeats
the key one against a real Caddy (`DEMO_EDGE_PROOF_SABOTAGE=exempt-ghost`).
