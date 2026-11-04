# test_demo_edge_wildcard.py

Holds the rendered demo Caddyfile to what a real Caddy does with it: the
only name Caddy would obtain a certificate for is the wildcard `*.<base>`,
and no slot hostname is a certificate subject, a TLS connection policy SNI,
or anything else outside a route's host matcher. Slot names are one label
below the wildcard, so none of them reaches a certificate transparency log.

## How the names are read

The tests render two slots with `render_demo_site.render_caddyfile` from
render-core's golden edge JSON, write the text beside a stand-in token file
holding a fake value, then run `caddy validate --adapter caddyfile` (it must
say `Valid configuration`) and `caddy adapt --adapter caddyfile`. The adapted
JSON is walked in full, not at fixed indexes:

- every list under a `subjects` or `sni` key, at any depth, is a managed name,
  so a second automation policy cannot hide one;
- there must be exactly one automation policy and no `on_demand` key;
- a slot hostname may appear only as an entry of a route's `host` matcher,
  under `apps.http.servers[*].routes`, however deeply subroutes nest it;
- every issuer must solve DNS-01 with the `hetzner` provider and an
  `api_token` that is exactly `{file.<token path>}`, never a literal.

`validate` passes with the token file missing or empty, so the proof says
nothing about whether the token is readable; that is the host's.

## The checks can fail

`test_the_per_host_form_would_be_caught` feeds the same check a retired-form
Caddyfile (one `https://<host>` site per slot, written out in the test) and
requires it to fail with both slot hostnames among the subjects. Two more
tests hand the provider check a wildcard site on `tls internal` and a
Caddyfile that carries the token as a literal. `AdaptedChecksTests` and
`ProviderChecksTests` run on hand-built JSON with no Caddy, so the walk
itself is tested even where the real-Caddy tests skip.

## How the tests reach Caddy

- **Docker (CI, and any machine with a daemon).** `docker build` of
  `services/demo-edge/Dockerfile` once per run under a unique tag, removed at
  exit, then `docker run --rm --network none` with the scratch directory
  mounted read-only at `/work`. `test_the_demo_edge_image_registers_the_hetzner_dns_provider`
  lists the image's modules and requires `dns.providers.hetzner` as a whole line.
- **`DEMO_EDGE_CADDY_BIN` (development only).** A path to a Caddy binary with
  the Hetzner module, used instead of Docker so the proof can run where there
  is no daemon. The image test skips under it, because it proves the image and
  a local binary is not the image.
- **Neither, locally:** the real-Caddy tests skip with the reason.
- **`CI` set:** a runner without a usable Docker, or with
  `DEMO_EDGE_CADDY_BIN` set, fails the real-Caddy tests with
  `CaddyUnavailable`. A proof that cannot run must not read as a pass. A failed
  image build is remembered, so the second test class does not rebuild it.

The tests run in the `repo-tooling-ci` job's `unittest discover` step on every
pull request, so the image build counts against that job's timeout.
