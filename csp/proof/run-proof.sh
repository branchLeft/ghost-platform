#!/bin/sh
# The live proof for the strict content policy (LLD-5 C1-C4's own "Done
# means"): a real pinned Ghost, a real theme, a real Caddy in front, a real
# headless Chromium -- driven through the exact attack the spike measured
# (05-gate-and-edge.html §04).
#
# 1. Boot a clean Ghost + this story's Caddy origin (self-hosted widgets,
#    from widgets/dist/, so Portal never reaches a third-party origin).
# 2. Take Ghost through setup and create one tagged, published post.
# 3. Derive the theme's real script-hash set from the CLEAN pages -- home,
#    post, tag, author -- with derive-script-hashes.mjs, exactly the way a
#    real theme-admission step would, before any attack exists.
# 4. Inject the same hostile codeinjection_head the spike used.
# 5. ROW A  -- no policy at all: the attack runs, zero violations (the
#    control: this proof's own harness can actually see the attack).
# 6. ROW B  -- the enforcing policy render-header.mjs renders through
#    render-core's own built output, with the derived hashes: the attack is
#    blocked, Portal's sign-in form still renders with its email field, and
#    exactly one violation fires (the attack alone).
# 7. ROW D (SABOTAGE) -- the real, unmutated "unavailable" policy
#    (script-src 'self', no hash allowance) wired in as an ENFORCING
#    Content-Security-Policy header rather than the Report-Only header its
#    own contentSecurityPolicyMode says to use -- the exact wiring bug this
#    story's fail-soft mark exists to prevent. The attack is still blocked,
#    but Ghost's own inline blocks (the theme helper, the JSON-LD block) are
#    now blocked too: MORE than one violation fires, and the "exactly one"
#    assertion goes red.
# 8. ROW B again -- the correct wiring restored: back to exactly one
#    violation, proving the sabotage is what broke it.
#
# Usage: ./csp/proof/run-proof.sh
# Needs Docker, and csp/proof's own `npm install` for Playwright (see
# csp/proof/package.json) -- kept out of the root package.json and out of
# CI deliberately, like widgets/proof/.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

NET="csp-proof-net-$$"
GHOST_NAME="csp-proof-ghost-$$"
ORIGIN_NAME="csp-proof-origin-$$"
HOST_PORT=4310
ORIGIN="http://localhost:${HOST_PORT}"

cleanup() {
    docker rm -f "$GHOST_NAME" "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== Building images =="
docker build -q -t csp-proof-ghost:local . >/dev/null
docker build -q -f csp/proof/Dockerfile -t csp-proof-origin:local . >/dev/null

docker network create "$NET" >/dev/null

start_ghost() {
    docker run -d --name "$GHOST_NAME" --network "$NET" \
        -e url="$ORIGIN" \
        -e database__client=sqlite3 \
        -e database__connection__filename=/var/lib/ghost/content/data/ghost-csp-proof.db \
        -e privacy__useUpdateCheck=false \
        -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
        -e logging__transports='["stdout"]' \
        -e portal__url="$ORIGIN/bl-assets/portal.min.js" \
        -e sodoSearch__url="$ORIGIN/bl-assets/sodo-search.min.js" \
        -e sodoSearch__styles="$ORIGIN/bl-assets/sodo-search.min.css" \
        csp-proof-ghost:local >/dev/null

    deadline=$(($(date +%s) + 90))
    until docker exec "$GHOST_NAME" wget -q -O /dev/null http://127.0.0.1:2368/ 2>/dev/null; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "FAILED: Ghost did not become ready within 90s" >&2
            docker logs "$GHOST_NAME" >&2
            exit 1
        fi
        sleep 1
    done
}

# $1: CSP_HEADER_NAME, $2: CSP_HEADER_VALUE
start_origin() {
    docker rm -f "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$ORIGIN_NAME" --network "$NET" \
        -p "${HOST_PORT}:8080" \
        -e "GHOST_UPSTREAM=${GHOST_NAME}:2368" \
        -e "CSP_HEADER_NAME=$1" \
        -e "CSP_HEADER_VALUE=$2" \
        csp-proof-origin:local >/dev/null

    deadline=$(($(date +%s) + 30))
    until curl -sf -o /dev/null "$ORIGIN/"; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "FAILED: origin did not become ready within 30s" >&2
            docker logs "$ORIGIN_NAME" >&2
            exit 1
        fi
        sleep 1
    done
}

run_capture() {
    label="$1"
    PROOF_ORIGIN="$ORIGIN" PROOF_LABEL="$label" node csp/proof/capture-csp.mjs
}

echo "== Booting Ghost (clean, no CSP header yet) =="
start_ghost
echo "== Booting origin (row A state: no Content-Security-Policy header) =="
start_origin "X-Csp-Proof-Row" "none"

echo "== Setting up content (owner, one tagged post) =="
eval "$(PROOF_ORIGIN="$ORIGIN" node csp/proof/setup-content.mjs)"
echo "post=$POST_SLUG tag=$TAG_SLUG author=$AUTHOR_SLUG"

echo "== Deriving the theme's script-hash set from the CLEAN pages =="
CLEAN_HASHES_JSON="$(GHOST_ORIGIN="$ORIGIN" CSP_DERIVE_PATHS="/,/${POST_SLUG}/,/tag/${TAG_SLUG}/,/author/${AUTHOR_SLUG}/" node csp/derive/derive-script-hashes.mjs)"
echo "$CLEAN_HASHES_JSON"
echo "$CLEAN_HASHES_JSON" | grep -q '"kind": "computed"' || { echo "FAILED: derivation did not compute a hash set" >&2; exit 1; }

echo "== Rendering the real enforcing header through render-core's own build =="
ROW_B_RENDERED="$(printf '%s' "$CLEAN_HASHES_JSON" | node csp/proof/render-header.mjs)"
ROW_B_MODE="$(printf '%s' "$ROW_B_RENDERED" | cut -f1)"
ROW_B_VALUE="$(printf '%s' "$ROW_B_RENDERED" | cut -f2)"
echo "row B mode=$ROW_B_MODE"
[ "$ROW_B_MODE" = "enforcing" ] || { echo "FAILED: expected an enforcing policy with a real hash set" >&2; exit 1; }

echo "== Injecting the attack (codeinjection_head) =="
PROOF_ORIGIN="$ORIGIN" PROOF_SESSION_COOKIE="$SESSION_COOKIE" node csp/proof/inject-attack.mjs

echo
echo "== ROW A: no policy -- the attack runs =="
ROW_A_JSON="$(run_capture ROW-A)"
echo "$ROW_A_JSON"
ROW_A_INJECTED="$(printf '%s' "$ROW_A_JSON" | grep -o '"injectedScriptRan": *[a-z]*' | grep -o '[a-z]*$')"
ROW_A_VIOLATIONS="$(printf '%s' "$ROW_A_JSON" | grep -c '"directive"' || true)"
if [ "$ROW_A_INJECTED" = "true" ] && [ "$ROW_A_VIOLATIONS" = "0" ]; then
    echo "ROW A: PASS (attack ran, zero violations -- the control)"
    ROW_A_OK=1
else
    echo "ROW A: FAIL (expected the attack to run with no policy in place)"
    ROW_A_OK=0
fi

echo
echo "== ROW B: enforcing policy with the derived hashes -- the attack is blocked =="
start_origin "Content-Security-Policy" "$ROW_B_VALUE"
ROW_B_JSON="$(run_capture ROW-B)"
echo "$ROW_B_JSON"
ROW_B_INJECTED="$(printf '%s' "$ROW_B_JSON" | grep -o '"injectedScriptRan": *[a-z]*' | grep -o '[a-z]*$')"
ROW_B_EMAILFIELDS="$(printf '%s' "$ROW_B_JSON" | grep -o '"emailFields": *[0-9]*' | grep -o '[0-9]*$')"
ROW_B_VIOLATIONS="$(printf '%s' "$ROW_B_JSON" | grep -c '"directive"' || true)"
if [ "$ROW_B_INJECTED" = "false" ] && [ "$ROW_B_EMAILFIELDS" = "1" ] && [ "$ROW_B_VIOLATIONS" = "1" ]; then
    echo "ROW B: PASS (attack blocked, Portal's email field renders, exactly one violation)"
    ROW_B_OK=1
else
    echo "ROW B: FAIL (expected the attack blocked, one email field, exactly one violation)"
    ROW_B_OK=0
fi

echo
echo "== ROW D (SABOTAGE): the real report-only policy wired in as an enforcing header =="
UNAVAILABLE_RENDERED="$(printf '%s' '{"kind":"unavailable"}' | node csp/proof/render-header.mjs)"
UNAVAILABLE_VALUE="$(printf '%s' "$UNAVAILABLE_RENDERED" | cut -f2)"
echo "unavailable-mode value (about to be wired in as if it were enforcing): $UNAVAILABLE_VALUE"
start_origin "Content-Security-Policy" "$UNAVAILABLE_VALUE"
ROW_D_JSON="$(run_capture ROW-D-SABOTAGE)"
echo "$ROW_D_JSON"
ROW_D_VIOLATIONS="$(printf '%s' "$ROW_D_JSON" | grep -c '"directive"' || true)"
if [ "$ROW_D_VIOLATIONS" = "1" ]; then
    echo "ROW D: FAIL -- WRONG, sabotage was not detected (still exactly one violation)"
    ROW_D_CAUGHT=0
else
    echo "ROW D: RED as expected ($ROW_D_VIOLATIONS violations -- Ghost's own inline blocks are now blocked too; control proven)"
    ROW_D_CAUGHT=1
fi

echo
echo "== ROW B again: correct wiring restored =="
start_origin "Content-Security-Policy" "$ROW_B_VALUE"
ROW_B2_JSON="$(run_capture ROW-B-RESTORED)"
echo "$ROW_B2_JSON"
ROW_B2_VIOLATIONS="$(printf '%s' "$ROW_B2_JSON" | grep -c '"directive"' || true)"
if [ "$ROW_B2_VIOLATIONS" = "1" ]; then
    echo "ROW B (restored): PASS (back to exactly one violation)"
    ROW_B2_OK=1
else
    ROW_B2_OK=0
fi

echo
echo "== Summary =="
echo "ROW A (control, no policy):            $([ "$ROW_A_OK" -eq 1 ] && echo PASS || echo FAIL)"
echo "ROW B (enforcing, derived hashes):      $([ "$ROW_B_OK" -eq 1 ] && echo PASS || echo FAIL)"
echo "ROW D (sabotage: mode flag ignored):    $([ "$ROW_D_CAUGHT" -eq 1 ] && echo 'RED as expected' || echo 'FAIL -- sabotage undetected')"
echo "ROW B restored:                         $([ "$ROW_B2_OK" -eq 1 ] && echo PASS || echo FAIL)"

if [ "$ROW_A_OK" -eq 1 ] && [ "$ROW_B_OK" -eq 1 ] && [ "$ROW_D_CAUGHT" -eq 1 ] && [ "$ROW_B2_OK" -eq 1 ]; then
    echo
    echo "PROOF OK: the strict content policy render-core renders, with a real derived hash set, blocks the injected script while Portal's sign-in form still renders -- and dropping the hashes (or ignoring the fail-soft mode flag) is independently caught."
    exit 0
else
    echo
    echo "PROOF FAILED: see the row that did not behave as expected above."
    exit 1
fi
