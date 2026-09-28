#!/bin/sh
# Local/CI smoke test for the branchLeft Ghost image. Boots against SQLite,
# waits for a strict HTTP-200 readiness check, then reports boot time and
# idle memory against a measured baseline.
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/smoke-test.sh ghost-platform:local
# See scripts/smoke-test.md#why-these-choices.
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
    -e storage__images__adapter="ScanningStorageAdapter" \
    -e storage__images__wraps="LocalImagesStorage" \
    -e storage__images__quarantinePath="/var/lib/ghost/content/quarantine" \
    -e storage__media__adapter="ScanningStorageAdapter" \
    -e storage__media__wraps="LocalMediaStorage" \
    -e storage__media__quarantinePath="/var/lib/ghost/content/quarantine" \
    -e storage__files__adapter="ScanningStorageAdapter" \
    -e storage__files__wraps="LocalFilesStorage" \
    -e storage__files__quarantinePath="/var/lib/ghost/content/quarantine" \
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
