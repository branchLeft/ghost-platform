#!/bin/sh
# Proves the drain-sidecar's contract against a real Ghost container: with
# the broker's drain flag set, the sidecar answers 503 while Ghost itself
# still answers 200 -- the whole reason a slot's health comes from the
# sidecar rather than from Ghost (ghost-platform-docs/19-try-it-now-design/
# 02-broker-and-slot.html §01b). With the flag cleared, the sidecar answers
# 200. It also proves the two ways the sidecar must fail closed: while
# Ghost is still booting, and when the flag directory can't be read.
#
# Both images under test are handed to this script rather than derived from
# it, so the proof always runs against what the platform actually builds:
# the platform image is `docker build .` from this repo's own root
# Dockerfile (the upstream Ghost base plus the branchLeft entrypoint
# wrapper -- the image a real tenant boots), not a second-hand copy of its
# `FROM` line.
#
# The sidecar shares Ghost's network namespace (`docker run --network
# container:<id>`), matching the design's own term for how the two
# processes see one address. Docker requires port publishing to be declared
# on the container that owns the namespace, so both the Ghost port and the
# sidecar's health port are published on the Ghost container up front, even
# though the sidecar container that will answer on its port doesn't exist
# yet at that point.
#
# Ghost's own `url` is configured https here, as any real tenant's is
# (LLD-4 §U3b): a plaintext probe with no X-Forwarded-Proto header gets
# redirected onto a port nothing is listening on TLS for, so every curl
# call below carries the same header the edge sets on every real request.
#
# Usage:
#   docker build -t ghost-platform:local .
#   docker build -t drain-sidecar:local --secret id=node_auth_token,env=NODE_AUTH_TOKEN services/drain-sidecar
#   ./scripts/test-drain-sidecar.sh drain-sidecar:local ghost-platform:local
set -e

SIDECAR_IMAGE="${1:?usage: test-drain-sidecar.sh <sidecar-image-tag> <platform-image-tag>}"
GHOST_IMAGE="${2:?usage: test-drain-sidecar.sh <sidecar-image-tag> <platform-image-tag>}"

GHOST_PORT=4210
SIDECAR_PORT=4211
UNREADABLE_PORT=4212
RUN_ID="$$"
GHOST_NAME="drain-sidecar-test-ghost-$RUN_ID"
SIDECAR_NAME="drain-sidecar-test-sidecar-$RUN_ID"
UNREADABLE_NAME="drain-sidecar-test-unreadable-$RUN_ID"
FLAG_DIR="$(mktemp -d)"
FLAG_FILE="$FLAG_DIR/drain"
# 0755: readable and traversable by the sidecar's uid (1000) without being
# world-writable -- the arrangement README.md documents as what production
# must provide. `chmod 777` would also pass this test; it would not prove
# anything about the mode the sidecar actually needs.
chmod 0755 "$FLAG_DIR"
# Deliberately left at mktemp's own default (0700, owned by whoever runs
# this script) -- uid 1000 can neither read nor traverse it, which is
# exactly the "cannot tell" case the flag check must fail closed on.
UNREADABLE_DIR="$(mktemp -d)"
FAILURES=0

cleanup() {
    docker rm -f "$UNREADABLE_NAME" >/dev/null 2>&1 || true
    docker rm -f "$SIDECAR_NAME" >/dev/null 2>&1 || true
    docker rm -f "$GHOST_NAME" >/dev/null 2>&1 || true
    rm -rf "$FLAG_DIR" "$UNREADABLE_DIR"
}
trap cleanup EXIT

echo "Platform image under test: $GHOST_IMAGE"
echo "Sidecar image under test: $SIDECAR_IMAGE"
echo

echo "--- starting Ghost ---"
docker run -d \
    --name "$GHOST_NAME" \
    -p "$GHOST_PORT:2368" \
    -p "$SIDECAR_PORT:8080" \
    -e url="https://localhost:$GHOST_PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-drain-test.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    "$GHOST_IMAGE" >/dev/null

echo "--- starting sidecar immediately (sharing Ghost's network namespace) ---"
docker run -d \
    --name "$SIDECAR_NAME" \
    --network "container:$GHOST_NAME" \
    -v "$FLAG_DIR:/var/run/branchleft" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8080" \
    "$SIDECAR_IMAGE" >/dev/null

# http_status URL -> sets $status to the HTTP code, empty string on a
# connection failure (curl not yet answering counts as "not ready" rather
# than aborting the whole script under set -e). Carries the same
# X-Forwarded-Proto header the edge sets on every real request -- both
# Ghost's own port and the sidecar's answer to it identically, so sending
# it everywhere keeps every check on the path production traffic takes.
http_status() {
    curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$1" 2>/dev/null || true
}

echo "--- state: flag clear, Ghost still booting -> sidecar answers 503 (Ghost's own boot-time maintenance mode gives this for free) ---"
deadline=$(($(date +%s) + 60))
saw_503_while_booting=false
ghost_ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/health")"
    if [ "$status" = "503" ]; then
        saw_503_while_booting=true
    fi
    if [ "$status" = "200" ]; then
        ghost_ready=true
        break
    fi
    sleep 0.1
done
if [ "$ghost_ready" != "true" ]; then
    echo "FAIL: sidecar never answered 200 within 60s of Ghost starting (Ghost never became ready, last: $status)"
    echo "--- Ghost logs ---"
    docker logs "$GHOST_NAME" 2>&1 | tail -40
    echo "--- sidecar logs ---"
    docker logs "$SIDECAR_NAME" 2>&1 | tail -40
    exit 1
fi
if [ "$saw_503_while_booting" = "true" ]; then
    echo "PASS: sidecar answered 503 at least once while Ghost was still booting"
else
    echo "FAIL: never observed a 503 from the sidecar before Ghost became ready"
    FAILURES=$((FAILURES + 1))
fi
echo "Ghost and sidecar both ready."
echo

echo "--- state: flag cleared, Ghost healthy (baseline) ---"
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

echo "--- state: flag directory unreadable by the sidecar's uid -> fails closed ---"
docker run -d \
    --name "$UNREADABLE_NAME" \
    -p "$UNREADABLE_PORT:8080" \
    -v "$UNREADABLE_DIR:/var/run/branchleft" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8080" \
    "$SIDECAR_IMAGE" >/dev/null
deadline=$(($(date +%s) + 10))
unreadable_failed_closed=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$UNREADABLE_PORT/health")"
    if [ "$status" = "503" ]; then
        unreadable_failed_closed=true
        break
    fi
    sleep 0.2
done
if [ "$unreadable_failed_closed" = "true" ]; then
    echo "PASS: sidecar answers 503 when it cannot read the flag directory (got 503)"
else
    echo "FAIL: sidecar did not fail closed on an unreadable flag directory (last: $status)"
    echo "--- sidecar (unreadable-dir) logs ---"
    docker logs "$UNREADABLE_NAME" 2>&1 | tail -40
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All drain-sidecar checks passed."
