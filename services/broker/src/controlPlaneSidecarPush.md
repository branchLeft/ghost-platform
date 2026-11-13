# controlPlaneSidecarPush.ts

## pushDemoSidecar

The call site for `pushOciImage` (`controlPlaneImagePush.ts`) that delivers
the demo drain sidecar. It fixes the image name
(`ghcr.io/branchleft/drain-sidecar`) and the only workflow whose attestation
it accepts (`drain-sidecar-image.yml`), so an operator supplies a manifest
digest and nothing that could name a different image.

On success it returns the single line the host's sidecar image env file must
hold, `DEMO_SIDECAR_IMAGE=<name>@<manifest digest>`. It returns no line when
the host refused the push, so a refused push can never be turned into a pin.

It does not write that file. Writing it on the host is a separate step: the
image push only loads the image.

## controlPlaneSidecarPushCli.ts

One-shot entry. Reads `SIDECAR_MANIFEST_DIGEST`, `PUSH_BASE_URL`,
`PUSH_KEY_PATH`, `PUSH_TAR_PATH` and `VERIFY_SCRIPT`, prints one JSON line,
exits non-zero when the host did not accept the image. Excluded from
coverage like `server.ts`: it is environment wiring only.
