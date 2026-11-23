# slot0Lease: starting demo slot 0 from the attested image

Narrative for the three one-shot entries the
owner runs to start slot 0 on demo1. The owner runs them; an agent cannot
reach the host.

## The entries

- `controlPlaneSlotImagePushCli.ts`: pushes the attested slot image
  (`SLOT_IMAGE_REF` at a manifest digest) over the signed `/image` link.
- `controlPlaneSidecarPushCli.ts`: pushes the drain sidecar the same way.
- `slot0DescriptorCli.ts` (`slot0Descriptor.ts`): renders slot 0's demo
  descriptor, validates it with render-core's `validate()`, and writes it
  owner-only. The gate passphrase is read from stdin, hashed here, and never
  stored.
- `reconcileCli.ts` (`reconcileRequest.ts`): sends the signed `POST /reconcile`
  for that descriptor and exits 0 only on a 200.

The push and lease need the signing key (`PUSH_KEY_PATH`) and a tunnel to the
broker on demo1 (loopback only, so it is reached through the jump host).

## Owner commands

All values are filled. The three values read at the prompt are typed, never
written here.

Step 1. A checkout at the merged `main` with its build, and the attestation
script it names:

    git -C /Users/robertmurray/branchLeft/ghost-platform fetch origin
    git -C /Users/robertmurray/branchLeft/ghost-platform worktree add --detach /Users/robertmurray/branchLeft/ghost-platform-wt-slot0 origin/main
    cd /Users/robertmurray/branchLeft/ghost-platform-wt-slot0/services/broker && pnpm install --frozen-lockfile && pnpm run build

Step 2. The tunnel, in its own terminal, left running. It forwards the Mac's
18090 to the broker's loopback 8090 on demo1 through edge1:

    ssh -N -L 18090:127.0.0.1:8090 -i $HOME/.ssh/id_ed25519_hetzner -J root@46.225.95.167 root@2.28.114.186

Good: `curl -s http://127.0.0.1:18090/status/0` answers JSON with a `phase`.

Step 3. Push the slot image (digest from run 43334219891):

    cd /Users/robertmurray/branchLeft/ghost-platform-wt-slot0/services/broker && SLOT_IMAGE_MANIFEST_DIGEST=sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d PUSH_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH=$HOME/.config/branchleft/demo1-broker/signing-key.bin VERIFY_SCRIPT=/Users/robertmurray/branchLeft/ghost-platform-wt-slot0/scripts/verify-image-attestation.sh node dist/controlPlaneSlotImagePushCli.js

Good: one JSON line with `"ok":true` and an `imageRef` of
`ghcr.io/branchleft/ghost-tenant@sha256:8c9f...`; exit 0.

Step 4. Push the drain sidecar (digest from run 43410699699):

    cd /Users/robertmurray/branchLeft/ghost-platform-wt-slot0/services/broker && SIDECAR_MANIFEST_DIGEST=sha256:d181d72055ab1e0c30c11c65595e1b79206fd5cdf519ab06d17271107eb0b954 PUSH_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH=$HOME/.config/branchleft/demo1-broker/signing-key.bin PUSH_TAR_PATH=$(mktemp -d)/drain-sidecar.tar VERIFY_SCRIPT=/Users/robertmurray/branchLeft/ghost-platform-wt-slot0/scripts/verify-image-attestation.sh node dist/controlPlaneSidecarPushCli.js

Good: one JSON line with `"ok":true` and an `envLine` of
`DEMO_SIDECAR_IMAGE=ghcr.io/branchleft/drain-sidecar@sha256:d181d7...`; exit 0.
The host must then resolve that reference: see ghost-platform#1120 (the
drain-sidecar tag by reference). Do not start the slot before it is merged and
vendored.

Step 5. The descriptor. The owner types the address and the passphrase:

    read -r SLOT0_OWNER_EMAIL; export SLOT0_OWNER_EMAIL
    read -rs SLOT0_PASSPHRASE; export SLOT0_PASSPHRASE
    cd /Users/robertmurray/branchLeft/ghost-platform-wt-slot0/services/broker && printf '%s' "$SLOT0_PASSPHRASE" | BROKER_DEMO_ZONE=demo.trypublicpress.co.uk BROKER_PLATFORM_ZONE=sites.publicpress.co.uk BROKER_OWNED_DOMAINS=demo.trypublicpress.co.uk,publicpress.co.uk BROKER_DEMO_MAIL_DOMAIN=demo.trypublicpress.co.uk SLOT0_IMAGE_DIGEST=sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d SLOT0_OWNER_EMAIL="$SLOT0_OWNER_EMAIL" SLOT0_EXPIRES_AT=2027-01-31T00:00:00.000Z DESCRIPTOR_OUT=$HOME/.config/branchleft/demo1-broker/slot0.descriptor.json node dist/slot0DescriptorCli.js; unset SLOT0_PASSPHRASE

Good: one JSON line with `"kind":"demo"`; the file exists at mode 0600. The
path is created exclusively: delete it first to render again.

Step 6. The signed lease, once demo1's apply carries the re-vendored
`demo1_build` (ghost-platform#1068) and the sidecar tag is in:

    cd /Users/robertmurray/branchLeft/ghost-platform-wt-slot0/services/broker && BROKER_BASE_URL=http://127.0.0.1:18090 PUSH_KEY_PATH=$HOME/.config/branchleft/demo1-broker/signing-key.bin DESCRIPTOR_FILE=$HOME/.config/branchleft/demo1-broker/slot0.descriptor.json SLOT=0 node dist/reconcileCli.js

Good: `"status":200` with `colour` `a` in the body; exit 0. A 409 names the
occupied phase, a 400 names the refused field; neither is retried by this CLI.
