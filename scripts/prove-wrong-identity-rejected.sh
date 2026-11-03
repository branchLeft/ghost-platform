#!/bin/sh
# Proves a wrong signer workflow is refused for its identity, through both
# verify paths. A network or TUF fault is not a refusal. Why: see the wrong
# identity section of scripts/verify-image-attestation.md.
#
# Usage:
#   ./scripts/prove-wrong-identity-rejected.sh <registry/name@sha256:64hex> \
#       <owner/repo> <owner/repo/.github/workflows/file.yml>
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <registry/name@sha256:64hex> <owner/repo> <owner/repo/.github/workflows/file.yml>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/verify-image-attestation.sh"
IMAGE_REF="$1"
REPO="$2"
WRONG="$3.sabotage"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# $1 is a label, $2 is the extra flag or an empty string.
prove_refused() {
  # The expected refusal is plain text, so it does not annotate the run.
  # shellcheck disable=SC2086
  if VERIFY_PLAIN_ERRORS=1 "$VERIFY" "$IMAGE_REF" "$REPO" "$WRONG" $2 >"$OUT" 2>&1; then
    echo "::error::a wrong signer workflow ($WRONG) was accepted $1: the verify check is vacuous"
    exit 1
  fi
  if ! grep -Eq 'no matching CertificateIdentity|Subject Alternative Name|Policy verification failed' "$OUT"; then
    echo "::error::a wrong signer workflow ($WRONG) was refused $1, but gh did not name the identity. Its output:"
    sed 's/^/    /' "$OUT"
    exit 1
  fi
  echo "refused $1 for the identity $WRONG:"
  sed 's/^/    /' "$OUT"
}

prove_refused "through the GitHub API" ""
prove_refused "from the registry bundle" "--bundle-from-oci"
echo "A wrong signer workflow was refused for its identity, as required."
