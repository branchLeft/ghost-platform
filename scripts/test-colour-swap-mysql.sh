#!/bin/sh
# The MySQL half of the colour-swap proof (test-colour-swap.sh is the
# SQLite half): two real Ghost containers, one real MySQL database, proving
# the swap in each order and the drain-flag sabotage are backend-agnostic --
# neither depends on SQLite's own single-writer file lock. Does not repeat
# the SQLite-specific busy-error measurement (SQLite's own contention shape
# has no MySQL equivalent worth counting the same way).
#
# Usage:
#   docker build -t ghost-platform:local .
#   (build drain-sidecar:local -- see the PR body for tonight's workaround
#    for the dead GitHub Packages token the real Dockerfile needs)
#   ./scripts/test-colour-swap-mysql.sh drain-sidecar:local ghost-platform:local
set -e

SIDECAR_IMAGE="${1:?usage: test-colour-swap-mysql.sh <sidecar-image-tag> <platform-image-tag>}"
GHOST_IMAGE="${2:?usage: test-colour-swap-mysql.sh <sidecar-image-tag> <platform-image-tag>}"

RUN_ID="$$"
NETWORK="colour-swap-mysql-net-$RUN_ID"
MYSQL_NAME="colour-swap-mysql-$RUN_ID"
GHOST_A="colour-swap-mysql-ghost-a-$RUN_ID"
GHOST_B="colour-swap-mysql-ghost-b-$RUN_ID"
SIDECAR_A="colour-swap-mysql-sidecar-a-$RUN_ID"
SIDECAR_B="colour-swap-mysql-sidecar-b-$RUN_ID"
GHOST_A_PORT=4240
GHOST_B_PORT=4241
SIDECAR_A_PORT=4242
SIDECAR_B_PORT=4243
# A throwaway password for a throwaway container on a throwaway network,
# never reused outside this one run -- not a secret worth the keychain
# handling the no-prompt rules reserve for real credentials.
MYSQL_PW="colour-swap-test-only"
FLAG_DIR="$(mktemp -d)"
chmod 0755 "$FLAG_DIR"
FLAG_A="$FLAG_DIR/0-a.drain"
FLAG_B="$FLAG_DIR/0-b.drain"
FAILURES=0

cleanup() {
    docker rm -f "$SIDECAR_A" "$SIDECAR_B" "$GHOST_A" "$GHOST_B" "$MYSQL_NAME" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    rm -rf "$FLAG_DIR"
}
trap cleanup EXIT

echo "Platform image under test: $GHOST_IMAGE"
echo "Sidecar image under test: $SIDECAR_IMAGE"
echo

docker network create "$NETWORK" >/dev/null

http_probe() {
    curl -s -o "$2" -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$1" 2>/dev/null || true
}
http_status() {
    http_probe "$1" /dev/null
}

echo "--- starting one real MySQL, one database, for both colours to share ---"
docker run -d \
    --name "$MYSQL_NAME" \
    --network "$NETWORK" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_PW" \
    -e MYSQL_DATABASE="ghost_colour_swap_test" \
    mysql:8.0 >/dev/null
deadline=$(($(date +%s) + 60))
mysql_ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker exec "$MYSQL_NAME" mysqladmin ping -uroot -p"$MYSQL_PW" --silent >/dev/null 2>&1; then
        mysql_ready=true
        break
    fi
    sleep 1
done
if [ "$mysql_ready" != "true" ]; then
    echo "FAIL: MySQL never became ready within 60s"
    docker logs "$MYSQL_NAME" 2>&1 | tail -30
    exit 1
fi
# mysqladmin ping above succeeds over MySQL's own local socket slightly
# before its TCP listener accepts connections from other containers on
# this network -- Ghost's own knex-migrator does not retry a refused
# connection, so a Ghost started right on ping's heels can lose that race
# outright (observed: ECONNREFUSED on the very first attempt). A few
# seconds of margin here is cheaper than teaching Ghost to retry.
sleep 5
echo "PASS: MySQL is ready"
echo

start_ghost() {
    name="$1"; ghost_port="$2"; sidecar_port="$3"
    docker run -d \
        --name "$name" \
        --network "$NETWORK" \
        -p "$ghost_port:2368" \
        -p "$sidecar_port:$sidecar_port" \
        -e url="https://localhost:$ghost_port" \
        -e database__client="mysql" \
        -e database__connection__host="$MYSQL_NAME" \
        -e database__connection__port="3306" \
        -e database__connection__user="root" \
        -e database__connection__password="$MYSQL_PW" \
        -e database__connection__database="ghost_colour_swap_test" \
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
        "$GHOST_IMAGE" >/dev/null
}

start_sidecar() {
    name="$1"; ghost_name="$2"; port="$3"; flag="$4"
    docker run -d \
        --name "$name" \
        --network "container:$ghost_name" \
        -v "$FLAG_DIR:/var/run/branchleft:ro" \
        -e DRAIN_FLAG_PATH="/var/run/branchleft/$(basename "$flag")" \
        -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" \
        -e PORT="$port" \
        "$SIDECAR_IMAGE" >/dev/null
}

wait_for_status() {
    url="$1"; want="$2"; timeout_s="$3"; label="$4"
    deadline=$(($(date +%s) + timeout_s))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(http_status "$url")"
        [ "$status" = "$want" ] && return 0
        sleep 0.2
    done
    echo "FAIL: $label never reached $want within ${timeout_s}s (last: $status)"
    FAILURES=$((FAILURES + 1))
    return 1
}
assert_status_now() {
    got="$(http_status "$1")"
    if [ "$got" = "$2" ]; then echo "PASS: $3 (got $got)"; else echo "FAIL: $3 (expected $2, got $got)"; FAILURES=$((FAILURES + 1)); fi
}

echo "--- colour a: boots drained, migrates the real MySQL database, then serves ---"
touch "$FLAG_A"
touch "$FLAG_B"
start_ghost "$GHOST_A" "$GHOST_A_PORT" "$SIDECAR_A_PORT"
start_sidecar "$SIDECAR_A" "$GHOST_A" "$SIDECAR_A_PORT" "$FLAG_A"
wait_for_status "http://localhost:$GHOST_A_PORT/" 200 90 "Ghost A boot against MySQL" || { docker logs "$GHOST_A" 2>&1 | tail -40; exit 1; }
assert_status_now "http://localhost:$SIDECAR_A_PORT/healthz" 503 "colour a's sidecar is 503 while its flag is set, even though Ghost/MySQL are healthy"
rm -f "$FLAG_A"
if wait_for_status "http://localhost:$SIDECAR_A_PORT/healthz" 200 10 "colour a's sidecar after clearing its flag"; then
    echo "PASS: colour a serves once its flag clears"
fi
echo

echo "--- colour b: boots drained against the SAME MySQL database while a keeps serving ---"
start_ghost "$GHOST_B" "$GHOST_B_PORT" "$SIDECAR_B_PORT"
start_sidecar "$SIDECAR_B" "$GHOST_B" "$SIDECAR_B_PORT" "$FLAG_B"
wait_for_status "http://localhost:$GHOST_B_PORT/" 200 90 "Ghost B boot against the same MySQL database" || { docker logs "$GHOST_B" 2>&1 | tail -40; exit 1; }
assert_status_now "http://localhost:$SIDECAR_A_PORT/healthz" 200 "colour a is still healthy and serving throughout b's boot"
assert_status_now "http://localhost:$SIDECAR_B_PORT/healthz" 503 "colour b's sidecar is still 503 -- its flag has not been cleared yet"
echo

echo "--- swap a -> b: clear b's flag, drain a, refused unless b is healthy first ---"
rm -f "$FLAG_B"
wait_for_status "http://localhost:$SIDECAR_B_PORT/healthz" 200 10 "colour b's sidecar after clearing its flag" || true
touch "$FLAG_A"
wait_for_status "http://localhost:$SIDECAR_A_PORT/healthz" 503 10 "colour a's sidecar after draining it" || true
assert_status_now "http://localhost:$SIDECAR_B_PORT/healthz" 200 "colour b is the only healthy upstream once a is drained -- swap into b complete, same MySQL database throughout"
echo

echo "--- swap back, b -> a -- the other order, same database ---"
touch "$FLAG_B"
sleep 0.3
rm -f "$FLAG_A"
wait_for_status "http://localhost:$SIDECAR_A_PORT/healthz" 200 10 "colour a's sidecar after the swap back" || true
assert_status_now "http://localhost:$SIDECAR_B_PORT/healthz" 503 "colour b was re-drained by the swap-back"
echo

echo "--- sabotage: both flags cleared, both colours healthy against the same MySQL database -> both answer 200 ---"
touch "$FLAG_B"
wait_for_status "http://localhost:$SIDECAR_B_PORT/healthz" 503 10 "colour b re-drained before this sabotage state" || true
rm -f "$FLAG_A"
rm -f "$FLAG_B"
wait_for_status "http://localhost:$SIDECAR_A_PORT/healthz" 200 10 "colour a healthy for the sabotage state" || true
wait_for_status "http://localhost:$SIDECAR_B_PORT/healthz" 200 10 "colour b healthy for the sabotage state" || true
STATUS_A="$(http_status "http://localhost:$SIDECAR_A_PORT/healthz")"
STATUS_B="$(http_status "http://localhost:$SIDECAR_B_PORT/healthz")"
if [ "$STATUS_A" = "200" ] && [ "$STATUS_B" = "200" ]; then
    echo "RED (expected, by construction): with no drain flag distinguishing the colours, BOTH answer 200 against the same MySQL database -- the same exposure the SQLite run showed, proving it is not a SQLite-specific artefact."
else
    echo "FAIL: the sabotage fixture itself is wrong -- expected both colours healthy with no flag set, got a=$STATUS_A b=$STATUS_B"
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo "All MySQL colour-swap checks passed."
