# verdict-host-network.test.ts

## The live network control

The render tests (`verdict-host-sidecar.test.ts`) show the document gives the
sidecar `network_mode: none` and refuses anything else. This suite shows Docker
applies it. It renders a slot's stack with the production verdict source,
starts only its `verdict-host` service from the rendered file (the real host
end, with the rendered network mode and posture), and from a second process
inside the container attempts outbound connects: to a canary listening on every
address of the Docker host (through the host-gateway name), to the default
bridge's gateway address (`172.17.0.1`, which is what host-gateway is on a
Linux host), and to a public address. None may get any answer, not even a
refusal, and the canary must see no connection. It also reads the container's
networks, interfaces and routes: only the `none` network, only loopback, no
route, and no address Docker gave the host.

There are two controls, each the same rendered file with the one network line
replaced, and the assertions go red on each:

- an `internal: true` bridge network of its own, which was the first design and
  was refused in review. Nothing off the host is reachable, but Docker gives
  the host the bridge's first address, it answers the sidecar's connect (with a
  refusal here, because nothing listens on that port; a service on the host
  that listens on every address, sshd for one, would accept), and the host-
  address assertion fails on it.
- the stack's default bridge network (a network with a gateway), where the host
  canary and a public address are reached and the refusal assertion fails on it.

To see the rendered stack go red, make `compose.ts` render the sidecar with a
network: the posture check refuses it, and with the check removed the outbound
connects get answers and this suite fails.

The probe is a process of its own, so a refusal is the network's, not the host
end's in-process egress guard.

Needs Docker, an image that has Node (`VERDICT_NETWORK_TEST_IMAGE`, default
`ghost-platform:ci`, built by this repo's `docker build .`), and the host end's
built `verdict-host/generated/signed-request.cjs` (`pnpm run build:shared` in
`adapters/scanning-storage`). The image does not carry the host end yet, so the
suite mounts the repository's own `adapters/scanning-storage` tree read-only at
the path the render's entrypoint names. It skips when any is absent, and
`render-core-ci.yml` has none of them, so it runs where all three hold, not in
that workflow.

It runs one container at a time and removes its container, networks and
volumes when it ends.
