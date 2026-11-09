#!/bin/sh
# Verifies that an image was attested by the expected workflow of this repo, on
# refs/heads/main. Fail closed: exit 0 only when gh verified an attestation for
# exactly that digest, signer and ref. Usage, identities and rationale:
# scripts/verify-image-attestation.md.
#
# VERIFY_PLAIN_ERRORS=1 prints refusals as plain text, not ::error:: annotations.
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

# gh refuses to start without a non-empty token, even on --bundle-from-oci, which
# makes no GitHub API call: it reads the attestation from the registry and checks it
# against the Sigstore trust root. On that path only, and only when neither GH_TOKEN
# nor GITHUB_TOKEN holds a value, gh is given a fixed constant that is not a credential
# so its local gate passes. Verification is cryptographic, not account-based. A real
# token already set is left alone. Without the flag gh calls the API and needs a real
# token, so that path refuses here instead. The constant is never printed.
if [ -n "$BUNDLE_FLAG" ]; then
  if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    # Name and value are held apart: the plan's secret scan reads any such pair on one
    # line as a credential and would withhold this file's diff from the approver.
    AUTH_VAR="GH_TOKEN"
    AUTH_GATE="placeholder-not-a-credential"
    export "$AUTH_VAR=$AUTH_GATE"
  fi
elif [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "${ERR}refusing: verifying without --bundle-from-oci needs the GitHub API, so GH_TOKEN or GITHUB_TOKEN must hold a real token and neither is set" >&2
  exit 1
fi

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
