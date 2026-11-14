#!/usr/bin/env bash
# Step-0 proof for the tenant database host (option (e), Percona Server): a
# lock-free, consistent per-tenant snapshot. Local throwaway containers only;
# nothing here reaches db1, db-t1 or any host. Usage, controls, sabotage names,
# exit codes: db/provision/percona_snapshot_probe.md.
#
#   PROOF_SOURCE=percona (default)  the source is the Percona candidate
#   PROOF_SOURCE=stock              the source is db1's pinned Oracle MySQL;
#                                   the source of the two stock SABOTAGE cases
# The replica is always Percona, as db-t1's is. Both servers run GTID mode: the
# replica is seeded by the dump's GTID set, never by file and position.
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

SOURCE_KIND="${PROOF_SOURCE:-percona}"
case "$SOURCE_KIND" in
    percona | stock) ;;
    *)
        echo "REFUSED: PROOF_SOURCE must be percona or stock, not '$SOURCE_KIND'" >&2
        exit 5
        ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PLATFORM="${PROOF_PLATFORM:-linux/amd64}"

# The Percona candidate: the index digest the hosts would pull, read from the
# image mirror list by percona_pin.py (test_percona_pin.py guards the scripts).
PERCONA_INDEX="$(python3 db/provision/percona_pin.py index)"
PERCONA_IMAGE="percona/percona-server@$PERCONA_INDEX"

# The one digest db1 runs. A re-pin in the runbook re-points this proof.
PINS="$(grep -oE 'mysql:8\.0@sha256:[0-9a-f]{64}' db/RUNBOOK-db.md | sort -u)"
[ "$(printf '%s\n' "$PINS" | wc -l | tr -d ' ')" = "1" ] || {
    echo "FAILED: db/RUNBOOK-db.md must pin exactly one mysql:8.0 digest, found: $PINS" >&2
    exit 1
}
STOCK_IMAGE="$PINS"

if [ "$SOURCE_KIND" = "stock" ]; then
    SOURCE_IMAGE="$STOCK_IMAGE"
    SOURCE_CNF="/etc/mysql/conf.d/branchleft.cnf"
else
    SOURCE_IMAGE="$PERCONA_IMAGE"
    SOURCE_CNF="/etc/my.cnf.d/branchleft.cnf"
fi
REPLICA_IMAGE="$PERCONA_IMAGE"
REPLICA_CNF="/etc/my.cnf.d/branchleft.cnf"

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

# GTID mode, on from the first start, on both servers: the replica is seeded
# from the dump's GTID set and started with SOURCE_AUTO_POSITION=1.
# percona_snapshot_probe.py checks these two settings on the source.
GTID_FLAGS=(--gtid_mode=ON --enforce_gtid_consistency=ON)

# Image, config mount point, name, then mysqld flags. The config is mounted
# unchanged; only the bind address (db1's private address) and GTID mode are
# set on the command line.
start_server() {
    docker run -d --platform "$PLATFORM" --name "$3" --network "$NET" -e MYSQL_ROOT_PASSWORD \
        -v "$REPO_ROOT/db/stack/conf.d/branchleft.cnf:$2:ro" \
        "$1" --bind-address=0.0.0.0 "${GTID_FLAGS[@]}" "${@:4}" >/dev/null
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

echo "== setup: source $SOURCE_KIND, replica percona, on $PLATFORM"
docker network create "$NET" >/dev/null
start_server "$SOURCE_IMAGE" "$SOURCE_CNF" "$SRC"
start_server "$REPLICA_IMAGE" "$REPLICA_CNF" "$REP" --server-id=2
wait_ready "$SRC"
wait_ready "$REP"

# What was actually run: the digests the images were pulled by, the image ids
# Docker holds them as, and each server's own version string.
echo "  stock image pin:      $STOCK_IMAGE"
echo "  percona image pin:    $PERCONA_IMAGE"
echo "  source image:         $SOURCE_IMAGE (id $(docker image inspect --format '{{.Id}}' "$SOURCE_IMAGE"))"
echo "  replica image:        $REPLICA_IMAGE (id $(docker image inspect --format '{{.Id}}' "$REPLICA_IMAGE"))"
echo "  source mysqld --version:  $(docker exec "$SRC" mysqld --version)"
echo "  replica mysqld --version: $(docker exec "$REP" mysqld --version)"

set +e
python3 db/provision/percona_snapshot_probe.py run --source "$SRC" --replica "$REP" --workdir "$WORK" \
    --source-kind "$SOURCE_KIND" ${PROOF_CONTROLS:+--controls "$PROOF_CONTROLS"} ${SABOTAGE:+--sabotage "$SABOTAGE"}
rc=$?
set -e
exit "$rc"
