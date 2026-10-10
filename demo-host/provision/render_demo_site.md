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
- **Members import refused, export left alone.** A `POST` to the import
  answers 403, after the gate, so a visitor with no cookie still gets 401.
  `GET` is not matched. The refusal follows what Ghost resolves, read from
  the tenant image (Ghost 6.55.0, `api-version-compatibility`): the legacy
  prefix `v2|v3|v4|canary` is stripped before routing, and express ignores a
  trailing slash, so `/ghost/api/v4/admin/members/upload`,
  `/ghost/api/canary/admin/members/upload/` and `/ghost/api/admin/members/upload`
  all reach the import. Two overlapping matchers refuse them: Caddy's
  normalising, case-insensitive `path` with `*` for the version (a new version
  is caught without an edit), and a `path_regexp` for
  `^/ghost/api/(v<digits>|canary)?/admin/members/upload/?$`. Both over-refuse
  rather than under-refuse. An earlier narrow single-path matcher was bypassed
  by four spellings; the live proof now sends each.
- **`noindex` on every response**, set with the deferred `>` form so the
  gate's own copy of the header is replaced rather than doubled (the live
  proof caught the doubled value).
- **The content policy** the descriptor was rendered with: `Content-Security-Policy`
  when the hash set was derived, `...-Report-Only` when it was not. Never
  guessed here.
- **Refusals.** A gate kind other than `passphrase`, an admitted hostname, a
  hostname, size or policy that could escape the quoted Caddyfile text, a
  `tls` argument that is not one directive, a duplicate host or slot.

## The gate's environment

`--gate-env-out FILE` also writes the gate's environment file
(`render_gate_environment`): `LISTEN_HOST` and `PORT` where the Caddyfile
dials the gate, and `GATE_TRUSTED_PROXIES` set to the edge's own address,
all from `render_demo_edge.DEMO_EDGE_ADDR` so none is a second literal.

- **Why it must be set.** The edge shares the host network namespace, so
  for every visitor request the gate's socket peer is the edge. Unset,
  every visitor shares one attempt-ceiling bucket.
- **A host-local process can set its own source.** Trust is by address, so
  any process on the host that can open the gate's port is a trusted peer
  and may choose its source with `X-Forwarded-For`. A visitor cannot.
- **Exactly one address.** Never the 127/8 range, never a wildcard: the
  gate honours `X-Forwarded-For` only from a listed peer, so a wider list
  lets a visitor choose their own source. The default stays empty.
- **Not placed by `demo_go_live.py`.** Whatever starts the gate must load
  this file (`docker run --env-file`, or systemd `EnvironmentFile=`);
  `scripts/test-demo-edge.sh` runs the gate from exactly this file.

## What it does not do

The wildcard certificate (`--tls`) for the real demo domain waits on the DNS
move; the default is `tls internal`, the local CA the proof uses. The real
descriptor-to-JSON step is render-core's; this reads its output.

## Sabotage

`sabotage_render_demo_site.py` breaks each gate in a scratch copy and requires
the suite red, then the real copy green. `scripts/test-demo-edge.sh` repeats
two against a real Caddy (`DEMO_EDGE_PROOF_SABOTAGE=exempt-ghost` and
`=narrow-import`).

## Installing

`--out` writes unchecked. Only `demo_go_live.py` (PR #385) may place the live
Caddyfile; treat this output as a candidate for its `--caddyfile`.

## Not proven here

The content policy is report-only in the only demo fixture, because render-core
has no caller yet that supplies a computed script-hash set. #1254's
"enforcing policy on the demo host" waits on #1238's hash wiring.

## Why the members-import refusal is not one literal path

(Moved from a code comment.)

HLD F1: the members import is refused at the edge; the GET (the export)
is the prospect's and stays open behind the gate.

The refusal follows what Ghost resolves, not one literal path. Ghost 6.55.0
(services/api-version-compatibility) accepts `/ghost/api/<version>/admin/...`
for version v2|v3|v4|canary and strips it; express does not require the
trailing slash. So every one of these reaches the import handler:

```text
/ghost/api/admin/members/upload[/]
/ghost/api/{v2,v3,v4,canary}/admin/members/upload[/]
```

The version list is Ghost's and can grow, so any `v<digits>` or `canary`
prefix is refused, and the two matchers in `render_demo_site.py` overlap on purpose. Caddy's `path` matcher cleans and unescapes and is
case-insensitive; a `*` spans any segment(s), so an unknown version prefix is
still caught (it only ever over-refuses a POST, the safe direction).
