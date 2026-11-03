#!/bin/sh
# Verifies that a container image was built and attested by the expected
# workflow of this repository, on `main`. This is the one home of the verify
# command: the publish workflows call it through
# .github/actions/attest-and-verify-image, and the host-side check that decides
# whether to run an image reuses it as it is.
#
# It is fail closed. A reference that is not digest-qualified, a missing or
# surplus argument, an identity that is not shaped like this repository's
# workflow, or any `gh` failure is a non-zero exit. Exit 0 means gh verified
# an attestation for exactly that digest, signed by exactly that workflow file,
# run from refs/heads/main on a GitHub-hosted runner.
#
# Usage:
#   ./scripts/verify-image-attestation.sh <registry/name@sha256:64hex> \
#       <owner/repo> <owner/repo/.github/workflows/file.yml> [--bundle-from-oci]
#
# VERIFY_PLAIN_ERRORS=1 prints each refusal as plain text rather than as a
# ::error:: workflow annotation. The publish workflow sets it for a retried
# attempt and for the wrong-identity check, where a refusal is expected or will
# be retried, so only a final failure paints the run red.
set -eu

if [ "${VERIFY_PLAIN_ERRORS:-0}" = 1 ]; then ERR="error: "; else ERR="::error::"; fi

usage() {
  echo "usage: $0 <registry/name@sha256:64hex> <owner/repo> <owner/repo/.github/workflows/file.yml> [--bundle-from-oci]" >&2
  exit 2
}

if [ "$#" -ne 3 ] && [ "$#" -ne 4 ]; then
  usage
fi

IMAGE_REF="$1"
REPO="$2"
SIGNER_WORKFLOW="$3"
BUNDLE_FLAG=""
if [ "$#" -eq 4 ]; then
  if [ "$4" != "--bundle-from-oci" ]; then
    echo "${ERR}unknown option: $4" >&2
    usage
  fi
  BUNDLE_FLAG="--bundle-from-oci"
fi

# The digest is what the attestation is bound to. A tag can move after it is
# checked, so a tag-form reference verifies nothing about what a host pulls.
if ! printf '%s' "$IMAGE_REF" | grep -Eq '^[a-z0-9][a-z0-9.-]*(:[0-9]+)?/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'; then
  echo "${ERR}refusing '$IMAGE_REF': an image must be named by digest (registry/name@sha256:<64 hex>), in lower case" >&2
  exit 1
fi

if ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  echo "${ERR}refusing '$REPO': expected owner/repo" >&2
  exit 1
fi

# The signer must be a workflow file inside that same repository.
case "$SIGNER_WORKFLOW" in
  "$REPO"/.github/workflows/?*) ;;
  *)
    echo "${ERR}refusing '$SIGNER_WORKFLOW': expected $REPO/.github/workflows/<file>" >&2
    exit 1
    ;;
esac

# BUNDLE_FLAG is deliberately unquoted: empty must expand to no argument.
# shellcheck disable=SC2086
if ! gh attestation verify "oci://$IMAGE_REF" \
  --repo "$REPO" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --source-ref refs/heads/main \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners \
  $BUNDLE_FLAG; then
  echo "${ERR}no valid attestation for $IMAGE_REF from $SIGNER_WORKFLOW on refs/heads/main" >&2
  exit 1
fi

echo "verified: $IMAGE_REF was attested by $SIGNER_WORKFLOW on refs/heads/main"
