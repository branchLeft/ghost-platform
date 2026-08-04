#!/bin/sh
# Local/CI smoke test for the branchLeft Ghost image.
#
# Boots the image against SQLite (dev/smoke-test only — see README.md;
# production tenants use Cloud SQL MySQL), waits for a strict HTTP-200
# readiness check (not just a TCP connect — see doc 06's retraction note on
# why a TCP-only check is misleading for Ghost's migration lock), then
# reports boot time and idle memory so they can be compared against doc 06's
# measured baseline (~1s warm cold start, ~180MB idle).
#
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/smoke-test.sh ghost-platform:local
#
# Runs the container on a deliberately non-default host port (4200 -> a
# non-default container $PORT of 4200 too) specifically to demonstrate that
# the image honours $PORT rather than assuming the upstream default of 2368.
#
# Sets BRANCHLEFT_ALLOW_LOCAL_STORAGE=true because this smoke test doesn't
# configure S3Storage — that's the entrypoint's fail-closed storage guard's
# explicit, deliberate local-dev escape hatch (see
# docker-entrypoint.branchleft.sh and scripts/test-storage-guard.sh, which
# exercises the guard itself, both the blocked and permitted paths).
set -e

IMAGE="${1:?usage: smoke-test.sh <image-tag>}"
PORT=4200
CONTAINER_NAME="ghost-platform-smoke-$$"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting $IMAGE on host port $PORT (container \$PORT=$PORT, SQLite backend)..."

docker run -d \
    --name "$CONTAINER_NAME" \
    -p "$PORT:$PORT" \
    -e PORT="$PORT" \
    -e url="http://localhost:$PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-smoke.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    "$IMAGE" >/dev/null

start_ts=$(date +%s)
deadline=$((start_ts + 60))
ready=false

while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || true)"
    if [ "$status" = "200" ]; then
        ready=true
        break
    fi
    sleep 0.5
done

end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

if [ "$ready" != "true" ]; then
    echo "FAILED: no HTTP 200 from http://localhost:$PORT/ within 60s (last status: $status)"
    echo "--- container logs ---"
    docker logs "$CONTAINER_NAME"
    exit 1
fi

echo "READY: HTTP 200 on port $PORT after ${elapsed}s (wall clock, includes fresh-SQLite migrations)"
echo
echo "curl -i http://localhost:$PORT/ (headers only):"
curl -sI "http://localhost:$PORT/"
echo
echo "Idle memory (docker stats, no-stream):"
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' "$CONTAINER_NAME"
