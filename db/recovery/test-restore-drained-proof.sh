#!/bin/sh
# Live proof, real containers: a tenant's dump restored onto a drained
# colour, undrained only after a named post's own body renders -- and the
# empty-database control design 09 (R4) names, run for real rather than
# asserted: a Ghost pointed at a schema with no data answers HTTP 200 too,
# so a restore of nothing must fail the content check while Ghost itself
# looks healthy, and the colour it came up on must stay drained.
#
# Five containers, two real MySQL 8.0 servers standing in for the tenant
# database host and two fresh recovery targets, this repo's own recovery
# image (ghcr.io/branchleft/db-recovery, by digest -- never `latest`, same
# rule the runbook itself follows) doing the dump and the import, this
# repo's own platform image serving each colour, and the real
# services/drain-sidecar code (built from source, not a mock) answering
# each colour's health port.
#
# GREEN: a real Ghost creates a real owner and a real, named post against a
# SOURCE database; that tenant's dump is taken with the same mysqldump flags
# dump_tenant.py itself uses; restore_drained.py restores it onto a fresh
# target that a second Ghost then boots against, already drained; the named
# post's body is read back from the rendered homepage; only then is the
# flag cleared, and the sidecar is checked before and after.
#
# CONTROL: the same chain, with an empty file in place of a real dump. The
# target Ghost boots its own migrations against nothing and answers 200 --
# and restore_drained.py's content check must refuse that, leaving the
# colour drained.
#
# LIVE-COLLISION: a fourth MySQL server that already holds a live
# `ghost_tenant1` with known rows, seeded before restore_drained.py ever runs.
# --mode restore-only must refuse before importing anything, and the live
# database's own row count and CHECKSUM TABLE value must be provably
# unchanged afterwards -- the owner ruling this section exists to hold:
# restoring a per-tenant dump (its own CREATE DATABASE IF NOT EXISTS/USE)
# onto a host that already has that database restores INTO it, not beside
# it, so a target that already holds one must never be imported into at all.
#
# Local-sandbox simplifications, stated rather than left implicit: mysqldump
# runs over TCP as root here, standing in for dump_tenant.py's own unix
# socket + dedicated `backup`@`localhost` account (proven separately, and
# unit-tested, by db/provision/test_dump_tenant.py) -- this proof's job is
# the restore-onto-a-drained-colour chain, not a second proof of the dump
# script's own connection boundary.
#
# Usage (run from the repo root, or let this script cd there itself):
#   ./db/recovery/test-restore-drained-proof.sh <ghost-platform-image> <drain-sidecar-dist-dir>
# <drain-sidecar-dist-dir> is services/drain-sidecar's own directory, built
# first (`npm run build` there) -- this script mounts its dist/,
# node_modules/ and package.json into a plain node:26.5.0-bookworm-slim
# container rather than building services/drain-sidecar/Dockerfile itself,
# because that Dockerfile's own `npm ci` needs a GitHub Packages read token
# this proof does not assume is available; the sidecar CODE under test is
# identical either way.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

GHOST_IMAGE="${1:?usage: test-restore-drained-proof.sh <ghost-platform-image> <drain-sidecar-dist-dir>}"
SIDECAR_DIR="${2:?usage: test-restore-drained-proof.sh <ghost-platform-image> <drain-sidecar-dist-dir>}"
[ -f "$SIDECAR_DIR/dist/server.js" ] || {
    echo "FAILED: $SIDECAR_DIR/dist/server.js not found -- build it first (npm run build)" >&2
    exit 1
}
SIDECAR_NODE_MODULES="$(cd "$SIDECAR_DIR/node_modules" && pwd)"

RECOVERY_IMAGE="ghcr.io/branchleft/db-recovery@sha256:ceae7d89523d695bf60e98e874ae3430fb8c03566721108c9a21e26171ce2666"
MYSQL_ROOT_PASSWORD="proofRootPw123!"
KNOWN_POST_BODY="Tenant B original post"

RUN=$$
NET="restore-drained-proof-net-$RUN"
SOURCE_DB="restore-drained-proof-source-db-$RUN"
GREEN_DB="restore-drained-proof-green-db-$RUN"
CONTROL_DB="restore-drained-proof-control-db-$RUN"
LIVE_DB="restore-drained-proof-live-db-$RUN"
SOURCE_GHOST="restore-drained-proof-source-ghost-$RUN"
GREEN_GHOST="restore-drained-proof-green-ghost-$RUN"
CONTROL_GHOST="restore-drained-proof-control-ghost-$RUN"
GREEN_SIDECAR="restore-drained-proof-green-sidecar-$RUN"
CONTROL_SIDECAR="restore-drained-proof-control-sidecar-$RUN"

SOURCE_GHOST_PORT=4430
GREEN_GHOST_PORT=4431
CONTROL_GHOST_PORT=4432
GREEN_SIDECAR_PORT=4441
CONTROL_SIDECAR_PORT=4442
# Published so restore_drained.py -- run from this host, not from inside the
# Docker network -- can reach each recovery target the same way an
# operator's own workstation would (its own `mysql` client, not a
# container-name DNS lookup no host process gets).
GREEN_DB_PORT=4451
CONTROL_DB_PORT=4452
LIVE_DB_PORT=4453

WORKDIR="$(mktemp -d)"
GREEN_FLAG_DIR="$(mktemp -d)"
CONTROL_FLAG_DIR="$(mktemp -d)"
chmod 0755 "$GREEN_FLAG_DIR" "$CONTROL_FLAG_DIR"
GREEN_FLAG="$GREEN_FLAG_DIR/green.drain"
CONTROL_FLAG="$CONTROL_FLAG_DIR/control.drain"

FAILURES=0
note() { echo; echo "== $* =="; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

cleanup() {
    docker rm -f "$SOURCE_GHOST" "$GREEN_GHOST" "$CONTROL_GHOST" "$GREEN_SIDECAR" "$CONTROL_SIDECAR" \
        "$SOURCE_DB" "$GREEN_DB" "$CONTROL_DB" "$LIVE_DB" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    [ -f "$WORKDIR/restore_drained.py.orig-live-collision" ] && \
        cp "$WORKDIR/restore_drained.py.orig-live-collision" "$REPO_ROOT/db/recovery/restore_drained.py"
    rm -rf "$WORKDIR" "$GREEN_FLAG_DIR" "$CONTROL_FLAG_DIR"
}
trap cleanup EXIT

wait_for_mysql() {
    # `-h 127.0.0.1` forces a real TCP check. Without it, `mysqladmin ping`
    # inside the container defaults to the Unix socket, which the official
    # image's own temporary bootstrap server (used only to run init scripts,
    # before the real networked mysqld starts) also answers on -- a ping
    # against that gives a false "ready" that Ghost's own connection attempt
    # then loses the race against (ECONNREFUSED, seen live building this
    # proof).
    name="$1"
    deadline=$(($(date +%s) + 90))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if docker exec "$name" mysqladmin ping -h 127.0.0.1 -P 3306 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "FAILED: $name did not become ready within 90s" >&2
    docker logs "$name" 2>&1 | tail -40
    exit 1
}

http_status() {
    curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$1" 2>/dev/null || true
}

wait_for_http_200() {
    url="$1"
    label="$2"
    deadline=$(($(date +%s) + 150))
    status=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(http_status "$url")"
        [ "$status" = "200" ] && return 0
        sleep 1
    done
    echo "FAILED: $label ($url) never answered 200 within 150s (last: $status)" >&2
    exit 1
}

note "Network + four MySQL 8.0 servers: SOURCE (the live tenant), GREEN and CONTROL (fresh recovery targets), LIVE (a recovery target that already has a database on it)"
docker network create "$NET" >/dev/null
docker run -d --name "$SOURCE_DB" --network "$NET" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" -e MYSQL_DATABASE=ghost_tenant1 mysql:8.0 >/dev/null
docker run -d --name "$GREEN_DB" --network "$NET" -p "${GREEN_DB_PORT}:3306" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" mysql:8.0 >/dev/null
docker run -d --name "$CONTROL_DB" --network "$NET" -p "${CONTROL_DB_PORT}:3306" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" mysql:8.0 >/dev/null
docker run -d --name "$LIVE_DB" --network "$NET" -p "${LIVE_DB_PORT}:3306" \
    -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" mysql:8.0 >/dev/null
wait_for_mysql "$SOURCE_DB"
wait_for_mysql "$GREEN_DB"
wait_for_mysql "$CONTROL_DB"
wait_for_mysql "$LIVE_DB"

note "Seeding LIVE with a database that already exists, and known rows in it -- the exact collision Rob's own ruling on this issue names"
docker exec "$LIVE_DB" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
    "CREATE DATABASE ghost_tenant1; CREATE TABLE ghost_tenant1.settings (id INT PRIMARY KEY, val VARCHAR(64)); INSERT INTO ghost_tenant1.settings VALUES (1,'alpha'),(2,'beta'),(3,'gamma');"
live_fingerprint() {
    docker exec "$LIVE_DB" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e \
        "SELECT COUNT(*) FROM ghost_tenant1.settings;" 2>/dev/null
    docker exec "$LIVE_DB" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e \
        "CHECKSUM TABLE ghost_tenant1.settings;" 2>/dev/null | awk '{print $2}'
}
LIVE_FINGERPRINT_BEFORE="$(live_fingerprint)"
pass "LIVE seeded: ghost_tenant1.settings carries 3 known rows; fingerprint recorded"

note "A real Ghost against the SOURCE database: a real owner, a real named post"
docker run -d --name "$SOURCE_GHOST" --network "$NET" -p "${SOURCE_GHOST_PORT}:2368" \
    -e url="http://localhost:${SOURCE_GHOST_PORT}" \
    -e database__client=mysql \
    -e database__connection__host="$SOURCE_DB" \
    -e database__connection__port=3306 \
    -e database__connection__database=ghost_tenant1 \
    -e database__connection__user=root \
    -e database__connection__password="$MYSQL_ROOT_PASSWORD" \
    -e privacy__useUpdateCheck=false \
    -e "logging__transports=[\"stdout\"]" \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e storage__images__adapter=ScanningStorageAdapter \
    -e storage__images__wraps=LocalImagesStorage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__media__adapter=ScanningStorageAdapter \
    -e storage__media__wraps=LocalMediaStorage \
    -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__files__adapter=ScanningStorageAdapter \
    -e storage__files__wraps=LocalFilesStorage \
    -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
    "$GHOST_IMAGE" >/dev/null
wait_for_http_200 "http://localhost:${SOURCE_GHOST_PORT}/" "source Ghost"

SOURCE_ORIGIN="http://localhost:${SOURCE_GHOST_PORT}"
COOKIES="$WORKDIR/cookies.txt"
curl -sf -c "$COOKIES" -H "Origin: $SOURCE_ORIGIN" -H "Content-Type: application/json" \
    -d '{"setup":[{"name":"Restore Proof Admin","email":"restore-proof-admin@example.test","password":"RestoreProof123!","blogTitle":"Tenant B"}]}' \
    "$SOURCE_ORIGIN/ghost/api/admin/authentication/setup/" >/dev/null
curl -sf -c "$COOKIES" -b "$COOKIES" -H "Origin: $SOURCE_ORIGIN" -H "Content-Type: application/json" \
    -d '{"username":"restore-proof-admin@example.test","password":"RestoreProof123!"}' \
    "$SOURCE_ORIGIN/ghost/api/admin/session/" >/dev/null
curl -sf -b "$COOKIES" -H "Origin: $SOURCE_ORIGIN" -H "Content-Type: application/json" \
    -d "{\"posts\":[{\"title\":\"${KNOWN_POST_BODY}\",\"html\":\"<p>${KNOWN_POST_BODY}</p>\",\"status\":\"published\"}]}" \
    "$SOURCE_ORIGIN/ghost/api/admin/posts/?source=html" >/dev/null
pass "source Ghost set up, and \"$KNOWN_POST_BODY\" published"

note "Dumping the tenant database (dump_tenant.py's own mysqldump flags -- see the script's simplifications note above)"
docker run --rm --network "$NET" -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$RECOVERY_IMAGE" \
    mysqldump --host "$SOURCE_DB" --user root --single-transaction --source-data=2 --routines --triggers \
    --set-gtid-purged=OFF --databases ghost_tenant1 >"$WORKDIR/tenant.sql"
[ -s "$WORKDIR/tenant.sql" ] || {
    echo "FAILED: the tenant dump is empty -- cannot run the GREEN scenario at all" >&2
    exit 1
}
: >"$WORKDIR/empty.sql"
pass "real tenant dump captured ($(wc -c <"$WORKDIR/tenant.sql" | tr -d ' ') bytes); the CONTROL's dump is a genuine empty file"

note "GREEN: restore_drained.py imports the real dump into the GREEN target -- before that colour's Ghost even exists"
touch "$GREEN_FLAG"
RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode restore-only --dump "$WORKDIR/tenant.sql" --host 127.0.0.1 --port "$GREEN_DB_PORT" --user root
pass "GREEN: restore_drained.py imported the real dump"

note "CONTROL: restore_drained.py 'imports' the empty file into the CONTROL target"
touch "$CONTROL_FLAG"
RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode restore-only --dump "$WORKDIR/empty.sql" --host 127.0.0.1 --port "$CONTROL_DB_PORT" --user root
pass "CONTROL: restore_drained.py 'imported' the empty file (a no-op mysql import, exit 0 -- nothing to fail on yet)"

note "Starting both colours' Ghost containers, already drained (the flag is set, from before either container existed)"
docker run -d --name "$GREEN_GHOST" --network "$NET" -p "${GREEN_GHOST_PORT}:2368" -p "${GREEN_SIDECAR_PORT}:8080" \
    -e url="http://localhost:${GREEN_GHOST_PORT}" \
    -e database__client=mysql -e database__connection__host="$GREEN_DB" -e database__connection__port=3306 \
    -e database__connection__database=ghost_tenant1 -e database__connection__user=root \
    -e database__connection__password="$MYSQL_ROOT_PASSWORD" \
    -e privacy__useUpdateCheck=false -e "logging__transports=[\"stdout\"]" -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e storage__images__adapter=ScanningStorageAdapter -e storage__images__wraps=LocalImagesStorage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__media__adapter=ScanningStorageAdapter -e storage__media__wraps=LocalMediaStorage \
    -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__files__adapter=ScanningStorageAdapter -e storage__files__wraps=LocalFilesStorage \
    -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
    "$GHOST_IMAGE" >/dev/null
docker run -d --name "$CONTROL_GHOST" --network "$NET" -p "${CONTROL_GHOST_PORT}:2368" -p "${CONTROL_SIDECAR_PORT}:8080" \
    -e url="http://localhost:${CONTROL_GHOST_PORT}" \
    -e database__client=mysql -e database__connection__host="$CONTROL_DB" -e database__connection__port=3306 \
    -e database__connection__database=ghost_tenant1 -e database__connection__user=root \
    -e database__connection__password="$MYSQL_ROOT_PASSWORD" \
    -e privacy__useUpdateCheck=false -e "logging__transports=[\"stdout\"]" -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e storage__images__adapter=ScanningStorageAdapter -e storage__images__wraps=LocalImagesStorage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__media__adapter=ScanningStorageAdapter -e storage__media__wraps=LocalMediaStorage \
    -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__files__adapter=ScanningStorageAdapter -e storage__files__wraps=LocalFilesStorage \
    -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
    "$GHOST_IMAGE" >/dev/null

note "Starting the real drain-sidecar (built from source, sharing each Ghost's network namespace) against each colour"
docker run -d --name "$GREEN_SIDECAR" --network "container:$GREEN_GHOST" \
    -v "$SIDECAR_DIR:/app:ro" -v "$SIDECAR_NODE_MODULES:/app/node_modules:ro" \
    -v "$GREEN_FLAG_DIR:/var/run/branchleft:ro" \
    -e DRAIN_FLAG_PATH=/var/run/branchleft/green.drain -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" -e PORT=8080 \
    -w /app node:26.5.0-bookworm-slim node dist/server.js >/dev/null
docker run -d --name "$CONTROL_SIDECAR" --network "container:$CONTROL_GHOST" \
    -v "$SIDECAR_DIR:/app:ro" -v "$SIDECAR_NODE_MODULES:/app/node_modules:ro" \
    -v "$CONTROL_FLAG_DIR:/var/run/branchleft:ro" \
    -e DRAIN_FLAG_PATH=/var/run/branchleft/control.drain -e GHOST_HEALTH_URL="http://127.0.0.1:2368/" -e PORT=8080 \
    -w /app node:26.5.0-bookworm-slim node dist/server.js >/dev/null

note "Before verification: both colours' Ghosts come up (real restore, and a fresh empty schema alike), but both sidecars stay drained"
wait_for_http_200 "http://localhost:${GREEN_GHOST_PORT}/" "GREEN Ghost"
wait_for_http_200 "http://localhost:${CONTROL_GHOST_PORT}/" "CONTROL Ghost (an empty database still answers 200 -- R4, live)"
pass "CONTROL Ghost answers 200 against a completely empty restore -- exactly the false signal design 09 R4 names"

deadline=$(($(date +%s) + 30))
green_sidecar_drained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(http_status "http://localhost:${GREEN_SIDECAR_PORT}/healthz")" = "503" ] && { green_sidecar_drained=true; break; }
    sleep 0.5
done
if [ "$green_sidecar_drained" = "true" ]; then
    pass "GREEN colour's sidecar still answers 503 -- drained, with no route pointed at it, before verification has run"
else
    fail "GREEN colour's sidecar did not answer 503 before verification ran"
fi
control_sidecar_drained=false
deadline=$(($(date +%s) + 30))
while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(http_status "http://localhost:${CONTROL_SIDECAR_PORT}/healthz")" = "503" ] && { control_sidecar_drained=true; break; }
    sleep 0.5
done
if [ "$control_sidecar_drained" = "true" ]; then
    pass "CONTROL colour's sidecar still answers 503 -- drained, even though Ghost itself is already serving 200"
else
    fail "CONTROL colour's sidecar did not answer 503 before verification ran"
fi

note "GREEN: verify-and-undrain -- reads the named post's own body back, then clears the flag"
if RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode verify-and-undrain --base-url "http://localhost:${GREEN_GHOST_PORT}/" --expect "$KNOWN_POST_BODY" \
    --flag-path "$GREEN_FLAG" --content-timeout 60; then
    pass "GREEN: restore_drained.py verified the named post and exited 0"
else
    fail "GREEN: restore_drained.py exited non-zero on a genuine restore -- should have succeeded"
fi
if [ -f "$GREEN_FLAG" ]; then
    fail "GREEN: the flag file is still present after a successful verify-and-undrain"
else
    pass "GREEN: the flag file is gone -- cleared only after the content check passed"
fi
deadline=$(($(date +%s) + 15))
green_undrained=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(http_status "http://localhost:${GREEN_SIDECAR_PORT}/healthz")" = "200" ] && { green_undrained=true; break; }
    sleep 0.5
done
if [ "$green_undrained" = "true" ]; then
    pass "GREEN: the real sidecar now answers 200 -- undrained, only after the flag was cleared"
else
    fail "GREEN: the sidecar never returned 200 after the flag was cleared"
fi

note "CONTROL: verify-and-undrain against the empty restore -- design 09 R4's own control, run for real"
if RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode verify-and-undrain --base-url "http://localhost:${CONTROL_GHOST_PORT}/" --expect "$KNOWN_POST_BODY" \
    --flag-path "$CONTROL_FLAG" --content-timeout 8; then
    fail "CONTROL: restore_drained.py exited 0 against a restore of nothing -- WRONG, the content check did not catch it"
else
    pass "CONTROL: restore_drained.py exited non-zero -- the empty restore was refused despite Ghost's own 200"
fi
if [ -f "$CONTROL_FLAG" ]; then
    pass "CONTROL: the flag file is still present -- the colour was never undrained"
else
    fail "CONTROL: the flag file is gone even though verification failed"
fi
if [ "$(http_status "http://localhost:${CONTROL_SIDECAR_PORT}/healthz")" = "503" ]; then
    pass "CONTROL: the real sidecar still answers 503 -- the empty-restore colour never received a route"
else
    fail "CONTROL: the sidecar answered something other than 503 after the failed verification"
fi

note "LIVE-COLLISION: restore-only against a target that already holds a live database -- Rob's own ruling, run for real"
LIVE_STDERR="$WORKDIR/live-collision.stderr"
if RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode restore-only --dump "$WORKDIR/tenant.sql" --host 127.0.0.1 --port "$LIVE_DB_PORT" --user root \
    2>"$LIVE_STDERR"; then
    fail "LIVE-COLLISION: restore_drained.py exited 0 against a target that already has ghost_tenant1 -- WRONG, must refuse"
else
    pass "LIVE-COLLISION: restore_drained.py exited non-zero against the live target"
fi
if grep -q "ghost_tenant1" "$LIVE_STDERR" && grep -q "not empty" "$LIVE_STDERR"; then
    pass "LIVE-COLLISION: the refusal names the database already there and says the target is not empty"
else
    fail "LIVE-COLLISION: the refusal message did not name the collision ($(cat "$LIVE_STDERR"))"
fi
LIVE_FINGERPRINT_AFTER_REFUSAL="$(live_fingerprint)"
if [ "$LIVE_FINGERPRINT_AFTER_REFUSAL" = "$LIVE_FINGERPRINT_BEFORE" ]; then
    pass "LIVE-COLLISION: ghost_tenant1.settings' row count and CHECKSUM are byte-for-byte unchanged after the refused restore"
else
    fail "LIVE-COLLISION: ghost_tenant1.settings changed after a restore that was supposed to refuse ($LIVE_FINGERPRINT_BEFORE -> $LIVE_FINGERPRINT_AFTER_REFUSAL)"
fi

note "LIVE-COLLISION SABOTAGE: remove the refusal, and the live database must go RED -- overwritten for real"
cp "$REPO_ROOT/db/recovery/restore_drained.py" "$WORKDIR/restore_drained.py.orig-live-collision"
sed -i.bak 's/^    assert_target_has_no_live_database(host=host, port=port, user=user, password=password, run=run)$/    pass  # SABOTAGE-LIVE-COLLISION: refusal removed/' \
    "$REPO_ROOT/db/recovery/restore_drained.py"
rm -f "$REPO_ROOT/db/recovery/restore_drained.py.bak"
if diff -q "$WORKDIR/restore_drained.py.orig-live-collision" "$REPO_ROOT/db/recovery/restore_drained.py" >/dev/null; then
    echo "FAILED: the sed sabotage did not change restore_drained.py -- cannot prove this control" >&2
    exit 1
fi
echo "sabotage applied: the refusal call is now a no-op"
if RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode restore-only --dump "$WORKDIR/tenant.sql" --host 127.0.0.1 --port "$LIVE_DB_PORT" --user root; then
    echo "RED (expected): restore_drained.py exited 0 against the live target with the refusal removed"
else
    fail "LIVE-COLLISION SABOTAGE: restore_drained.py still refused with the check removed -- sabotage did not take"
fi
LIVE_FINGERPRINT_AFTER_SABOTAGE="$(live_fingerprint)"
if [ "$LIVE_FINGERPRINT_AFTER_SABOTAGE" != "$LIVE_FINGERPRINT_BEFORE" ]; then
    pass "LIVE-COLLISION SABOTAGE: RED confirmed -- ghost_tenant1.settings' fingerprint actually changed ($LIVE_FINGERPRINT_BEFORE -> $LIVE_FINGERPRINT_AFTER_SABOTAGE), the live database was genuinely overwritten"
else
    fail "LIVE-COLLISION SABOTAGE: fingerprint did not change even with the refusal removed -- sabotage proved nothing"
fi

note "LIVE-COLLISION SABOTAGE: reverting, and reconfirming GREEN against a freshly reseeded live target"
cp "$WORKDIR/restore_drained.py.orig-live-collision" "$REPO_ROOT/db/recovery/restore_drained.py"
if diff -q "$WORKDIR/restore_drained.py.orig-live-collision" "$REPO_ROOT/db/recovery/restore_drained.py" >/dev/null; then
    echo "sabotage reverted: restore_drained.py matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
docker exec "$LIVE_DB" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e \
    "DROP DATABASE ghost_tenant1; CREATE DATABASE ghost_tenant1; CREATE TABLE ghost_tenant1.settings (id INT PRIMARY KEY, val VARCHAR(64)); INSERT INTO ghost_tenant1.settings VALUES (1,'alpha'),(2,'beta'),(3,'gamma');"
LIVE_FINGERPRINT_RESEEDED="$(live_fingerprint)"
if RESTORE_MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 "$REPO_ROOT/db/recovery/restore_drained.py" \
    --mode restore-only --dump "$WORKDIR/tenant.sql" --host 127.0.0.1 --port "$LIVE_DB_PORT" --user root; then
    fail "LIVE-COLLISION GREEN: restore_drained.py exited 0 after reverting the sabotage -- should have refused again"
else
    pass "LIVE-COLLISION GREEN: with the refusal reverted, restore_drained.py refuses the reseeded live target again"
fi
LIVE_FINGERPRINT_FINAL="$(live_fingerprint)"
if [ "$LIVE_FINGERPRINT_FINAL" = "$LIVE_FINGERPRINT_RESEEDED" ]; then
    pass "LIVE-COLLISION GREEN: the reseeded live database is unchanged after the (reverted, correct) refusal"
else
    fail "LIVE-COLLISION GREEN: the reseeded live database changed even with the refusal reverted"
fi

if [ "$FAILURES" -gt 0 ]; then
    echo
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo
echo "All restore-onto-a-drained-colour checks passed, GREEN, CONTROL and LIVE-COLLISION alike."
