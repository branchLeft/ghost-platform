#!/usr/bin/env bash
# Live proof of promotion_gate.py against a real source/replica pair: the
# source is db1's pinned stock MySQL image, the replica the Percona Server
# image the tenant database host runs (REPLICA_IMAGE overrides it), both
# with branchleft.cnf. Every scenario freezes the blog's table the way the
# cutover does, reads the frozen coordinates from log_status inside that
# lock, and runs the gate as a cutover script would. Containers and the
# network are removed on exit. Needs Docker and about 3 GB of memory.
# Scenarios and expected output: promotion_gate.md#live-proof.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Must match db/RUNBOOK-db.md's pinned db1 image.
SOURCE_IMAGE="mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b"
# Percona Server for MySQL 8.0.46-37, its linux/amd64 manifest: the hosts are amd64.
REPLICA_IMAGE="${REPLICA_IMAGE:-percona/percona-server:8.0@sha256:2fb8f1c992bc86f0bf4fa0aa174bbb1946f8867a7518278beec801a0bd2bf9e3}"
PW="proofRootPw123!"
REPL_PW="proofReplPw123!"
RUN=$$
NET="promotion-gate-proof-net-$RUN"
SRC="promotion-gate-proof-source-$RUN"
REP="promotion-gate-proof-replica-$RUN"
WORK="$(mktemp -d)"
WRITER_FLAG="$WORK/writer-on"

teardown() {
    rm -f "$WRITER_FLAG"
    docker rm -f "$SRC" "$REP" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap teardown EXIT

fail() {
    echo "FAILED: $*" >&2
    exit 1
}

src_sql() { docker exec -i -e MYSQL_PWD="$PW" "$SRC" mysql -uroot -N -B "$@"; }
rep_sql() { docker exec -i -e MYSQL_PWD="$PW" "$REP" mysql -uroot -N -B "$@"; }
rep_field() { docker exec -e MYSQL_PWD="$PW" "$REP" mysql -uroot --vertical -e 'SHOW REPLICA STATUS' | awk -v k="$1:" '$1 == k { print $2 }'; }

# Name, image, the image's option-file include directory, then mysqld flags.
start_server() {
    docker run -d --platform linux/amd64 --name "$1" --network "$NET" -e MYSQL_ROOT_PASSWORD="$PW" \
        -v "$REPO_ROOT/db/stack/conf.d/branchleft.cnf:$3/branchleft.cnf:ro" \
        "$2" --bind-address=0.0.0.0 "${@:4}" >/dev/null
}

# Readiness is a real query on the final server, never a ping: the image's
# entrypoint runs a socket-only bootstrap server first, then restarts.
wait_ready() {
    for _ in $(seq 1 180); do
        if docker logs "$1" 2>&1 | grep -q 'ready for connections.*port: 3306' &&
            [ "$(docker exec -e MYSQL_PWD="$PW" "$1" mysql -uroot -N -B -e 'SELECT @@port' 2>/dev/null)" = "3306" ]; then
            return 0
        fi
        sleep 1
    done
    fail "$1 never answered a real query"
}

# Holds READ on the blog's table for $1 seconds in one session, and inside
# that lock prints the frozen coordinates and row count to $WORK/frozen.
freeze() {
    rm -f "$WORK/frozen"
    docker exec -i -e MYSQL_PWD="$PW" "$SRC" mysql -uroot -N -B -n >"$WORK/frozen" <<SQL &
SET SESSION lock_wait_timeout = 2;
LOCK TABLES blog.posts READ;
SELECT SERVER_UUID, LOCAL->>'\$.binary_log_file', LOCAL->>'\$.binary_log_position', (SELECT COUNT(*) FROM blog.posts) FROM performance_schema.log_status;
DO SLEEP($1);
UNLOCK TABLES;
SQL
    FREEZE_PID=$!
    for _ in $(seq 1 30); do
        if [ -s "$WORK/frozen" ]; then
            read -r F_UUID F_FILE F_POS F_COUNT <"$WORK/frozen"
            echo "  frozen at $F_FILE:$F_POS with $F_COUNT posts"
            return 0
        fi
        sleep 1
    done
    fail "the freeze never printed its coordinates"
}

thaw() { wait "$FREEZE_PID" || fail "the freeze session failed"; }

# Runs the gate against the frozen coordinates; extra args override them.
gate() {
    local timeout="$1"
    shift
    python3 db/provision/promotion_gate.py --source-uuid "$F_UUID" --source-log-file "$F_FILE" \
        --source-log-position "$F_POS" --timeout "$timeout" --poll 1 "$@" \
        -- docker exec -e MYSQL_PWD="$PW" "$REP" mysql -uroot --vertical -e 'SHOW REPLICA STATUS'
}

expect_refusal() {
    local label="$1" pattern="$2"
    shift 2
    local out
    if out="$("$@")"; then
        fail "$label: the gate promoted ($out)"
    fi
    echo "  $out"
    echo "$out" | grep -q "^DO NOT PROMOTE: .*$pattern" || fail "$label: refused for the wrong reason"
    echo "PASS $label"
}

replica_has() { [ "$(rep_sql -e "SELECT COUNT(*) FROM blog.posts WHERE title = '$1'")" = "1" ]; }

# PROOF_SCENARIOS="1 4" runs only those scenarios, for a sabotage run that
# must reach one scenario without an earlier one stopping it.
want() { [ -z "${PROOF_SCENARIOS:-}" ] || [[ " $PROOF_SCENARIOS " == *" $1 "* ]]; }

echo "== setup"
docker network create "$NET" >/dev/null
start_server "$SRC" "$SOURCE_IMAGE" /etc/mysql/conf.d
start_server "$REP" "$REPLICA_IMAGE" /etc/my.cnf.d --server-id=2 --replicate-wild-do-table='blog.%'
wait_ready "$SRC"
wait_ready "$REP"
echo "  source:  $(docker exec "$SRC" mysqld --version)"
echo "  replica: $(docker exec "$REP" mysqld --version)"
SCHEMA="CREATE DATABASE blog; CREATE TABLE blog.posts (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(191) NOT NULL);"
src_sql -e "$SCHEMA CREATE USER 'repl'@'%' IDENTIFIED BY '$REPL_PW' REQUIRE SSL; GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';"
rep_sql -e "$SCHEMA"
read -r START_FILE START_POS < <(src_sql -e "SELECT LOCAL->>'\$.binary_log_file', LOCAL->>'\$.binary_log_position' FROM performance_schema.log_status")
rep_sql -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='$SRC', SOURCE_USER='repl', SOURCE_PASSWORD='$REPL_PW', SOURCE_LOG_FILE='$START_FILE', SOURCE_LOG_POS=$START_POS, SOURCE_SSL=1, SOURCE_CONNECT_RETRY=2; START REPLICA;"
src_sql -e "INSERT INTO blog.posts (title) VALUES ('before the move')"
for _ in $(seq 1 60); do replica_has 'before the move' && break; sleep 1; done
replica_has 'before the move' || fail "replication never started"

if want 1; then
    echo "== 1. healthy replica under continuous writes: PROMOTE"
    touch "$WRITER_FLAG"
    (while [ -f "$WRITER_FLAG" ]; do src_sql -e "INSERT INTO blog.posts (title) VALUES ('writer')"; done) &
    WRITER_PID=$!
    sleep 5
    freeze 40
    out="$(gate 30)" || fail "healthy replica refused: $out"
    echo "  $out"
    [ "$(rep_sql -e 'SELECT COUNT(*) FROM blog.posts')" = "$F_COUNT" ] || fail "promoted with a row count differing from the frozen source"
    echo "PASS promote at the frozen coordinates, replica count $F_COUNT equals frozen count"
    rm -f "$WRITER_FLAG"
    wait "$WRITER_PID" || true
    thaw
fi

if want 2; then
    echo "== 2. coordinates mismatch: refused"
    freeze 30
    expect_refusal "different source" "coordinates mismatch" gate 5 --source-uuid "00000000-0000-0000-0000-000000000000"
    expect_refusal "different binary log name" "coordinates mismatch" gate 5 --source-log-file "binlog.${F_FILE##*.}"
    expect_refusal "replica past the frozen position" "past the frozen coordinates" gate 5 --source-log-position "$((F_POS - 1))"
    thaw
fi

if want 3; then
    echo "== 3. disconnected replica, post written during the outage: DO NOT PROMOTE"
    rep_sql -e "STOP REPLICA IO_THREAD"
    docker network disconnect "$NET" "$REP"
    rep_sql -e "START REPLICA IO_THREAD"
    src_sql -e "INSERT INTO blog.posts (title) VALUES ('published during the outage')"
    freeze 40
    sleep 4
    echo "  replica reports IO=$(rep_field Replica_IO_Running) SQL=$(rep_field Replica_SQL_Running) Seconds_Behind_Source=$(rep_field Seconds_Behind_Source)"
    expect_refusal "disconnected replica" "timed out.*behind" gate 8
    replica_has 'published during the outage' && fail "the outage post reached a disconnected replica"
    echo "PASS the post written during the outage is absent on the replica the gate refused"
    thaw
    docker network connect "$NET" "$REP"
    for _ in $(seq 1 60); do replica_has 'published during the outage' && break; sleep 1; done
    freeze 30
    out="$(gate 30)" || fail "reconnected replica refused: $out"
    echo "  $out"
    replica_has 'published during the outage' || fail "promoted without the outage post"
    echo "PASS reconnected replica promotes with the outage post present"
    thaw
fi

# The shape the gate exists for. The network is cut under a running IO
# thread, so the replica still believes it is connected: both threads Yes
# and zero lag, which a lag-only check reads as caught up. It runs well
# inside replica_net_timeout (60 s), after which the IO thread reconnects.
if want 4; then
    echo "== 4. silent partition, zero lag while behind: DO NOT PROMOTE"
    docker network disconnect "$NET" "$REP"
    src_sql -e "INSERT INTO blog.posts (title) VALUES ('published during the partition')"
    freeze 40
    sleep 2
    io="$(rep_field Replica_IO_Running)" sql="$(rep_field Replica_SQL_Running)" lag="$(rep_field Seconds_Behind_Source)"
    echo "  replica reports IO=$io SQL=$sql Seconds_Behind_Source=$lag"
    [ "$io" = Yes ] && [ "$sql" = Yes ] && [ "$lag" = 0 ] ||
        fail "the partition did not produce zero lag with both threads Yes"
    echo "PASS the replica reports what a lag-only check promotes on: both threads Yes, zero lag"
    expect_refusal "silently partitioned replica" "timed out.*behind.*IO thread Yes" gate 8
    replica_has 'published during the partition' && fail "the partition post reached a partitioned replica"
    echo "PASS the post written during the partition is absent on the replica the gate refused"
    thaw
    rep_sql -e "STOP REPLICA IO_THREAD"
    docker network connect "$NET" "$REP"
    rep_sql -e "START REPLICA IO_THREAD"
    for _ in $(seq 1 60); do replica_has 'published during the partition' && break; sleep 1; done
    replica_has 'published during the partition' || fail "the replica never recovered from the partition"
fi

if want 5; then
    echo "== 5. replica behind with both threads running: refused at the timeout"
    rep_sql -e "STOP REPLICA SQL_THREAD; CHANGE REPLICATION SOURCE TO SOURCE_DELAY=3600; START REPLICA SQL_THREAD;"
    src_sql -e "INSERT INTO blog.posts (title) VALUES ('delayed')"
    freeze 30
    sleep 2
    expect_refusal "replica behind" "timed out.*behind" gate 6
    thaw
    rep_sql -e "STOP REPLICA SQL_THREAD; CHANGE REPLICATION SOURCE TO SOURCE_DELAY=0; START REPLICA SQL_THREAD;"
    for _ in $(seq 1 60); do replica_has 'delayed' && break; sleep 1; done
fi

# Another schema on the source during the freeze. A logged write moves the
# replica's executed position past the freeze even though its filter drops
# the row, so the gate refuses. A writer with sql_log_bin = 0 never reaches
# the binary log, so it can probe the freeze for stalls without tripping it.
if want 6; then
    echo "== 6. another schema written during the freeze"
    src_sql -e "CREATE DATABASE other; CREATE TABLE other.probe (id INT AUTO_INCREMENT PRIMARY KEY, v INT NOT NULL);"
    sleep 2
    touch "$WRITER_FLAG"
    (while [ -f "$WRITER_FLAG" ]; do src_sql -e "SET SESSION sql_log_bin = 0; INSERT INTO other.probe (v) VALUES (1)"; done) &
    WRITER_PID=$!
    freeze 40
    before="$(src_sql -e 'SELECT COUNT(*) FROM other.probe')"
    out="$(gate 20)" || fail "an unlogged writer on another schema tripped the gate: $out"
    echo "  $out"
    sleep 1
    after="$(src_sql -e 'SELECT COUNT(*) FROM other.probe')"
    [ "$after" -gt "$before" ] || fail "the other schema's writer stalled under the blog's freeze"
    echo "PASS an unlogged writer on another schema kept writing ($before to $after rows) and the gate promoted"
    rm -f "$WRITER_FLAG"
    wait "$WRITER_PID" || true
    thaw
    freeze 30
    src_sql -e "INSERT INTO other.probe (v) VALUES (2)"
    sleep 2
    expect_refusal "logged write to another schema" "past the frozen coordinates" gate 5
    thaw
fi

if want 7; then
    echo "== 7. SQL thread error: ABANDON at once, without waiting for the timeout"
    rep_sql -e "INSERT INTO blog.posts (id, title) VALUES (999999, 'replica-only row')"
    src_sql -e "INSERT INTO blog.posts (id, title) VALUES (999999, 'conflicting source row')"
    for _ in $(seq 1 60); do [ "$(rep_field Last_SQL_Errno)" != "0" ] && break; sleep 1; done
    freeze 30
    started=$(date +%s)
    expect_refusal "SQL thread error" "SQL thread error 1062" gate 25
    [ $(($(date +%s) - started)) -lt 15 ] || fail "the SQL-error refusal waited for the timeout"
    echo "PASS the SQL-thread error abandoned without waiting"
    thaw
fi

echo "ALL PASSED${PROOF_SCENARIOS:+ (scenarios $PROOF_SCENARIOS)}"
