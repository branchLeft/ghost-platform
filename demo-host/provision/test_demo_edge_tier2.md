# test_demo_edge_tier2.py

Runs a real Caddy on the demo Caddyfile against a local ACME CA and requires
the CA to have been asked for one certificate, for `*.<base>`, and never for a
slot hostname. A name that is ordered from a CA is published in certificate
transparency logs, so this is the observation that matters: what the CA was
sent, not what the renderer meant to write.

`test_demo_edge_wildcard.py` is the other half. It proves the Hetzner module
accepts the configuration and that Caddy's adapter lists only the wildcard as
a managed name. This file proves the shape: a wildcard site with host-matched
handles makes Caddy order the wildcard alone. The Hetzner provider is not in
this run. A stub provider stands in for it, so nothing here shows that the
Hetzner API accepts the TXT records.

## What runs

Everything runs on loopback inside one container (or, for development, on
local binaries), per case:

- **Caddy**, built from `tier2/caddy` (the standard modules and `tier2/stubdns`,
  the program xcaddy would generate): the stub provider
  `dns.providers.challtestsrv`. Its Caddyfile grammar and its Provision call
  copy the Hetzner module's, so the renderer's own directive
  `dns challtestsrv {file./abs/path}` reaches it the way
  `dns hetzner {file./abs/path}` reaches the real one. The file holds the
  challtestsrv management URL (with a trailing newline, as a person would
  write it), so the run also shows `{file.}` resolving to a usable value.
- **Pebble** v2.10.1, the ACME test CA, with a fresh throwaway TLS identity
  from `tier2/tools/mkcert` (a day's validity, so no fixture expires in the
  repository). Random nonce rejection and authorization reuse are off.
- **pebble-challtestsrv** v2.10.1, Pebble's DNS. The stub publishes and
  clears the `_acme-challenge` TXT records through its management API.
- **soashim** (`tier2/tools`): a DNS front that answers the SOA of the base
  zone and forwards everything else, TXT lookups included, to challtestsrv.
  Caddy finds the zone of a challenge name by SOA lookups, and challtestsrv
  answers those with NOTIMP. Caddy's propagation check is left on and
  queries TXT through the front, so the challenge is checked for real.
- `tier2/run_wildcard_proof.py` starts these per case, waits for Caddy to
  obtain its certificates, probes it over TLS, and copies every log and a
  `result.json` out. It judges nothing.

## The Caddyfile under test

The text is the real renderer's: `render_demo_site.render_caddyfile` with two
slots from render-core's golden edge JSON and the directive
`dns challtestsrv {file.<path>}`. The renderer's directive pattern admits the
stub's name unchanged. The only edit is to the global block, which the run
script replaces: unprivileged ports, no redirect listener, `acme_ca` and
`acme_ca_root` pointing at Pebble, and `tls_resolvers` pointing at the DNS
front. A test requires the text before and after that block, which holds the
upstream snippets and the whole wildcard site, to equal the renderer's
output, and the run script refuses a Caddyfile without the block exactly once.
The edited file is copied to the artifacts as `Caddyfile.loaded`.

## What is asserted

For the wildcard case (`wildcard_proof_problems`):

- Pebble logged exactly one new order and one authorization, and one
  validation, of type `dns` for the base with the wildcard flag.
- challtestsrv published and cleared TXT records for
  `_acme-challenge.<base>.` and for no other name.
- No slot hostname appears in the Pebble, challtestsrv or DNS front logs.
- Caddy logged one obtained certificate, and its storage holds one
  certificate directory, `wildcard_.<base>`.
- Each slot hostname completes a TLS handshake verified against Pebble's root
  and that hostname, the certificate's DNS names are exactly `*.<base>`, and a
  `GET /` gets an HTTP response (the gate and upstreams are absent, so a
  502 is expected).
- An unmatched one-label name completes the handshake and gets a closed
  connection with no response, which is the closing `handle { abort }`.
- A two-label name gets no certificate and no verified handshake.

Pebble's log is the CA-side source for orders. Pebble's own log does not list
an order's identifiers, so the identifiers come from the validation line
(`Identifier{Type:"dns", Value:"<name>"} ... Wildcard:true`) and from the
absence of the slot names everywhere else. Both patterns are tied to the
pinned Pebble version, and the judgement tests keep the exact line shape. A
changed log format makes the validation list empty, which fails the wildcard
case instead of passing it.

## The checks can fail

The same harness runs a second case in the same container: the retired per-host
form, one `https://<host>` site per slot, each with `dns challtestsrv`.
`test_the_per_host_form_is_caught_by_the_same_checks` requires the judgement
to report two orders, a slot hostname in the CA's logs for each slot, and
certificates for the slot names instead of the wildcard. `JudgementTests`
change the artifacts of a good run one fault at a time (an extra order, a slot
name in each log, an uncleared TXT record, a probe answered when it should be
closed, and so on) and require the named problem, with no Docker needed.

An extra `https://<slot host>` site next to the wildcard site is not caught,
and does not need to be: Caddy lists the name among its managed domains but
the wildcard certificate already covers it, and the CA is sent no order for it.

## How the run is reached

- **Docker (CI, and any machine with a daemon).** `docker build` of
  `tier2/Dockerfile` once per run under a unique tag, removed at exit, then one
  `docker run` with `--network none`, a read-only root, every capability
  dropped, the caller's uid, the cases at `/work` read-only, a tmpfs at
  `/scratch` and `/out` for the artifacts. Both cases run in that container.
  Every base image is pinned by digest and every Go module and tool by version.
  The build does not depend on the Go checksum database: see the next section.
- **`DEMO_EDGE_TIER2_BIN_DIR` (development only).** A directory holding
  executable `caddy-tier2`, `pebble`, `pebble-challtestsrv`, `soashim` and
  `mkcert`. The run script runs on them directly, with no isolation. The
  same assertions apply. Ports 14000, 15000, 8053, 8054, 8055, 18080 and 18443
  on loopback must be free.
- **Neither, locally:** the real-run tests skip with the reason.
- **`CI` set:** no usable Docker, or `DEMO_EDGE_TIER2_BIN_DIR` set, fails with
  `ProofUnavailable`. A proof that cannot run must not read as a pass.

The build compiles Caddy a second time, beside the demo-edge image's build, so
the `repo-tooling-ci` job pays for both on every pull request. The Caddy,
Pebble and tool stages are independent, so BuildKit builds them in parallel.

## The build and the network

A Go build that has to work out which versions to use, or that meets a module
missing from `go.sum`, asks the checksum database (sum.golang.org) to vouch for
it. When the runner's resolver times out on that lookup, the image does not
build and the job fails for no fault of the code. So nothing here resolves
versions at build time. Caddy (`tier2/caddy`), Pebble and its challenge server
(`tier2/ca`, as `tool` lines) and the helper programs (`tier2/tools`) are each
a committed module whose `go.sum` lists the hash of everything it needs. The
build downloads module files from the module proxy, checks each against
`go.sum`, and never contacts the checksum database. A `go.sum` that is missing
an entry, or whose hash does not match the download, fails the build. Nothing
loosens verification: no `GOSUMDB`, `GOFLAGS`, `GONOSUMDB` or `-mod=mod`, and
`HermeticBuildTests` fails if the Dockerfile names one, or runs `xcaddy`,
`go get`, `go mod tidy` or `go install <package>@<version>`.

The module proxy is still reached for the downloads, so a network error there
can still fail an attempt. `build_tier2_image` therefore tries a build that
failed on a network error again, three attempts in all with a short wait
between them, and tries nothing else again: a build error, a bad checksum, a
timeout or output that shows no network error is raised at once. Output that
shows a network error and also a compile error, a checksum failure or a missing
`go.sum` entry is not retried either. The retry reuses the image layers already
built, so only the step that failed is built again. `ImageBuildRetryTests` shows
each case.

## Updating the pins

The Caddy builder image carries the Go toolchain; bump its digest with the
Caddy tag and read the toolchain version from the image's Dockerfile in
`caddyserver/caddy-docker` at that Caddy release. Caddy's version is in
`tier2/caddy/go.mod` and `tier2/stubdns/go.mod`, and a test requires the two to
agree. Pebble's version is in `tier2/ca/go.mod`. After a bump, regenerate that
module's `go.sum` with `go mod tidy` run in its directory, using the Go version
of the builder image, and commit it with `go.mod`. After bumping Pebble, run
the parser tests against a real log line from the new version.
