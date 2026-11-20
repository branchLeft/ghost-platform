# verdict-host-network.test.ts

## The live network control

The render tests (`verdict-host-sidecar.test.ts`) show the document names an
`internal: true` network. This suite shows Docker applies it. It renders a
slot's stack with the production verdict source, starts only its
`verdict-host` service from the rendered file (the real host end, on the
rendered network, with the rendered posture), and attempts outbound connects
from a second process inside the container: to a canary listener on the
Docker host, and to a public address. Both must fail, and the canary must see
no connection.

The control is the same run against the same rendered file with the one
`internal: true` line removed, which gives the network a gateway. There the
connects succeed, and the refusal assertion goes red on it. To see the
rendered stack go red, make `compose.ts` render the network without
`internal` and without its posture check: the outbound connects then succeed
and the suite fails.

The probe is a process of its own, so a refusal is the network's, not the
host end's in-process egress guard.

Needs Docker, an image that has Node (`VERDICT_NETWORK_TEST_IMAGE`, default
`ghost-platform:ci`, built by this repo's `docker build .`), and the host end's
built `verdict-host/generated/signed-request.cjs` (`pnpm run build:shared` in
`adapters/scanning-storage`). The image does not carry the host end yet, so the
suite mounts the repository's own `adapters/scanning-storage` tree read-only at
the path the render's entrypoint names. It skips when any is absent, and
`render-core-ci.yml` has none of them, so it runs where all three hold.

It runs one container at a time and removes its container, network and
volumes when it ends.
