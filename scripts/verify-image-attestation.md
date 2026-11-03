# verify-image-attestation.sh

## What this does

Checks that a container image in GHCR carries a GitHub artifact attestation
(SLSA build provenance) signed by the expected workflow of this repository, run
from `refs/heads/main` on a GitHub-hosted runner. It wraps
`gh attestation verify` and fixes every identity flag, so a caller can only
choose the image and which workflow it expects.

```
./scripts/verify-image-attestation.sh <registry/name@sha256:64hex> \
    <owner/repo> <owner/repo/.github/workflows/file.yml> [--bundle-from-oci]
```

Exit 0 means verified. Any other exit means do not trust the image.

Without `--bundle-from-oci` the attestation is fetched through the GitHub API,
which needs `GH_TOKEN`. With it, the signed bundle is read from the image's own
registry entry. Unverified: that this needs no GitHub token beyond what `gh`
itself requires. The run-side node is to test it on a host with no `GH_TOKEN`.

## Why it is strict

- A reference that is not `name@sha256:<64 hex>` is refused before `gh` runs. A
  tag can be moved after it is checked; a digest cannot.
- The signer is a workflow path inside the named repository. The check does not
  accept "any workflow of the repository".
- The source ref is `refs/heads/main`, the OIDC issuer is GitHub Actions, and
  self-hosted runners are denied.
- A missing argument, an unknown option or any `gh` failure is a non-zero exit.

## Identities

| Image | Signer workflow |
| --- | --- |
| `ghcr.io/branchleft/ghost-tenant` | `branchLeft/ghost-platform/.github/workflows/registry-push.yml` |
| `ghcr.io/branchleft/portal-apps` | `branchLeft/ghost-platform/.github/workflows/portal-apps-image.yml` |

The test for this script is `scripts/test-verify-image-attestation.sh`.
