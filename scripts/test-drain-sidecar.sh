#!/bin/sh
# Proves the drain-sidecar's contract against a real Ghost container: with
# the broker's drain flag set, the sidecar answers 503 "drained" while Ghost
# itself still answers 200 -- the whole reason a slot's health comes from the
# sidecar rather than from Ghost (ghost-platform-docs/19-try-it-now-design/
# 02-broker-and-slot.html §01b). With the flag cleared, the sidecar answers
# 200. It also proves the two ways the sidecar must fail closed: flag clear
# but Ghost not yet ready, and a flag directory it cannot read.
#
# Both images under test are handed to this script rather than derived from
# it, so the proof always runs against what the platform actually builds:
# the platform image is `docker build .` from this repo's own root
# Dockerfile (the upstream Ghost base plus the branchLeft entrypoint
# wrapper -- the image a real tenant boots), not a second-hand copy of its
# `FROM` line.
#
# The sidecar under test always shares Ghost's network namespace (`docker
# run --network container:<id>`), matching the design's own term for how the
# two processes see one address -- including the unreadable-flag-directory
# state, which needs a genuinely healthy Ghost behind it: a sidecar that
# fails open on an unreadable flag would otherwise fall through to asking
# Ghost and get a 200, and an isolated network would hide that by making
# even the correct implementation answer 503 for the wrong reason (Ghost
# unreachable, not the flag). Docker requires port publishing to be declared
# on the container that owns the namespace, so every health port answered on
# this shared namespace is published on the Ghost container up front, even
# though the sidecar containers that will answer on them don't exist yet at
# that point.
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
UNREADABLE_VOLUME="drain-sidecar-test-unreadable-$RUN_ID"
FLAG_DIR="$(mktemp -d)"
FLAG_FILE="$FLAG_DIR/drain"
# 0755 grants the sidecar's uid (1000) the read+traverse (r-x) access
# README.md says the check needs, without being world-writable. `chmod
# 777` would also pass this test; it would not prove anything about the
# access the sidecar actually needs, which is only r-x -- what mode or
# owner a real deployment gives the directory is a host placement
# decision this script has no opinion on either.
chmod 0755 "$FLAG_DIR"
FAILURES=0

cleanup() {
    docker rm -f "$UNREADABLE_NAME" >/dev/null 2>&1 || true
    docker rm -f "$SIDECAR_NAME" >/dev/null 2>&1 || true
    docker rm -f "$GHOST_NAME" >/dev/null 2>&1 || true
    docker volume rm "$UNREADABLE_VOLUME" >/dev/null 2>&1 || true
    rm -rf "$FLAG_DIR"
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
    -p "$UNREADABLE_PORT:8081" \
    -e url="https://localhost:$GHOST_PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-drain-test.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    "$GHOST_IMAGE" >/dev/null

# Freezes every process in Ghost's container (cgroup freezer) before it can
# finish booting -- issued straight after `docker run -d` returns, well
# inside the several-second boot Ghost measures elsewhere. This is what
# makes "Ghost not ready" deterministic rather than a race the sidecar
# might or might not win: a local run that boots Ghost quickly used to make
# the window the next block probes vanish before the first curl ever fired.
# Pausing removes the variable entirely -- Ghost cannot become ready while
# frozen, however fast the machine is.
docker pause "$GHOST_NAME" >/dev/null

echo "--- starting sidecar (sharing Ghost's network namespace), flag directory mounted read-only via --mount type=bind ---"
# `--mount type=bind` (never `-v`, i.e. never the short form) is the load-
# bearing part of this line: `docker run -v` on a missing host path creates
# an empty, readable directory, silently, and the sidecar would then read
# "flag clear" from a directory nobody ever provisioned. `--mount type=bind`
# refuses to start against a missing source instead -- proven directly,
# below, in "a missing host path is refused rather than silently created".
docker run -d \
    --name "$SIDECAR_NAME" \
    --network "container:$GHOST_NAME" \
    --mount "type=bind,source=$FLAG_DIR,target=/var/run/branchleft,readonly" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8080" \
    "$SIDECAR_IMAGE" >/dev/null

# http_probe URL BODY_FILE -> sets $status via stdout to the HTTP code and
# writes the response body to BODY_FILE; empty status on a connection
# failure (curl not yet answering counts as "not ready" rather than
# aborting the whole script under set -e). Carries the same
# X-Forwarded-Proto header the edge sets on every real request -- Ghost's
# own port and every sidecar answer to it identically, so sending it
# everywhere keeps every check on the path production traffic takes.
http_probe() {
    curl -s -o "$2" -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$1" 2>/dev/null || true
}
http_status() {
    http_probe "$1" /dev/null
}

echo "--- state: flag clear, Ghost deterministically not ready (paused) -> 503, every sample ---"
# Three samples rather than one: the sidecar's own probe can time out
# (GHOST_PROBE_TIMEOUT_MS, 2s default) as readily as it can see a refused
# connection while Ghost is frozen, and both are "not ready" -- sampling
# more than once is what would catch a flaky pass-on-the-first-try that a
# single request could hide.
body_file="$(mktemp)"
for _ in 1 2 3; do
    status="$(http_probe "http://localhost:$SIDECAR_PORT/healthz" "$body_file")"
    if [ "$status" != "503" ] || ! grep -q '"ghost_unhealthy"' "$body_file"; then
        echo "FAIL: expected 503 \"ghost_unhealthy\" while Ghost is paused, got $status: $(cat "$body_file" 2>/dev/null)"
        FAILURES=$((FAILURES + 1))
        break
    fi
done
echo "PASS: sidecar answered 503 \"ghost_unhealthy\" on every sample while Ghost was paused"
rm -f "$body_file"

docker unpause "$GHOST_NAME" >/dev/null

deadline=$(($(date +%s) + 60))
ghost_ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/healthz")"
    if [ "$status" = "200" ]; then
        ghost_ready=true
        break
    fi
    sleep 0.1
done
if [ "$ghost_ready" != "true" ]; then
    echo "FAIL: sidecar never answered 200 within 60s of Ghost being unpaused (last: $status)"
    echo "--- Ghost logs ---"
    docker logs "$GHOST_NAME" 2>&1 | tail -40
    echo "--- sidecar logs ---"
    docker logs "$SIDECAR_NAME" 2>&1 | tail -40
    exit 1
fi
echo "Ghost and sidecar both ready."
echo

echo "--- state: --mount type=bind against a missing host path is refused rather than silently created ---"
MISSING_FLAG_DIR="$(mktemp -d)/does-not-exist"
missing_path_output="$(mktemp)"
if docker run --rm \
    --network "container:$GHOST_NAME" \
    --mount "type=bind,source=$MISSING_FLAG_DIR,target=/var/run/branchleft,readonly" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8082" \
    "$SIDECAR_IMAGE" true >"$missing_path_output" 2>&1; then
    echo "FAIL: docker accepted --mount type=bind against a missing host path -- exactly the silent-empty-directory bug this mount form exists to avoid"
    cat "$missing_path_output"
    FAILURES=$((FAILURES + 1))
else
    echo "PASS: docker refused to start against a missing host path"
fi
rm -f "$missing_path_output"
rmdir "$(dirname "$MISSING_FLAG_DIR")" 2>/dev/null || true
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
    "http://localhost:$SIDECAR_PORT/healthz" 200
echo

echo "--- state: flag set ---"
touch "$FLAG_FILE"
# The flag is a file the broker writes; a filesystem-backed bind mount can
# lag by a beat behind the touch on some Docker Desktop backends, so this
# polls rather than asserting on the very next request. The body, not just
# the status, is checked -- 503 alone doesn't distinguish "drained" from
# "Ghost unhealthy", and those are different states with the same code.
body_file="$(mktemp)"
deadline=$(($(date +%s) + 10))
drained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_probe "http://localhost:$SIDECAR_PORT/healthz" "$body_file")"
    if [ "$status" = "503" ] && grep -q '"drained"' "$body_file"; then
        drained=true
        break
    fi
    sleep 0.2
done
if [ "$drained" = "true" ]; then
    echo "PASS: sidecar answers 503 \"drained\" with the flag set (got $status)"
else
    echo "FAIL: sidecar never answered 503 \"drained\" within 10s of the flag being set (last status: $status, body: $(cat "$body_file" 2>/dev/null))"
    FAILURES=$((FAILURES + 1))
fi
rm -f "$body_file"
assert_status "Ghost itself still answers 200 while the sidecar is draining -- the two are independent signals" \
    "http://localhost:$GHOST_PORT/" 200
echo

echo "--- state: flag cleared again ---"
rm -f "$FLAG_FILE"
deadline=$(($(date +%s) + 10))
undrained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_status "http://localhost:$SIDECAR_PORT/healthz")"
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
# A root-owned, mode-0700 directory inside a genuine Docker volume -- not a
# bind mount of a host directory. Docker Desktop's virtiofs/gRPC-FUSE layer
# does not enforce host uid/gid permissions on a bind mount the way a
# native Linux mount does, so a bind mount here would pass this state
# whether or not the sidecar actually fails closed. A named volume's
# contents are real files inside the Docker daemon's own Linux filesystem,
# so the permission check below is genuine on every platform this script
# runs on. Seeded by running as root once, before the container under test
# -- which never runs as root -- ever touches it.
docker run --rm --user root \
    -v "$UNREADABLE_VOLUME:/vol" \
    "$SIDECAR_IMAGE" sh -c 'chmod 700 /vol && chown 0:0 /vol' >/dev/null

# Shares Ghost's network namespace like the main sidecar above: a sidecar
# that fails OPEN on an unreadable directory would fall through to asking a
# genuinely healthy Ghost and answer 200, and an isolated network would
# mask that bug by making even a fail-open sidecar answer 503 for the wrong
# reason (Ghost unreachable, not the flag) -- indistinguishable from the
# fix by this state alone.
docker run -d \
    --name "$UNREADABLE_NAME" \
    --network "container:$GHOST_NAME" \
    -v "$UNREADABLE_VOLUME:/var/run/branchleft:ro" \
    -e DRAIN_FLAG_PATH="/var/run/branchleft/drain" \
    -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
    -e PORT="8081" \
    "$SIDECAR_IMAGE" >/dev/null

body_file="$(mktemp)"
deadline=$(($(date +%s) + 10))
unreadable_failed_closed=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(http_probe "http://localhost:$UNREADABLE_PORT/healthz" "$body_file")"
    if [ "$status" = "503" ] && grep -q '"drained"' "$body_file"; then
        unreadable_failed_closed=true
        break
    fi
    sleep 0.2
done
if [ "$unreadable_failed_closed" = "true" ]; then
    echo "PASS: sidecar answers 503 \"drained\" when it cannot read the flag directory (got $status)"
else
    echo "FAIL: sidecar did not fail closed on an unreadable flag directory (last status: $status, body: $(cat "$body_file" 2>/dev/null))"
    echo "--- sidecar (unreadable-dir) logs ---"
    docker logs "$UNREADABLE_NAME" 2>&1 | tail -40
    FAILURES=$((FAILURES + 1))
fi
rm -f "$body_file"
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All drain-sidecar checks passed."
