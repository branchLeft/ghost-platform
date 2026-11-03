#!/usr/bin/env bash
# Step-0 proof for the blog move's snapshot (option (c)). Local throwaway
# containers only; nothing here reaches db1 or any host. Usage, controls,
# sabotage names, exit codes: db/provision/snapshot_probe.md.
set -euo pipefail

# Refuse an ambient Docker target before any container is started.
[ -z "${DOCKER_HOST:-}" ] || {
    echo "REFUSED: DOCKER_HOST is set; this proof runs only in the local Docker context" >&2
    exit 5
}
ACTIVE_CONTEXT="$(docker context show 2>/dev/null || true)"
case "$ACTIVE_CONTEXT" in
    default | desktop-linux) ;;
    *)
        echo "REFUSED: Docker context '$ACTIVE_CONTEXT' is not the local default or desktop-linux context" >&2
        exit 5
        ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PLATFORM="${PROOF_PLATFORM:-linux/amd64}"

# The probe to run: this proof's own, or the REPLICATION CLIENT one that
# prove-replication-client.sh selects. Both take the same arguments.
PROBE="${PROOF_PROBE:-snapshot_probe.py}"
case "$PROBE" in
    snapshot_probe.py | replication_client_probe.py) ;;
    *)
        echo "REFUSED: PROOF_PROBE must be snapshot_probe.py or replication_client_probe.py, not '$PROBE'" >&2
        exit 5
        ;;
esac

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
for name in root mover repl nobackup coord; do
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
python3 "db/provision/$PROBE" run --source "$SRC" --replica "$REP" --workdir "$WORK" \
    ${PROOF_CONTROLS:+--controls "$PROOF_CONTROLS"} ${SABOTAGE:+--sabotage "$SABOTAGE"}
rc=$?
set -e
exit "$rc"
