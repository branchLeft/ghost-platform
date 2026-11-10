# demo-edge

Caddy 2.11.4 with the Hetzner DNS module (`github.com/caddy-dns/hetzner/v2`
v2.0.1) compiled in. It is the image for the demo host's own TLS termination:
one wildcard certificate, issued by DNS-01, covers every demo slot name, so
no slot name reaches a certificate transparency log. The Caddyfile is
rendered by `demo-host/provision/render_demo_site.py`; see
`demo-host/provision/render_demo_site.md`.

`.github/workflows/demo-edge-image.yml` builds it for `linux/amd64` and, on a
merge to `main`, publishes it to `ghcr.io/branchleft/demo-edge`. Nothing deploys
it: the owner carries the published digest to the demo host. Separately,
`demo-host/provision/test_demo_edge_wildcard.py`, in the `repo-tooling-ci`
unit-test step, builds it and checks the module is registered and that the
rendered Caddyfile manages only the wildcard name.

## Publish

On a push to `main` (or a manual dispatch from `main`) the workflow:

1. Builds the image, holds the built binary to the pins below with
   `scripts/demo-edge-pins.mjs` (see `scripts/demo-edge-pins.md`), and proves a
   drifted pin is refused.
2. Pushes that exact image (saved, loaded and checked by image ID, never
   rebuilt) as one `linux/amd64` manifest tagged with the commit SHA only. There
   is no `latest` tag.
3. Signs the pushed digest with a GitHub build-provenance attestation, verifies
   it twice and checks a wrong identity is refused. The signer is
   `branchLeft/ghost-platform/.github/workflows/demo-edge-image.yml` on
   `refs/heads/main`; see `scripts/verify-image-attestation.md`.
4. Prints `Pin this: ghcr.io/branchleft/demo-edge@sha256:...` in the push job's
   summary. That digest reference is the value for `demo1_build_caddy_image`, and
   the only thing a consumer may pin.
5. Logs in with the run's own token (`packages: read`), pulls that digest back
   and checks the pulled image reports it as its repo digest, then runs the pins
   check against the pulled image (the `registry-pull` job).

The package is private and stays private: build artifacts are not published
unless they help the open-source community. A reader pulls it by digest after
`docker login ghcr.io` with a token that can read the package, for example
`docker pull --platform linux/amd64 ghcr.io/branchleft/demo-edge@sha256:...`
(`--platform` because an Apple-silicon Mac is arm64).

## Pins

The pins live in the `Dockerfile` and nowhere else: Caddy `2.11.4` (builder tag,
`xcaddy build` argument and final tag), both base image digests, and the Hetzner
module `v2.0.1`. `workflow-demo-edge-image.test.js` fails when a digest or the
module version is missing, when the three Caddy spellings disagree, and when the
built binary reports anything other than what the `Dockerfile` says. To bump,
change every spelling together and re-read the digests.

## Build

```sh
docker build -f services/demo-edge/Dockerfile services/demo-edge
```

The build stage uses `xcaddy`; the final stage copies the binary onto the
pinned `caddy:2.11.4-alpine` base. A `RUN` at the end fails the build when
`dns.providers.hetzner` is absent from `caddy list-modules`.

## Configuration

- The module reads the Hetzner Cloud API token only through the Caddyfile
  directive `dns hetzner {file./abs/path}` or `dns hetzner {env.NAME}`. The
  block form (`dns hetzner { api_token ... }`) is broken in module v2.0.1,
  and the renderer does not emit it.
- Production uses the file form. The token file is root-only on the host and
  is mounted read-only into the container. The token never appears in the
  Caddyfile or in the image.
- Caddy's data directory (`/data`) holds the issued certificate and account
  state. It must be a persistent volume, or each restart re-issues.
