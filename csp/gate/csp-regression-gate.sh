#!/bin/sh
# The standing content-policy regression gate (
# LLD-5 05-gate-and-edge.html §04): a real headless Chromium loads a real
# Ghost through the edge policy with a hostile codeinjection_head, and the
# verdict (csp-regression-gate.mjs) must be GREEN: injected script did not
# run, Portal's sign-in form rendered, the only violation is the attack.
#
# Usage (Docker, and csp/proof's own npm install for Playwright):
#   ./csp/gate/csp-regression-gate.sh [--sabotage=no-policy|no-hashes] [IMAGE]
# IMAGE is a built platform image; omitted, one is built from the repo root.
# --sabotage serves the policy broken on purpose; the gate must exit non-zero:
#   no-policy  -> no Content-Security-Policy header: the injected script runs
#   no-hashes  -> script-src 'self' enforced with no hash allowance: Ghost's
#                 own inline blocks are blocked as well as the attack
# Prints one GATE_TIMING line (seconds) so LLD-4's release-timing claim can
# rest on a measured figure. Needs render-core built (npm run build there).
set -e

SABOTAGE=""
IMAGE=""
for arg in "$@"; do
    case "$arg" in
        --sabotage=no-policy | --sabotage=no-hashes) SABOTAGE="${arg#--sabotage=}" ;;
        --sabotage=*) echo "unknown sabotage: $arg" >&2; exit 2 ;;
        *) IMAGE="$arg" ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

NET="csp-gate-net-$$"
GHOST_NAME="csp-gate-ghost-$$"
ORIGIN_NAME="csp-gate-origin-$$"
HOST_PORT="${CSP_GATE_PORT:-4311}"
ORIGIN="http://localhost:${HOST_PORT}"

cleanup() {
    docker rm -f "$GHOST_NAME" "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
    IMAGE="csp-gate-ghost:local"
    docker build -q -t "$IMAGE" . >/dev/null
fi
docker build -q -f csp/proof/Dockerfile -t csp-gate-origin:local . >/dev/null
docker network create "$NET" >/dev/null

wait_for() { # description, deadline-seconds, command...
    desc="$1"; secs="$2"; shift 2
    deadline=$(($(date +%s) + secs))
    until "$@" 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "FAILED: $desc not ready within ${secs}s" >&2
            exit 2
        fi
        sleep 1
    done
}

docker run -d --name "$GHOST_NAME" --network "$NET" \
    -e url="$ORIGIN" \
    -e database__client=sqlite3 \
    -e database__connection__filename=/var/lib/ghost/content/data/ghost-csp-gate.db \
    -e privacy__useUpdateCheck=false \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e storage__images__adapter=ScanningStorageAdapter \
    -e storage__images__wraps=LocalImagesStorage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__media__adapter=ScanningStorageAdapter \
    -e storage__media__wraps=LocalMediaStorage \
    -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__files__adapter=ScanningStorageAdapter \
    -e storage__files__wraps=LocalFilesStorage \
    -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
    -e logging__transports='["stdout"]' \
    -e portal__url="$ORIGIN/bl-assets/portal.min.js" \
    -e sodoSearch__url="$ORIGIN/bl-assets/sodo-search.min.js" \
    -e sodoSearch__styles="$ORIGIN/bl-assets/sodo-search.min.css" \
    "$IMAGE" >/dev/null
wait_for "Ghost" 90 docker exec "$GHOST_NAME" wget -q -O /dev/null http://127.0.0.1:2368/

start_origin() { # header name, header value
    docker rm -f "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$ORIGIN_NAME" --network "$NET" -p "${HOST_PORT}:8080" \
        -e "GHOST_UPSTREAM=${GHOST_NAME}:2368" \
        -e "CSP_HEADER_NAME=$1" -e "CSP_HEADER_VALUE=$2" \
        csp-gate-origin:local >/dev/null
    wait_for "origin" 30 curl -sf -o /dev/null "$ORIGIN/"
}

start_origin "X-Csp-Gate-Marker" "none"
eval "$(PROOF_ORIGIN="$ORIGIN" node csp/proof/setup-content.mjs)"

# The theme-hash gate: derived from the CLEAN pages, before the attack.
PATHS="/,/${POST_SLUG}/,/tag/${TAG_SLUG}/,/author/${AUTHOR_SLUG}/"
GHOST_ORIGIN="$ORIGIN" CSP_DERIVE_PATHS="$PATHS" node csp/gate/theme-hash-gate.mjs >/dev/null \
    || { echo "THEME HASH GATE RED" >&2; exit 1; }
HASHES_JSON="$(GHOST_ORIGIN="$ORIGIN" CSP_DERIVE_PATHS="$PATHS" node csp/derive/derive-script-hashes.mjs)"
RENDERED="$(printf '%s' "$HASHES_JSON" | node csp/proof/render-header.mjs)"
GOOD_VALUE="$(printf '%s' "$RENDERED" | cut -f2)"
UNAVAILABLE_VALUE="$(printf '%s' '{"kind":"unavailable"}' | node csp/proof/render-header.mjs | cut -f2)"

PROOF_ORIGIN="$ORIGIN" PROOF_SESSION_COOKIE="$SESSION_COOKIE" node csp/proof/inject-attack.mjs >/dev/null

# The gate's own time starts here: policy applied, browser driven, verdict.
GATE_START="$(date +%s)"
case "$SABOTAGE" in
    no-policy) start_origin "X-Csp-Gate-Marker" "none" ;;
    no-hashes) start_origin "Content-Security-Policy" "$UNAVAILABLE_VALUE" ;;
    *) start_origin "Content-Security-Policy" "$GOOD_VALUE" ;;
esac
RUN_JSON="$(PROOF_ORIGIN="$ORIGIN" PROOF_LABEL="gate${SABOTAGE:+-$SABOTAGE}" node csp/proof/capture-csp.mjs)"
echo "$RUN_JSON"
set +e
printf '%s' "$RUN_JSON" | node csp/gate/csp-regression-gate.mjs
STATUS=$?
set -e
echo "GATE_TIMING seconds=$(($(date +%s) - GATE_START)) sabotage=${SABOTAGE:-none} exit=$STATUS"
exit "$STATUS"
