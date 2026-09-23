#!/bin/sh
# Proves the drain-sidecar's contract against a real Ghost container: with
# the broker's drain flag set, the sidecar answers 503 while Ghost itself
# still answers 200 -- the whole reason a slot's health comes from the
# sidecar rather than from Ghost (ghost-platform-docs/19-try-it-now-design/
# 02-broker-and-slot.html §01b). With the flag cleared, the sidecar answers
# 200.
#
# The Ghost image is read out of this repo's own Dockerfile rather than
# pinned a second time here, so this test always runs against the image the
# platform actually ships, not a copy that can drift from it.
#
# The sidecar shares Ghost's network namespace (`docker run --network
# container:<id>`), matching the design's own term for how the two
# processes see one address. Docker requires port publishing to be declared
# on the container that owns the namespace, so both the Ghost port and the
# sidecar's health port are published on the Ghost container up front, even
# though the sidecar container that will answer on its port doesn't exist
# yet at that point.
#
# Usage:
#   docker build -t drain-sidecar:local --secret id=node_auth_token,env=NODE_AUTH_TOKEN services/drain-sidecar
#   ./scripts/test-drain-sidecar.sh drain-sidecar:local
set -e

SIDECAR_IMAGE="${1:?usage: test-drain-sidecar.sh <sidecar-image-tag>}"
GHOST_IMAGE="$(grep '^FROM' Dockerfile | head -1 | awk '{print $2}')"

GHOST_PORT=4210
SIDECAR_PORT=4211
RUN_ID="$$"
GHOST_NAME="drain-sidecar-test-ghost-$RUN_ID"
SIDECAR_NAME="drain-sidecar-test-sidecar-$RUN_ID"
FLAG_DIR="$(mktemp -d)"
FLAG_FILE="$FLAG_DIR/drain"
FAILURES=0

cleanup() {
    docker rm -f "$SIDECAR_NAME" >/dev/null 2>&1 || true
    docker rm -f "$GHOST_NAME" >/dev/null 2>&1 || true
    rm -rf "$FLAG_DIR"
}
trap cleanup EXIT

echo "Ghost image (read from this repo's Dockerfile): $GHOST_IMAGE"
echo "Sidecar image under test: $SIDECAR_IMAGE"
echo

echo "--- starting Ghost ---"
docker run -d \
    --name "$GHOST_NAME" \
    -p "$GHOST_PORT:2368" \
    -p "$SIDECAR_PORT:8080" \
    -e url="http://localhost:$GHOST_PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-drain-test.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    "$GHOST_IMAGE" >/dev/null

echo "--- starting sidecar (sharing Ghost's network namespace) ---"
docker run -d \
    --name "$SIDECAR_NAME" \
    --network "container:$GHOST_NAME" \
    -v "$FLAG_DIR:/var/run/branchleft" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8080" \
    "$SIDECAR_IMAGE" >/dev/null

# ghost_status / sidecar_status: NAME URL -> sets $status to the HTTP code,
# empty string on a connection failure (curl not yet answering counts as
# "not ready" rather than aborting the whole script under set -e).
http_status() {
    curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true
}

echo "--- waiting for Ghost to answer 200 ---"
deadline=$(($(date +%s) + 60))
ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$GHOST_PORT/")"
    if [ "$status" = "200" ]; then
        ready=true
        break
    fi
    sleep 0.5
done
if [ "$ready" != "true" ]; then
    echo "FAIL: Ghost never answered 200 within 60s (last status: $status)"
    echo "--- Ghost logs ---"
    docker logs "$GHOST_NAME" 2>&1 | tail -40
    exit 1
fi
echo "Ghost ready."
echo

echo "--- waiting for the sidecar to answer at all ---"
deadline=$(($(date +%s) + 30))
ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/health")"
    if [ -n "$status" ] && [ "$status" != "000" ]; then
        ready=true
        break
    fi
    sleep 0.5
done
if [ "$ready" != "true" ]; then
    echo "FAIL: sidecar never answered within 30s"
    echo "--- sidecar logs ---"
    docker logs "$SIDECAR_NAME" 2>&1 | tail -40
    exit 1
fi
echo "Sidecar reachable."
echo

# assert_status NAME URL EXPECTED
assert_status() {
    name="$1"
    url="$2"
    expected="$3"
    got="$(http_status "$url")"
    if [ "$got" = "$expected" ]; then
        echo "PASS: $name (got $got)"
    else
        echo "FAIL: $name (expected $expected, got $got)"
        FAILURES=$((FAILURES + 1))
    fi
}

echo "--- state: flag cleared (baseline) ---"
assert_status "sidecar answers 200 with the flag clear and Ghost healthy" \
    "http://localhost:$SIDECAR_PORT/health" 200
echo

echo "--- state: flag set ---"
touch "$FLAG_FILE"
# The flag is a file the broker writes; a filesystem-backed bind mount can
# lag by a beat behind the touch on some Docker Desktop backends, so this
# polls rather than asserting on the very next request.
deadline=$(($(date +%s) + 10))
drained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/health")"
    if [ "$status" = "503" ]; then
        drained=true
        break
    fi
    sleep 0.2
done
if [ "$drained" = "true" ]; then
    echo "PASS: sidecar answers 503 with the flag set (got 503)"
else
    echo "FAIL: sidecar never answered 503 within 10s of the flag being set (last: $status)"
    FAILURES=$((FAILURES + 1))
fi
assert_status "Ghost itself still answers 200 while the sidecar is draining -- the two are independent signals" \
    "http://localhost:$GHOST_PORT/" 200
echo

echo "--- state: flag cleared again ---"
rm -f "$FLAG_FILE"
deadline=$(($(date +%s) + 10))
undrained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/health")"
    if [ "$status" = "200" ]; then
        undrained=true
        break
    fi
    sleep 0.2
done
if [ "$undrained" = "true" ]; then
    echo "PASS: sidecar answers 200 again once the flag is removed (got 200)"
else
    echo "FAIL: sidecar never returned to 200 within 10s of the flag being removed (last: $status)"
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All drain-sidecar checks passed."
