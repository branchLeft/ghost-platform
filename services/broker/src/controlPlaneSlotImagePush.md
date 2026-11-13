# controlPlaneSlotImagePush.ts

## pushDemoSlotImage

The call site for `pushOciImage` (`controlPlaneImagePush.ts`) that delivers
the Ghost image a demo slot runs. It fixes the image name
(`ghcr.io/branchleft/ghost-tenant`) and the only workflow whose attestation
it accepts (`registry-push.yml`), so an operator supplies a manifest digest
and nothing that could name a different image.

A demo host reaches no registry and its slot Compose service starts from
`${IMAGE}` with no pull, so until the image is on the host the slot cannot
start. This is the push that puts it there, over the same signed link the
drain sidecar uses.

On success it returns `name@digest`, the reference the slot's descriptor must
pin. It returns none unless the host answered 2xx and its reply body names the
digest of the tar that was sent, so a refused push, a redirect (never
followed: `pushImage` sets `redirect: 'manual'`) or a reply from something
that is not the receiver can never be turned into a pin.

The tar is written to a file this module creates exclusively (`wx`, owner
only) in a fresh `mkdtemp` directory, and the directory is removed afterwards,
whatever the outcome. There is no tar path to set.

It does not name the loaded image. The host loads the pushed tar by digest,
so the image lands unnamed and `name@digest` does not resolve until the host
tags it (a host step, not this module's).

## controlPlaneSlotImagePushCli.ts

One-shot entry. Reads `SLOT_IMAGE_MANIFEST_DIGEST`, `PUSH_BASE_URL`,
`PUSH_KEY_PATH` and `VERIFY_SCRIPT`, prints one JSON line,
exits non-zero when the host did not accept the image. Excluded from
coverage like `server.ts`: it is environment wiring only.
