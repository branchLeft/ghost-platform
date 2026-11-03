#!/usr/bin/env bash
# Step-0 proof for the blog move's snapshot (option (c)): a consistent dump
# plus its binary-log coordinates, taking locks on one schema's tables only
# and never FLUSH TABLES WITH READ LOCK. Source and replica are throwaway
# containers of db1's pinned MySQL digest (read from db/RUNBOOK-db.md, never
# copied) with db/stack/conf.d/branchleft.cnf. The snapshot is taken by the
# real db/provision/bounded_snapshot.py; snapshot_probe.py holds the six
# controls and their verdicts. Containers, the network and every generated
# password are removed on exit. LOCAL CONTAINERS ONLY: nothing here reaches
# db1 or any host.
#
#   PROOF_CONTROLS="1 3"   run only those controls (default: 1 2 3 4 5 6)
#   SABOTAGE=<name>        break one mechanism and expect that control red:
#                          coordinates-after-write (1), old-path (2 and 3),
#                          reload-grant (4), no-timeout (5)
#   PROOF_PLATFORM=...     default linux/amd64, the hosts' architecture
#
# Exit 0: ALL PASSED. Exit 1: a sabotage run went red as it should. Exit 2:
# a sabotage run stayed green, so the control cannot see that failure. Exit 3:
# OPTION (c) UNAVAILABLE, a control from 1 to 5 failed un-sabotaged. Needs
# Docker and about 3 GB of memory. Scenarios and expected output:
# snapshot_probe.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PLATFORM="${PROOF_PLATFORM:-linux/amd64}"

# The one pinned digest db1 runs. A re-pin in the runbook re-points this proof.
PINS="$(grep -oE 'mysql:8\.0@sha256:[0-9a-f]{64}' db/RUNBOOK-db.md | sort -u)"
[ "$(printf '%s\n' "$PINS" | wc -l | tr -d ' ')" = "1" ] || {
    echo "FAILED: db/RUNBOOK-db.md must pin exactly one mysql:8.0 digest, found: $PINS" >&2
    exit 1
}
IMAGE="$PINS"

RUN=$$
NET="snapshot-proof-net-$RUN"
SRC="snapshot-proof-source-$RUN"
REP="snapshot-proof-replica-$RUN"
WORK="$(mktemp -d)"
chmod 700 "$WORK"

teardown() {
    docker rm -f "$SRC" "$REP" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "${WORK:?}"
}
trap teardown EXIT

fail() {
    echo "FAILED: $*" >&2
    exit 1
}

# Throwaway passwords, generated now, held only in this mode-700 directory and
# in the containers, removed with them. Never in a repo file, argv or output.
for name in root mover repl; do
    openssl rand -hex 16 >"$WORK/$name.pw"
    chmod 600 "$WORK/$name.pw"
done
MYSQL_ROOT_PASSWORD="$(cat "$WORK/root.pw")"
export MYSQL_ROOT_PASSWORD

# Name, then mysqld flags. The config is mounted unchanged; only the bind
# address (db1's private address) is overridden on the command line.
start_server() {
    docker run -d --platform "$PLATFORM" --name "$1" --network "$NET" -e MYSQL_ROOT_PASSWORD \
        -v "$REPO_ROOT/db/stack/conf.d/branchleft.cnf:/etc/mysql/conf.d/branchleft.cnf:ro" \
        "$IMAGE" --bind-address=0.0.0.0 "${@:2}" >/dev/null
}

# Readiness is a real query on the final server, never a ping: the image's
# entrypoint runs a socket-only bootstrap server first, then restarts.
wait_ready() {
    for _ in $(seq 1 240); do
        if docker logs "$1" 2>&1 | grep -q 'ready for connections.*port: 3306' &&
            [ "$(MYSQL_PWD="$MYSQL_ROOT_PASSWORD" docker exec -e MYSQL_PWD "$1" mysql -uroot -N -B -e 'SELECT @@port' 2>/dev/null)" = "3306" ]; then
            return 0
        fi
        sleep 1
    done
    fail "$1 never answered a real query"
}

echo "== setup: $IMAGE on $PLATFORM"
docker network create "$NET" >/dev/null
start_server "$SRC"
start_server "$REP" --server-id=2 --replicate-wild-do-table='blog.%'
wait_ready "$SRC"
wait_ready "$REP"
echo "  source mysqld --version:  $(docker exec "$SRC" mysqld --version)"
echo "  replica mysqld --version: $(docker exec "$REP" mysqld --version)"

set +e
python3 db/provision/snapshot_probe.py run --source "$SRC" --replica "$REP" --workdir "$WORK" \
    --controls "${PROOF_CONTROLS:-1 2 3 4 5 6}" ${SABOTAGE:+--sabotage "$SABOTAGE"}
rc=$?
set -e
exit "$rc"
