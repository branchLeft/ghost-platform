# imagePush.live.test.ts

## network-isolation

Against real containers standing in for the control plane and a host, over
a real Docker network with `--internal` set (no route to a registry at
all — not a container-level flag Ghost or Docker interpret, but the same
absence of a default route that a production host's own default-deny
egress rule would leave it with), the compiled `handleImagePush` +
`dockerImageLoader` this service actually ships:

- receives a real Ghost image by push and loads it, verified against a
  digest computed from the bytes that actually arrived;
- refuses a push whose digest does not match;
- never holds a registry credential;
- runs the loaded image by its own content digest, never a tag.

The control plane is a one-shot container on the *same* `--internal`
network as the host, dialling in by the host container's own name
(Docker's embedded DNS resolves that regardless of `--internal`) — never
through a published host port. Docker Desktop does not forward a published
port into a container on an internal network, confirmed with an identical
setup where only `--internal` changed and `curl 127.0.0.1:<published>`
went from `ok` to `ECONNREFUSED` — itself a small, useful confirmation
that the network really carries no inbound path from outside it either.
