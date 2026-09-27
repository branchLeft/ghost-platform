#!/bin/sh
# Regression test for the entrypoint's fail-closed storage guard
# (docker-entrypoint.branchleft.sh). Exercises both directions — configs
# that must be blocked, and configs that must be allowed to boot — because a
# guard that's too aggressive and refuses a correctly-configured tenant is
# its own production incident, just as dangerous in the opposite direction
# as the silent-local-storage failure it exists to prevent.
#
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/test-storage-guard.sh ghost-platform:local
set -e

IMAGE="${1:?usage: test-storage-guard.sh <image-tag>}"
COMMON_ENV="-e url=http://localhost:2368 -e database__client=sqlite3 -e database__connection__filename=/var/lib/ghost/content/data/ghost.db"
FAILURES=0

# assert_blocked NAME EXTRA_ENV...
# Runs the image with `docker run --rm` (foreground) so it exits on its own;
# asserts a non-zero exit code and that the guard's own FATAL message
# appears in the output, not just "something failed".
assert_blocked() {
    name="$1"
    shift
    echo "--- $name (expect: blocked) ---"
    # shellcheck disable=SC2086
    output="$(docker run --rm $COMMON_ENV "$@" "$IMAGE" 2>&1)" && rc=0 || rc=$?
    echo "$output"
    if [ "${rc:-0}" -eq 0 ]; then
        echo "FAIL: $name: container exited 0, expected non-zero (guard did not block)"
        FAILURES=$((FAILURES + 1))
        return
    fi
    if ! echo "$output" | grep -q "^FATAL:"; then
        echo "FAIL: $name: exited non-zero but no FATAL: message from the guard — is this actually the guard blocking, or something else failing?"
        FAILURES=$((FAILURES + 1))
        return
    fi
    echo "PASS: $name (exit $rc, guard message present)"
    echo
}

# assert_boots NAME PORT EXTRA_ENV...
# Runs the image detached, waits for a strict HTTP-200, then tears down.
assert_boots() {
    name="$1"
    port="$2"
    shift 2
    container="storage-guard-test-$$-$port"
    echo "--- $name (expect: boots, HTTP 200) ---"
    # shellcheck disable=SC2086
    docker run -d --name "$container" -p "$port:$port" -e PORT="$port" $COMMON_ENV "$@" "$IMAGE" >/dev/null

    ready=false
    i=0
    while [ "$i" -lt 60 ]; do
        code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/" || true)"
        if [ "$code" = "200" ]; then
            ready=true
            break
        fi
        i=$((i + 1))
        sleep 0.5
    done

    if [ "$ready" != "true" ]; then
        echo "FAIL: $name: never reached HTTP 200 within 30s"
        echo "--- logs ---"
        docker logs "$container" 2>&1 | tail -20
        FAILURES=$((FAILURES + 1))
    else
        echo "PASS: $name (HTTP 200 on port $port)"
    fi
    docker rm -f "$container" >/dev/null 2>&1 || true
    echo
}

# --- Must be blocked ---------------------------------------------------
#
# The four cases this control's own acceptance criteria name: a bare
# S3Storage, a bare local adapter, the decorator wrapping S3Storage with a
# required field missing, and (below, in "must boot") a complete wrapped
# configuration.

assert_blocked "no storage__images__adapter set, no escape hatch"

assert_blocked "storage__images__adapter set to a bare local adapter (not the decorator)" \
    -e storage__images__adapter=LocalImagesStorage

assert_blocked "storage__images__adapter set to bare S3Storage (not the decorator)" \
    -e storage__images__adapter=S3Storage \
    -e storage__images__wrappedConfig__bucket=some-bucket

assert_blocked "the decorator wrapping a local adapter" \
    -e storage__images__adapter=ScanningStorageAdapter \
    -e storage__images__wraps=LocalImagesStorage

assert_blocked "the decorator wrapping S3Storage with required fields missing" \
    -e storage__images__adapter=ScanningStorageAdapter \
    -e storage__images__wraps=S3Storage \
    -e storage__images__wrappedConfig__bucket=some-bucket

# --- Must be allowed to boot --------------------------------------------

assert_boots "escape hatch set, no storage config (local dev)" 4220 \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true

assert_boots "the decorator wrapping a complete S3Storage config, no escape hatch (production shape)" 4221 \
    -e storage__images__adapter=ScanningStorageAdapter \
    -e storage__images__wraps=S3Storage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__images__wrappedConfig__bucket=fake-bucket \
    -e storage__images__wrappedConfig__staticFileURLPrefix=content/images \
    -e storage__images__wrappedConfig__cdnUrl=https://storage.googleapis.com/fake-bucket \
    -e storage__images__wrappedConfig__multipartUploadThresholdBytes=10485760 \
    -e storage__images__wrappedConfig__multipartChunkSizeBytes=5242880 \
    -e storage__images__wrappedConfig__endpoint=https://storage.googleapis.com \
    -e storage__images__wrappedConfig__region=auto \
    -e storage__images__wrappedConfig__forcePathStyle=true \
    -e storage__images__wrappedConfig__accessKeyId=FAKEKEY \
    -e storage__images__wrappedConfig__secretAccessKey=FAKESECRET

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All storage-guard checks passed."
