#!/bin/sh
# Proves the NODE_ENV gate LLD-3's gate-set table attributes to this
# component: "the container reports production, read from the process
# rather than from the file that configured it." LLD-2's own spike found
# that a container started with NODE_ENV away from "production" serves
# normally, answers every request and errors nothing -- so no health check
# and no smoke assertion can ever catch it, only an assertion that execs
# into the running process and asks it directly.
#
# This proves the assertion goes both ways: it passes for a correctly
# configured container, and -- the sabotage this story's Done-means
# requires -- it goes red for one started with NODE_ENV set away from
# "production", even though that container is otherwise indistinguishable:
# Ghost still answers 200 throughout.
#
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/test-node-env-gate.sh ghost-platform:local
set -e

GHOST_IMAGE="${1:?usage: test-node-env-gate.sh <platform-image-tag>}"
RUN_ID="$$"
GOOD_NAME="node-env-gate-test-good-$RUN_ID"
BAD_NAME="node-env-gate-test-bad-$RUN_ID"
GOOD_PORT=4220
BAD_PORT=4221
FAILURES=0

cleanup() {
    docker rm -f "$GOOD_NAME" >/dev/null 2>&1 || true
    docker rm -f "$BAD_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# node_env_of NAME -> the value process.env.NODE_ENV reports **inside the
# running container**, via a fresh `docker exec` -- never read from this
# script's own environment, from the image, or from anything that merely
# configured the container. "<unset>" rather than an empty string, so an
# unset value and an explicitly empty one are distinguishable in output.
# The exec'd process gets nothing from this shell's own environment beyond
# what `docker exec` always passes (the target container's own env) --
# there is no `-e` here to leak anything through.
node_env_of() {
    docker exec "$1" node -e 'process.stdout.write(process.env.NODE_ENV === undefined ? "<unset>" : process.env.NODE_ENV)'
}

http_status() {
    curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$1" 2>/dev/null || true
}

wait_for_ghost() {
    port="$1"
    deadline=$(($(date +%s) + 60))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if [ "$(http_status "http://localhost:$port/")" = "200" ]; then
            return 0
        fi
        sleep 0.2
    done
    return 1
}

echo "Platform image under test: $GHOST_IMAGE"
echo

echo "--- control: a correctly configured slot (NODE_ENV=production) ---"
docker run -d \
    --name "$GOOD_NAME" \
    -p "$GOOD_PORT:2368" \
    -e url="https://localhost:$GOOD_PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-node-env-test.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    -e NODE_ENV="production" \
    "$GHOST_IMAGE" >/dev/null

if ! wait_for_ghost "$GOOD_PORT"; then
    echo "FAIL: the control container never answered 200"
    docker logs "$GOOD_NAME" 2>&1 | tail -40
    exit 1
fi

good_env="$(node_env_of "$GOOD_NAME")"
if [ "$good_env" = "production" ]; then
    echo "PASS: gate holds -- the running process reports NODE_ENV=production"
else
    echo "FAIL: gate should have held (expected production, got $good_env)"
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- sabotage: the same slot started with NODE_ENV=development ---"
docker run -d \
    --name "$BAD_NAME" \
    -p "$BAD_PORT:2368" \
    -e url="https://localhost:$BAD_PORT" \
    -e database__client="sqlite3" \
    -e database__connection__filename="/var/lib/ghost/content/data/ghost-node-env-test.db" \
    -e privacy__useUpdateCheck="false" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE="true" \
    -e NODE_ENV="development" \
    "$GHOST_IMAGE" >/dev/null

if ! wait_for_ghost "$BAD_PORT"; then
    echo "FAIL: the sabotaged container never answered 200 -- this gate needs it healthy to prove anything"
    docker logs "$BAD_NAME" 2>&1 | tail -40
    exit 1
fi
echo "confirmed: Ghost answers 200 with NODE_ENV=development -- serving normally, erroring nothing, per LLD-2's own finding"

bad_env="$(node_env_of "$BAD_NAME")"
if [ "$bad_env" != "production" ]; then
    echo "PASS: gate goes red -- the running process reports NODE_ENV=$bad_env, not production, while every other check on this container would still be green"
else
    echo "FAIL: gate should have gone red (expected something other than production, got $bad_env) -- the sabotage did not reach the check"
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "NODE_ENV gate proven both ways."
