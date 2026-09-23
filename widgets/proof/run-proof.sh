#!/bin/sh
# Live proof that zero widget bytes load from a third-party origin: a real
# pinned Ghost container, taken out of its compiled-default "Coming Soon"
# state by capture-network.mjs's own setup phase (owner setup, an
# announcement, a published post), fronted by the origin built in
# widgets/origin/, exercised by a real headless browser through the home
# page (with the admin-toolbar marker cookie set), Portal's sign-in
# overlay, search, the real published post (comments), and a signup-form
# embed built from Ghost's own live config.
#
# One GREEN baseline, then one RED pass per pinned override -- each removes
# exactly one env-var override, proving that specific bundle's pin is what
# closes it, not merely that the mechanism works for whichever one happens
# to get sabotaged -- then a final GREEN restores everything:
#   GREEN-1        -- every widget config key pointed at our origin
#   RED-<override>  -- one override removed, so Ghost (or, for signupForm,
#                      the config Ghost reports) falls back to its compiled
#                      default (the jsdelivr CDN) -- proves the assertion
#                      actually fails when that one control is absent
#   GREEN-2        -- every override restored, proving the fix is what closed it
#
# Usage: ./widgets/proof/run-proof.sh
# Run from the repo root (needs widgets/, the root Dockerfile, and Node with
# `playwright` installed -- see widgets/proof/package.json).
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

NET="widgets-proof-net-$$"
GHOST_NAME="widgets-proof-ghost-$$"
ORIGIN_NAME="widgets-proof-origin-$$"
HOST_PORT=4300
ORIGIN="http://localhost:${HOST_PORT}"

# One row per pinned override -- must match widgets/pins.json's envVar list.
OVERRIDES="portal__url sodoSearch__url sodoSearch__styles announcementBar__url comments__url adminToolbar__url signupForm__url"

cleanup() {
    docker rm -f "$GHOST_NAME" "$ORIGIN_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== Building images =="
docker build -q -t widgets-proof-ghost:local . >/dev/null
docker build -q -f widgets/origin/Dockerfile -t widgets-proof-origin:local . >/dev/null

docker network create "$NET" >/dev/null

# $1: a space-separated list of override env-var NAMEs to omit (sabotage).
# Everything else always runs -- SQLite + local storage, matching
# scripts/smoke-test.sh's existing dev/smoke-test posture.
start_ghost() {
    omit="$1"
    args="-d --name $GHOST_NAME --network $NET \
        -e url=$ORIGIN \
        -e database__client=sqlite3 \
        -e database__connection__filename=/var/lib/ghost/content/data/ghost-proof.db \
        -e privacy__useUpdateCheck=false \
        -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
        -e logging__transports='[\"stdout\"]'"

    add_unless_omitted() {
        key="$1"; val="$2"
        case " $omit " in
            *" $key "*) return ;;
        esac
        args="$args -e $key=$val"
    }

    add_unless_omitted portal__url "$ORIGIN/bl-assets/portal.min.js"
    add_unless_omitted sodoSearch__url "$ORIGIN/bl-assets/sodo-search.min.js"
    add_unless_omitted sodoSearch__styles "$ORIGIN/bl-assets/sodo-search.min.css"
    add_unless_omitted announcementBar__url "$ORIGIN/bl-assets/announcement-bar.min.js"
    add_unless_omitted comments__url "$ORIGIN/bl-assets/comments-ui.min.js"
    add_unless_omitted adminToolbar__url "$ORIGIN/bl-assets/admin-toolbar.min.js"
    add_unless_omitted signupForm__url "$ORIGIN/bl-assets/signup-form.min.js"

    eval docker run $args widgets-proof-ghost:local >/dev/null

    # Strict readiness: an HTTP 200 from Ghost itself, not merely a TCP
    # connect (see scripts/smoke-test.sh's own note on why). 127.0.0.1, not
    # localhost: this image's Alpine/musl base resolves "localhost" to ::1
    # first, and Ghost (like the image's own smoke test) binds IPv4 only --
    # busybox wget's connection to the IPv6 loopback is refused every time,
    # so an unqualified "localhost" here would time out on every run
    # regardless of whether Ghost is actually ready.
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

start_origin() {
    docker run -d --name "$ORIGIN_NAME" --network "$NET" \
        -p "${HOST_PORT}:8080" \
        -e "GHOST_UPSTREAM=${GHOST_NAME}:2368" \
        widgets-proof-origin:local >/dev/null

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
    PROOF_ORIGIN="$ORIGIN" PROOF_LABEL="$label" node widgets/proof/capture-network.mjs
}

run_pass() {
    # $1: label, $2: space-separated overrides to omit ("" for none)
    label="$1"; omit="$2"
    start_ghost "$omit"
    start_origin
    if run_capture "$label"; then status=0; else status=1; fi
    docker rm -f "$GHOST_NAME" "$ORIGIN_NAME" >/dev/null 2>&1
    return $status
}

echo "== GREEN-1: every override set =="
if run_pass GREEN-1 ""; then GREEN1_STATUS=0; else GREEN1_STATUS=1; fi

ALL_RED_OK=1
for OVR in $OVERRIDES; do
    echo
    echo "== RED: ${OVR} removed (sabotage) =="
    if run_pass "RED-${OVR}" "$OVR"; then
        echo "RED-${OVR}: PASS -- WRONG, sabotage was not detected"
        ALL_RED_OK=0
    else
        echo "RED-${OVR}: FAIL as expected (control proven)"
    fi
done

echo
echo "== GREEN-2: every override restored =="
if run_pass GREEN-2 ""; then GREEN2_STATUS=0; else GREEN2_STATUS=1; fi

echo
echo "== Summary =="
echo "GREEN-1 (baseline):        $([ "$GREEN1_STATUS" -eq 0 ] && echo PASS || echo FAIL)"
echo "RED (one pass per override, all want FAIL): $([ "$ALL_RED_OK" -eq 1 ] && echo 'all FAILED as expected (every override proven)' || echo 'AT LEAST ONE PASSED -- sabotage undetected for that override')"
echo "GREEN-2 (restored):        $([ "$GREEN2_STATUS" -eq 0 ] && echo PASS || echo FAIL)"

if [ "$GREEN1_STATUS" -eq 0 ] && [ "$ALL_RED_OK" -eq 1 ] && [ "$GREEN2_STATUS" -eq 0 ]; then
    echo
    echo "PROOF OK: the network assertion is green only when every override is in place, and removing any single one of the 7 pinned overrides is independently caught."
    exit 0
else
    echo
    echo "PROOF FAILED: see the pass that did not behave as expected above."
    exit 1
fi
