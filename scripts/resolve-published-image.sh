#!/bin/sh
# Prints <image>@sha256:<digest> for the image a publish workflow pushed from
# main most recently. Usage and reasons: scripts/resolve-published-image.md.
#
# Usage:
#   GH_TOKEN=<token that can read runs> ./scripts/resolve-published-image.sh \
#       <workflow-file> <ghcr.io/owner/name>
#   e.g. ./scripts/resolve-published-image.sh registry-push.yml ghcr.io/branchleft/ghost-tenant
#
# Only the run listing needs a token. The digest is read anonymously from the
# registry, from the tag the push gives each commit (its head sha).
set -eu

usage() {
  echo "usage: $0 <workflow-file> <ghcr.io/owner/name>" >&2
  exit 2
}

if [ "$#" -ne 2 ]; then
  usage
fi
WORKFLOW="$1"
IMAGE="$2"

case "$IMAGE" in
  ghcr.io/*/*) ;;
  *)
    echo "error: refusing '$IMAGE': expected ghcr.io/<owner>/<name>" >&2
    exit 2
    ;;
esac
REPO_PATH="${IMAGE#ghcr.io/}"
REPO="${GITHUB_REPOSITORY:-branchLeft/ghost-platform}"

# Prints the sha256 digest the registry holds for one tag, or nothing.
resolve_tag() {
  token_json="$(curl -fsS "https://ghcr.io/token?scope=repository:$REPO_PATH:pull")" || return 1
  token="$(printf '%s' "$token_json" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || return 1
  headers="$WORK/headers.$2"
  curl -fsS -o /dev/null -D "$headers" \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/$REPO_PATH/manifests/$2" || return 1
  digest="$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }')"
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
  printf '%s\n' "$digest"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Newest successful push runs of the workflow on main, newest first.
SHAS="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch main --event push \
  --status success --limit 20 --json headSha --jq '.[].headSha')"

for sha in $SHAS; do
  digest="$(resolve_tag "$REPO_PATH" "$sha")" || digest=""
  if [ -n "$digest" ]; then
    printf '%s@%s\n' "$IMAGE" "$digest"
    exit 0
  fi
done

echo "error: no successful $WORKFLOW push run on main has a $IMAGE tag at the registry" >&2
exit 1
