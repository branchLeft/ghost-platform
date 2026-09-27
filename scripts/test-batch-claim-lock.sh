#!/bin/sh
# LLD-4 §U5 / LLD-3 §06's own "batch claim under two
# colours" harness gate: two colours over one database cannot both claim
# the same email batch. Ghost's own mechanism (batch-sending-service.js's
# `updateStatusLock`) is a conditional status change inside a locked
# transaction -- a claim is one SQL statement, not a read-then-write --
# which is exactly what this proves on a throwaway table shaped like
# Ghost's real `email_batches`, on SQLite (a local scratch file, this
# script's own `mktemp`) and on MySQL (a scratch container this script
# creates and destroys). Never against slot 0's SQLite or against the
# live blog (LLD-3 §06, load-bearing): nothing here is a real demo host or
# a real tenant database.
#
# The real assertion, both engines: two colours racing the same atomic
# claim -- exactly one wins.
# The control case (LOAD-BEARING per the harness gate table): a test
# double with the lock removed -- read-then-write instead of one
# conditional UPDATE -- and both colours claim it. That is the exposure
# Ghost's own mechanism exists to prevent: a reader receiving the
# newsletter twice.
#
# Usage: ./scripts/test-batch-claim-lock.sh
set -e

FAILURES=0
WORKDIR="$(mktemp -d)"
cleanup() {
    docker rm -f "$MYSQL_NAME" >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# SQLite: a throwaway file, never slot 0's own database and never the live
# blog's -- this script creates and destroys it, and nothing else ever
# points at this path.
# ---------------------------------------------------------------------------
SQLITE_DB="$WORKDIR/scratch-email-batches.db"

sqlite_setup() {
    rm -f "$SQLITE_DB"
    sqlite3 "$SQLITE_DB" "
        CREATE TABLE email_batches (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
        INSERT INTO email_batches (id, status) VALUES (1, 'pending');
    "
}

# The real assertion: Ghost's own shape -- one conditional UPDATE inside a
# transaction, busy_timeout set so a concurrent writer waits for the other's
# transaction rather than erroring (mirroring knex's own retry-on-busy
# posture the design doc's own §U4 spike measured).
sqlite_real_claim() {
    out="$1"
    # `.timeout`, not `PRAGMA busy_timeout = ...`: the CLI echoes a PRAGMA
    # assignment's own value as a result row, which would land in `$out`
    # alongside `changes()` and break the arithmetic below. The dot-command
    # sets the same C API option with no query result to echo.
    sqlite3 -cmd ".timeout 5000" "$SQLITE_DB" "
        BEGIN IMMEDIATE;
        UPDATE email_batches SET status = 'submitting' WHERE id = 1 AND status IN ('pending', 'failed');
        SELECT changes();
        COMMIT;
    " > "$out" 2>&1
}

# The control case: the same two colours, but reimplemented with the lock
# removed -- a plain read, a deliberate pause to widen the race window (a
# real two-process race needs no such pause; this one is shortened to a
# few milliseconds and needs help to land reliably), then an unconditional
# write. This is never Ghost's own code -- it is the "test double" the
# issue and LLD-3 §06 both name, built only to show what the atomic claim
# above is protecting against.
sqlite_sabotaged_claim() {
    out="$1"
    sqlite3 -cmd ".timeout 5000" "$SQLITE_DB" "
        SELECT status FROM email_batches WHERE id = 1;
    " > "$out.read" 2>&1
    sleep 0.05
    if grep -qx 'pending' "$out.read" || grep -qx 'failed' "$out.read"; then
        sqlite3 "$SQLITE_DB" "UPDATE email_batches SET status = 'submitting' WHERE id = 1;"
        echo 1 > "$out"
    else
        echo 0 > "$out"
    fi
}

echo "--- SQLite: the real claim, raced by two colours ---"
sqlite_setup
sqlite_real_claim "$WORKDIR/sqlite-real-a" &
PID_A=$!
sqlite_real_claim "$WORKDIR/sqlite-real-b" &
PID_B=$!
wait "$PID_A" "$PID_B"
CLAIMED=$(( $(cat "$WORKDIR/sqlite-real-a") + $(cat "$WORKDIR/sqlite-real-b") ))
FINAL_STATUS=$(sqlite3 "$SQLITE_DB" "SELECT status FROM email_batches WHERE id = 1;")
if [ "$CLAIMED" = "1" ] && [ "$FINAL_STATUS" = "submitting" ]; then
    echo "PASS: exactly one colour claimed the batch (changes()=$CLAIMED total), final status \"$FINAL_STATUS\""
else
    echo "FAIL: expected exactly one claim and status \"submitting\", got claimed=$CLAIMED status=\"$FINAL_STATUS\""
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- SQLite: the control case -- lock removed, both colours claim it ---"
sqlite_setup
sqlite_sabotaged_claim "$WORKDIR/sqlite-sab-a" &
PID_A=$!
sqlite_sabotaged_claim "$WORKDIR/sqlite-sab-b" &
PID_B=$!
wait "$PID_A" "$PID_B"
SAB_CLAIMED=$(( $(cat "$WORKDIR/sqlite-sab-a") + $(cat "$WORKDIR/sqlite-sab-b") ))
if [ "$SAB_CLAIMED" = "2" ]; then
    echo "RED (expected, by construction): both colours believed they claimed the batch ($SAB_CLAIMED claims) -- exactly the duplicate-send exposure Ghost's own conditional UPDATE prevents."
else
    echo "FAIL: the control fixture itself is wrong -- expected both colours to claim (2), got $SAB_CLAIMED. Re-run; the race window may need widening."
    FAILURES=$((FAILURES + 1))
fi
echo

# ---------------------------------------------------------------------------
# MySQL: a scratch container this script starts and destroys -- never a
# tenant database, never anything long-lived.
# ---------------------------------------------------------------------------
RUN_ID="$$"
MYSQL_NAME="batch-claim-mysql-$RUN_ID"
MYSQL_PW="batch-claim-test-only"

echo "--- starting one scratch MySQL for the same two proofs ---"
docker run -d \
    --name "$MYSQL_NAME" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_PW" \
    -e MYSQL_DATABASE="scratch_email_batches" \
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
# Same margin `test-colour-swap-mysql.sh` takes, for the same reason: the
# entrypoint's own init sequence briefly restarts mysqld between the
# temporary instance `mysqladmin ping` can already reach and the real one,
# and a client landing in that window sees no socket at all.
sleep 5
echo "PASS: MySQL is ready"
echo

mysql_exec() {
    docker exec "$MYSQL_NAME" mysql -uroot -p"$MYSQL_PW" -N -B scratch_email_batches -e "$1"
}

mysql_setup() {
    mysql_exec "
        DROP TABLE IF EXISTS email_batches;
        CREATE TABLE email_batches (id INT PRIMARY KEY, status VARCHAR(32) NOT NULL) ENGINE=InnoDB;
        INSERT INTO email_batches (id, status) VALUES (1, 'pending');
    " >/dev/null
}

# The real assertion on InnoDB: the conditional UPDATE inside a
# transaction is exactly Ghost's own shape, and MySQL's row-level locking
# (not SQLite's whole-database serialisation) is the *different* mechanism
# LLD-3 §06 says makes this worth asserting on both engines rather than
# reasoning about once.
mysql_real_claim() {
    out="$1"
    docker exec "$MYSQL_NAME" mysql -uroot -p"$MYSQL_PW" -N -B scratch_email_batches -e "
        START TRANSACTION;
        UPDATE email_batches SET status = 'submitting' WHERE id = 1 AND status IN ('pending', 'failed');
        SELECT ROW_COUNT();
        COMMIT;
    " > "$out" 2>&1
}

mysql_sabotaged_claim() {
    out="$1"
    status=$(mysql_exec "SELECT status FROM email_batches WHERE id = 1;")
    sleep 0.2
    if [ "$status" = "pending" ] || [ "$status" = "failed" ]; then
        mysql_exec "UPDATE email_batches SET status = 'submitting' WHERE id = 1;" >/dev/null
        echo 1 > "$out"
    else
        echo 0 > "$out"
    fi
}

echo "--- MySQL: the real claim, raced by two colours ---"
mysql_setup
mysql_real_claim "$WORKDIR/mysql-real-a" &
PID_A=$!
mysql_real_claim "$WORKDIR/mysql-real-b" &
PID_B=$!
wait "$PID_A" "$PID_B"
MYSQL_CLAIMED=$(( $(tail -1 "$WORKDIR/mysql-real-a") + $(tail -1 "$WORKDIR/mysql-real-b") ))
MYSQL_FINAL_STATUS=$(mysql_exec "SELECT status FROM email_batches WHERE id = 1;")
if [ "$MYSQL_CLAIMED" = "1" ] && [ "$MYSQL_FINAL_STATUS" = "submitting" ]; then
    echo "PASS: exactly one colour claimed the batch (ROW_COUNT()=$MYSQL_CLAIMED total), final status \"$MYSQL_FINAL_STATUS\""
else
    echo "FAIL: expected exactly one claim and status \"submitting\", got claimed=$MYSQL_CLAIMED status=\"$MYSQL_FINAL_STATUS\""
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- MySQL: the control case -- lock removed, both colours claim it ---"
mysql_setup
mysql_sabotaged_claim "$WORKDIR/mysql-sab-a" &
PID_A=$!
mysql_sabotaged_claim "$WORKDIR/mysql-sab-b" &
PID_B=$!
wait "$PID_A" "$PID_B"
MYSQL_SAB_CLAIMED=$(( $(cat "$WORKDIR/mysql-sab-a") + $(cat "$WORKDIR/mysql-sab-b") ))
if [ "$MYSQL_SAB_CLAIMED" = "2" ]; then
    echo "RED (expected, by construction): both colours believed they claimed the batch ($MYSQL_SAB_CLAIMED claims) on MySQL too -- the exposure is not SQLite-specific."
else
    echo "FAIL: the control fixture itself is wrong -- expected both colours to claim (2), got $MYSQL_SAB_CLAIMED. Re-run; the race window may need widening."
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo "All batch-claim checks passed."
