#!/bin/sh
# The live proof for the strict content policy: rows A/B/D/B drive a real
# Ghost, theme, Caddy and headless Chromium through the attack, then a wiring
# sabotage, to prove the enforcing policy -- and only the enforcing policy --
# blocks it.
# See run-proof.md for the row-by-row walkthrough and usage.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

NET="csp-proof-net-$$"
GHOST_NAME="csp-proof-ghost-$$"
ORIGIN_NAME="csp-proof-origin-$$"
HOST_PORT=4310
ORIGIN="http://localhost:${HOST_PORT}"

# Removes one container or network if it exists. A removal that fails is
# reported on stderr and returned as failure, never hidden.
remove_if_present() { # kind (container|network), name
    kind="$1"; name="$2"
    if [ "$kind" = container ]; then
        present="$(docker ps -aq --filter "name=^${name}\$")" \
            || { echo "could not list container $name" >&2; return 1; }
    else
        present="$(docker network ls -q --filter "name=^${name}\$")" \
            || { echo "could not list network $name" >&2; return 1; }
    fi
    [ -n "$present" ] || return 0
    if [ "$kind" = container ]; then
        docker rm -f "$name" >/dev/null || { echo "could not remove container $name" >&2; return 1; }
    else
        docker network rm "$name" >/dev/null || { echo "could not remove network $name" >&2; return 1; }
    fi
}

# Removes what a killed run left behind. Names carry the dead run's PID, so
# no later run would ever find them by name.
sweep_stale() {
    stale_c="$(docker ps -aq --filter "name=^csp-proof-")" \
        || { echo "FAILED: could not list stale containers" >&2; exit 1; }
    for c in $stale_c; do
        docker rm -f "$c" >/dev/null || { echo "FAILED: could not remove stale container $c" >&2; exit 1; }
    done
    stale_n="$(docker network ls -q --filter "name=^csp-proof-")" \
        || { echo "FAILED: could not list stale networks" >&2; exit 1; }
    for n in $stale_n; do
        docker network rm "$n" >/dev/null || { echo "FAILED: could not remove stale network $n" >&2; exit 1; }
    done
}

# Set to 0 by any failed removal. A green verdict requires it to stay 1.
CLEANUP_OK=1
CLEANUP_RAN=0
remove_run() {
    CLEANUP_RAN=1
    remove_if_present container "$GHOST_NAME" || CLEANUP_OK=0
    remove_if_present container "$ORIGIN_NAME" || CLEANUP_OK=0
    remove_if_present network "$NET" || CLEANUP_OK=0
}

cleanup() {
    rc=$?
    [ "$CLEANUP_RAN" -eq 1 ] || remove_run
    if [ "$CLEANUP_OK" -eq 0 ]; then
        echo "CLEANUP FAILED: this run's containers or network may be left behind" >&2
        [ "$rc" -eq 0 ] && rc=1
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sweep_stale

echo "== Building render-core (the proof renders through its built output) =="
( cd render-core && ${PNPM:-pnpm} install --frozen-lockfile >/dev/null && ${PNPM:-pnpm} run build >/dev/null )

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
    remove_if_present container "$ORIGIN_NAME" || { echo "FAILED: origin container could not be replaced" >&2; exit 1; }
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

# Home page only, derived from the CLEAN page (before the attack exists), for ROW E.
HOME_HASHES_JSON="$(GHOST_ORIGIN="$ORIGIN" CSP_DERIVE_PATHS="/" node csp/derive/derive-script-hashes.mjs)"

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
echo "== ROW E (SABOTAGE): one of the theme's derived hashes dropped -- an unhashed inline script must be refused =="
# The capture page is the home page, so drop, one at a time, each hash that
# page carries (some hashes cover blocks that never execute there, e.g. the
# JSON-LD). At least one drop must surface an extra violation: that block is
# an inline script the policy now refuses because it is no longer hashed.
HOME_COUNT="$(printf '%s' "$HOME_HASHES_JSON" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).hashes.length)')"
ROW_E_VIOLATIONS=0
ROW_E_JSON=""
i=0
while [ "$i" -lt "$HOME_COUNT" ]; do
    DROPPED_JSON="$(printf '%s' "$HOME_HASHES_JSON" | node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8"));t.hashes.splice(Number(process.argv[1]),1);process.stdout.write(JSON.stringify(t))' "$i")"
    ROW_E_VALUE="$(printf '%s' "$DROPPED_JSON" | node csp/proof/render-header.mjs | cut -f2)"
    start_origin "Content-Security-Policy" "$ROW_E_VALUE"
    CUR_JSON="$(run_capture ROW-E-SABOTAGE-drop-$i)"
    CUR_V="$(printf '%s' "$CUR_JSON" | grep -c '"directive"' || true)"
    echo "drop hash #$i: $CUR_V violation(s)"
    if [ "$CUR_V" -gt "$ROW_E_VIOLATIONS" ]; then ROW_E_VIOLATIONS="$CUR_V"; ROW_E_JSON="$CUR_JSON"; fi
    i=$((i + 1))
done
echo "$ROW_E_JSON"
ROW_E_VIOLATIONS="$(printf '%s' "$ROW_E_JSON" | grep -c '"directive"' || true)"
if [ "$ROW_E_VIOLATIONS" -gt 1 ]; then
    echo "ROW E: RED as expected ($ROW_E_VIOLATIONS violations -- the inline script whose hash was dropped is refused; control proven)"
    ROW_E_CAUGHT=1
else
    echo "ROW E: FAIL -- WRONG, an unhashed inline script was not refused ($ROW_E_VIOLATIONS violation)"
    ROW_E_CAUGHT=0
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
echo "ROW E (sabotage: hash dropped):      $([ "$ROW_E_CAUGHT" -eq 1 ] && echo 'RED as expected' || echo 'FAIL -- sabotage undetected')"
echo "ROW B restored:                         $([ "$ROW_B2_OK" -eq 1 ] && echo PASS || echo FAIL)"

remove_run
if [ "$ROW_A_OK" -eq 1 ] && [ "$ROW_B_OK" -eq 1 ] && [ "$ROW_D_CAUGHT" -eq 1 ] && [ "$ROW_E_CAUGHT" -eq 1 ] && [ "$ROW_B2_OK" -eq 1 ] && [ "$CLEANUP_OK" -eq 1 ]; then
    echo
    echo "PROOF OK: the strict content policy render-core renders, with a real derived hash set, blocks the injected script while Portal's sign-in form still renders -- and dropping the hashes (or ignoring the fail-soft mode flag) is independently caught."
    exit 0
else
    echo
    echo "PROOF FAILED: see the row that did not behave as expected above."
    exit 1
fi
