# slot0Lease: starting demo slot 0 from the attested image

Narrative for the one-shot entries the owner runs to start slot 0 on the
demo host. The owner runs them; an agent cannot reach the host.

## The entries

- `controlPlaneSlotImagePushCli.ts`: pushes the attested slot image over the
  signed `/image` link.
- `controlPlaneSidecarPushCli.ts`: pushes the drain sidecar the same way.
- `slot0DescriptorCli.ts` (`slot0Descriptor.ts`): renders slot 0's demo
  descriptor, validates it with render-core's `validate()`, and writes it
  owner-only. The gate passphrase is read from stdin, hashed here, and never
  stored.
- `reconcileCli.ts` (`reconcileRequest.ts`): sends the signed `POST /reconcile`
  for that descriptor and exits 0 only on a 200.

The push and lease need the signing key and a tunnel to the broker on the
demo host (loopback only, so it is reached through the jump host).

## Owner commands

Every host, key, path and zone value is typed at a `read` prompt, never
written here. Each step is one command.

Step 1. Read the values (space-separated, one line): the checkout directory,
the jump host, the demo host, the SSH key, the signing key file, the demo
host's private address, the owner's address, the demo zone, the platform
zone, the owned domains (comma-separated), the mail domain.

    read -r CHECKOUT EDGE1_HOST DEMO1_HOST SSH_KEY SIGNING_KEY APP_HOST_IP OWNER_EMAIL DEMO_ZONE PLATFORM_ZONE OWNED_DOMAINS MAIL_DOMAIN && echo "values read"

Step 2. A checkout at the merged main, with its build:

    git -C "$CHECKOUT" fetch origin && git -C "$CHECKOUT" worktree add --detach "$CHECKOUT-slot0" origin/main && cd "$CHECKOUT-slot0/services/broker" && pnpm install --frozen-lockfile && pnpm run build

Step 3. The tunnel, in its own terminal, left running. It forwards the Mac's
18090 to the broker's loopback 8090 on the demo host through the jump host:

    ssh -N -L 18090:127.0.0.1:8090 -i "$SSH_KEY" -J "root@$EDGE1_HOST" "root@$DEMO1_HOST"

Good: `curl -s http://127.0.0.1:18090/status/0` answers JSON with a `phase`.

Step 4. Push the slot image (attested digest, public):

    cd "$CHECKOUT-slot0/services/broker" && SLOT_IMAGE_MANIFEST_DIGEST=sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d PUSH_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH="$SIGNING_KEY" VERIFY_SCRIPT="$CHECKOUT-slot0/scripts/verify-image-attestation.sh" node dist/controlPlaneSlotImagePushCli.js

Good: one JSON line with `"ok":true` and an `imageRef` of
`ghcr.io/branchleft/ghost-tenant@sha256:8c9f...`; exit 0.

Step 5. Push the drain sidecar (attested digest, public):

    cd "$CHECKOUT-slot0/services/broker" && SIDECAR_MANIFEST_DIGEST=sha256:d181d72055ab1e0c30c11c65595e1b79206fd5cdf519ab06d17271107eb0b954 PUSH_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH="$SIGNING_KEY" PUSH_TAR_PATH="$(mktemp -d)/drain-sidecar.tar" VERIFY_SCRIPT="$CHECKOUT-slot0/scripts/verify-image-attestation.sh" node dist/controlPlaneSidecarPushCli.js

Good: one JSON line with `"ok":true` and an `envLine` of
`DEMO_SIDECAR_IMAGE=ghcr.io/branchleft/drain-sidecar@sha256:d181d7...`; exit 0.
The host must then resolve that reference: see ghost-platform#1120 (the
drain-sidecar tag by reference). Do not start the slot before it is merged and
vendored.

Step 6. The descriptor. The passphrase is typed at a silent prompt, then the
descriptor is rendered and the passphrase is cleared, in one command:

    read -rs SLOT0_PASSPHRASE && cd "$CHECKOUT-slot0/services/broker" && printf '%s' "$SLOT0_PASSPHRASE" | BROKER_DEMO_ZONE="$DEMO_ZONE" BROKER_PLATFORM_ZONE="$PLATFORM_ZONE" BROKER_OWNED_DOMAINS="$OWNED_DOMAINS" BROKER_DEMO_MAIL_DOMAIN="$MAIL_DOMAIN" SLOT0_IMAGE_DIGEST=sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d SLOT0_APP_HOST_IP="$APP_HOST_IP" SLOT0_OWNER_EMAIL="$OWNER_EMAIL" SLOT0_EXPIRES_AT=2027-01-31T00:00:00.000Z DESCRIPTOR_OUT="$HOME/slot0.descriptor.json" node dist/slot0DescriptorCli.js; unset SLOT0_PASSPHRASE

Good: one JSON line with `"kind":"demo"`; the file exists at mode 0600. The
path is created exclusively: delete it first to render again.

Step 7. The signed lease, once the demo host's apply carries the re-vendored
`demo1_build` (ghost-platform#1068) and the sidecar tag is in:

    cd "$CHECKOUT-slot0/services/broker" && BROKER_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH="$SIGNING_KEY" DESCRIPTOR_FILE="$HOME/slot0.descriptor.json" SLOT=0 node dist/reconcileCli.js

Good: `"status":200` with `colour` `a` in the body; exit 0. A 409 names the
occupied phase, a 400 names the refused field; this CLI does not retry either.
