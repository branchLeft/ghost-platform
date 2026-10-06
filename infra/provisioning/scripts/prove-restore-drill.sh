#!/bin/sh
# Live proof, real containers: the backup worker's real nightly loop dumps a
# synthetic Ghost tenant into a local SigV4-verifying S3 gateway, then
# restore_drill.py restores it end to end. Runs every control and sabotage
# listed in restore_drill.md#the-local-proof; exits non-zero on any wrong
# outcome. Usage: prove-restore-drill.sh (from anywhere; needs Docker).
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPTS="$REPO_ROOT/infra/provisioning/scripts"
DRILL="$SCRIPTS/restore_drill.py"
PYTHON="${PYTHON:-python3}"

RECOVERY_IMAGE="ghcr.io/branchleft/db-recovery@sha256:ceae7d89523d695bf60e98e874ae3430fb8c03566721108c9a21e26171ce2666"
MYSQL_IMAGE="mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b"
GHOST_IMAGE="${GHOST_IMAGE:-ghcr.io/branchleft/ghost-tenant@sha256:4b0441a00e96ad63539d43ff0078719a36fae00c2cdec4d966cd368cb15e14b1}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-ghcr.io/branchleft/drain-sidecar@sha256:04026b027ba472e319b2b038d4f4db1e873b2d855fad34b42ed8ee8a2a5d5d75}"
S3_IMAGE="versity/versitygw@sha256:a13b9adbda0ea9d4b1d929e4bed327e4eccc18d13c23f7e5d192d987dde5651d"

TENANT="synthetic"
SITE_TITLE="SYNTHETIC_TENANT_TITLE"
KNOWN_POST="SYNTHETIC_TENANT_KNOWN_POST"
DB_ROOT_PW="proofRootPw123!"
DUMP_PW="proofDumpPw456!"
S3_KEY="proofaccesskey"
S3_SECRET="proofsecretkey123456"
S3_PORT=7443

RUN=$$
NET="restore-drill-proof-net-$RUN"
SOURCE_DB="restore-drill-proof-db-$RUN"
SOURCE_GHOST="restore-drill-proof-ghost-$RUN"
S3="restore-drill-proof-s3-$RUN"
SOURCE_GHOST_PORT=4460

WORK="$(mktemp -d)"
chmod 0755 "$WORK"
mkdir -p "$WORK/certs" "$WORK/identities" "$WORK/drill-work" "$WORK/flags" "$WORK/metrics" "$WORK/s3data" \
    "$WORK/shim" "$WORK/logs"
chmod 0700 "$WORK/identities"
METRICS="$WORK/metrics/restore_drill.prom"
VOLUMES="$WORK/volumes.txt"
: >"$VOLUMES"
KEPT_LABEL="branchleft.restore-drill.proof-kept"

# The drill runs with this `docker` first on its PATH. It drops `--rm` from
# every short-lived container (labelling it instead) so the proof can read its
# logs afterwards, and before every `docker rm` it saves that container's logs
# and volume names. Everything else passes straight through.
REAL_DOCKER="$(command -v docker)"
cat >"$WORK/shim/docker" <<SHIM
#!/usr/bin/env python3
import os, subprocess, sys
real, logs, volumes, kept = "$REAL_DOCKER", "$WORK/logs", "$VOLUMES", "$KEPT_LABEL"
args = sys.argv[1:]
if args[:1] == ["run"] and "--rm" in args:
    args = ["run", "--label", kept + "=1"] + [a for a in args[1:] if a != "--rm"]
elif args[:1] == ["rm"]:
    for name in [a for a in args[1:] if not a.startswith("-")]:
        out = subprocess.run([real, "logs", name], capture_output=True)
        open(os.path.join(logs, name + ".log"), "wb").write(out.stdout + out.stderr)
        mounts = subprocess.run([real, "inspect", "--format", "{{range .Mounts}}{{.Name}} {{end}}", name],
                                capture_output=True, text=True).stdout.split()
        open(volumes, "a").write("".join(m + "\\n" for m in mounts))
os.execv(real, [real] + args)
SHIM
chmod 0755 "$WORK/shim/docker"

FAILURES=0
note() { echo; echo "== $* =="; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

restore_original() {
    [ -f "$WORK/restore_drill.py.orig" ] && cp "$WORK/restore_drill.py.orig" "$DRILL"
    rm -f "$WORK/restore_drill.py.orig"
}
# Every container this proof or a drill under it created: by name, by the
# drill's label, or by the shim's label. Their volumes are recorded first.
teardown() {
    ids="$( (docker ps -aq --filter name=restore-drill; docker ps -aq --filter label=branchleft.restore-drill;
        docker ps -aq --filter "label=$KEPT_LABEL") | sort -u)"
    for id in $ids; do
        docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' "$id" 2>/dev/null | tr ' ' '\n' >>"$VOLUMES"
    done
    if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
    for net in $(docker network ls -q --filter name=restore-drill); do docker network rm "$net" >/dev/null 2>&1 || true; done
    for vol in $(grep -v '^$' "$VOLUMES" | sort -u); do
        if docker volume inspect "$vol" >/dev/null 2>&1; then docker volume rm "$vol" >/dev/null 2>&1 || true; fi
    done
    return 0
}
cleanup() {
    restore_original
    [ -f "$VOLUMES" ] && teardown
    rm -rf "$WORK"
}
trap cleanup EXIT

sabotage() {
    # $1 = sed expression; $2 = what it breaks. The file is restored on exit
    # whatever happens, and by revert() on the normal path.
    cp "$DRILL" "$WORK/restore_drill.py.orig"
    sed -i.bak "$1" "$DRILL" && rm -f "$DRILL.bak"
    if cmp -s "$DRILL" "$WORK/restore_drill.py.orig"; then
        echo "FAILED: sabotage ($2) did not change restore_drill.py" >&2
        exit 1
    fi
    echo "sabotage applied: $2"
}
revert() {
    restore_original
    echo "sabotage reverted"
}

# Operator-side S3 access for the proof's own setup and control objects,
# through the same SigV4 module the worker and the drill use.
s3() {
    SSL_CERT_FILE="$WORK/certs/s3.crt" "$PYTHON" - "$@" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import shared_objectstorage as s3
op, endpoint, bucket = sys.argv[2], sys.argv[3], sys.argv[4]
creds = dict(endpoint=endpoint, region="us-east-1", access_key="proofaccesskey", secret_key="proofsecretkey123456", bucket=bucket)
if op == "mkbucket":
    status, body = s3.signed_request(method="PUT", **creds)
    assert status == 200, (status, body)
elif op == "put":
    s3.put_object(key=sys.argv[5], data=open(sys.argv[6], "rb").read(), **creds)
elif op == "delete":
    s3.delete_object(key=sys.argv[5], **creds)
elif op == "list":
    for entry in s3.list_objects(prefix=sys.argv[5], **creds):
        print(entry["key"])
PY
}

drill_exec() {
    exec env -i PATH="$WORK/shim:$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
        SSL_CERT_FILE="$WORK/certs/s3.crt" \
        BACKUP_DRILL_COPY_PRIMARY_BUCKET=drill-primary \
        BACKUP_DRILL_COPY_PRIMARY_ENDPOINT="localhost:$S3_PORT" \
        BACKUP_DRILL_COPY_PRIMARY_REGION=us-east-1 \
        BACKUP_DRILL_COPY_PRIMARY_ACCESS_KEY_ID="$S3_KEY" \
        BACKUP_DRILL_COPY_PRIMARY_SECRET_ACCESS_KEY="$S3_SECRET" \
        BACKUP_DRILL_COPY_SECONDARY_BUCKET=drill-secondary \
        BACKUP_DRILL_COPY_SECONDARY_ENDPOINT="localhost:$S3_PORT" \
        BACKUP_DRILL_COPY_SECONDARY_REGION=us-east-1 \
        BACKUP_DRILL_COPY_SECONDARY_ACCESS_KEY_ID="$S3_KEY" \
        BACKUP_DRILL_COPY_SECONDARY_SECRET_ACCESS_KEY="$S3_SECRET" \
        BACKUP_DRILL_RECOVERY_IMAGE="$RECOVERY_IMAGE" \
        BACKUP_DRILL_MYSQL_IMAGE="$MYSQL_IMAGE" \
        BACKUP_DRILL_GHOST_IMAGE="$GHOST_IMAGE" \
        BACKUP_DRILL_SIDECAR_IMAGE="$SIDECAR_IMAGE" \
        BACKUP_DRILL_IDENTITY_DIR="$WORK/identities" \
        BACKUP_DRILL_WORK_DIR="$WORK/drill-work" \
        BACKUP_DRILL_FLAG_ROOT="$WORK/flags" \
        BACKUP_DRILL_METRICS_DIR="$WORK/metrics" \
        BACKUP_DRILL_REQUIRE_VOLATILE_WORK_DIR=0 \
        BACKUP_DRILL_CONTENT_TIMEOUT_S=240 \
        "$PYTHON" "$DRILL" --tenants-file "$WORK/tenants" "$@"
}
drill() {
    (drill_exec "$@") >"$WORK/drill.out" 2>&1
    rc=$?
    harvest_kept
    return $rc
}
# Reads the logs of every short-lived container the shim kept, records its
# log driver, then removes it with its volumes.
harvest_kept() {
    for id in $(docker ps -aq --filter "label=$KEPT_LABEL"); do
        docker logs "$id" >"$WORK/logs/kept-$id.log" 2>&1
        echo "$id $(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$id")" >>"$WORK/logs/drivers.txt"
        docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' "$id" | tr ' ' '\n' >>"$VOLUMES"
        docker rm -f -v "$id" >/dev/null
    done
}
# No tenant plaintext or key material in any container log the drill produced.
CANARIES="AGE-SECRET-KEY-1|SHREDDED_TENANT_CANARY|drill-member@example.test|$KNOWN_POST body"
logs_clean() {
    found="$(grep -lE "$CANARIES" "$WORK"/logs/*.log 2>/dev/null || true)"
    drivers="$(awk '$2 != "none"' "$WORK/logs/drivers.txt" 2>/dev/null || true)"
    kept="$(wc -l <"$WORK/logs/drivers.txt" 2>/dev/null | tr -d ' ')"
    if [ -z "$found" ] && [ -z "$drivers" ] && [ "${kept:-0}" -gt 0 ]; then
        echo "clean: $kept short-lived container(s), all --log-driver none; $(ls "$WORK"/logs/*.log | wc -l | tr -d ' ') log(s) read"
        return 0
    fi
    echo "plaintext or key material in: ${found:-nothing}; drivers other than none: ${drivers:-none}"
    return 1
}
drill_expect() {
    # $1 = pass|fail, $2 = text the output must carry, $3 = label, rest = drill args
    want="$1"; text="$2"; label="$3"; shift 3
    if drill "$@"; then got=pass; else got=fail; fi
    sed 's/^/    /' "$WORK/drill.out"
    if [ "$got" = "$want" ] && grep -qF -- "$text" "$WORK/drill.out"; then
        pass "$label"
    else
        fail "$label (wanted $want with '$text', got $got)"
    fi
}
metric() { awk -v n="restore_drill_$1" '$1 == n {print $2}' "$METRICS"; }
no_leftovers() {
    if [ -z "$(docker ps -aq --filter label=branchleft.restore-drill)" ] \
        && [ -z "$(ls -A "$WORK/drill-work")" ] && [ -z "$(ls -A "$WORK/flags" | grep -v '^drill.lock$' || true)" ]; then
        pass "$1: no drill container, decrypted dump or drain flag left behind"
    else
        fail "$1: the drill left something behind"
    fi
}

note "TLS for the S3 gateway, and the gateway itself (verifies SigV4 against its one root key)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:$S3,IP:127.0.0.1" \
    -keyout "$WORK/certs/s3.key" -out "$WORK/certs/s3.crt" >/dev/null 2>&1
chmod 0644 "$WORK/certs/s3.key"
docker network create "$NET" >/dev/null
docker run -d --name "$S3" --network "$NET" -p "127.0.0.1:$S3_PORT:7070" \
    -v "$WORK/certs:/certs:ro" -v "$WORK/s3data:/data" \
    -e ROOT_ACCESS_KEY_ID="$S3_KEY" -e ROOT_SECRET_ACCESS_KEY="$S3_SECRET" \
    "$S3_IMAGE" --cert /certs/s3.crt --key /certs/s3.key posix /data >/dev/null
deadline=$(($(date +%s) + 30))
until s3 "$SCRIPTS" mkbucket "localhost:$S3_PORT" drill-primary 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "FAILED: S3 gateway never answered" >&2; docker logs "$S3" | tail; exit 1; }
    sleep 1
done
s3 "$SCRIPTS" mkbucket "localhost:$S3_PORT" drill-secondary
pass "gateway up over TLS with buckets drill-primary and drill-secondary"

note "The source database: pinned MySQL 8.0, and a TLS-only backup account with the control host's grants"
docker run -d --name "$SOURCE_DB" --network "$NET" -e MYSQL_ROOT_PASSWORD="$DB_ROOT_PW" \
    -e MYSQL_DATABASE="ghost_$TENANT" "$MYSQL_IMAGE" >/dev/null
deadline=$(($(date +%s) + 120))
until docker exec "$SOURCE_DB" mysqladmin ping -h 127.0.0.1 -uroot -p"$DB_ROOT_PW" --silent >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "FAILED: source MySQL never ready" >&2; exit 1; }
    sleep 1
done
docker exec "$SOURCE_DB" mysql -uroot -p"$DB_ROOT_PW" -e \
    "CREATE USER 'backup_drill'@'%' IDENTIFIED BY '$DUMP_PW' REQUIRE SSL; GRANT SELECT, RELOAD, PROCESS, REPLICATION CLIENT, SHOW VIEW, TRIGGER ON *.* TO 'backup_drill'@'%';" 2>/dev/null
docker cp "$SOURCE_DB:/var/lib/mysql/ca.pem" "$WORK/certs/db-ca.pem" >/dev/null
chmod 0644 "$WORK/certs/db-ca.pem"
pass "source MySQL ready; backup_drill has SELECT, RELOAD, PROCESS, REPLICATION CLIENT, SHOW VIEW, TRIGGER, TLS required"

note "A synthetic tenant: a real Ghost, a real owner, a titled site, a named post and a member"
docker run -d --name "$SOURCE_GHOST" --network "$NET" -p "127.0.0.1:${SOURCE_GHOST_PORT}:2368" \
    -e url="http://localhost:${SOURCE_GHOST_PORT}" \
    -e database__client=mysql -e database__connection__host="$SOURCE_DB" -e database__connection__port=3306 \
    -e database__connection__database="ghost_$TENANT" -e database__connection__user=root \
    -e database__connection__password="$DB_ROOT_PW" -e privacy__useUpdateCheck=false \
    -e "logging__transports=[\"stdout\"]" -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e storage__images__adapter=ScanningStorageAdapter -e storage__images__wraps=LocalImagesStorage \
    -e storage__images__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__media__adapter=ScanningStorageAdapter -e storage__media__wraps=LocalMediaStorage \
    -e storage__media__quarantinePath=/var/lib/ghost/content/quarantine \
    -e storage__files__adapter=ScanningStorageAdapter -e storage__files__wraps=LocalFilesStorage \
    -e storage__files__quarantinePath=/var/lib/ghost/content/quarantine \
    "$GHOST_IMAGE" >/dev/null
ORIGIN="http://localhost:${SOURCE_GHOST_PORT}"
deadline=$(($(date +%s) + 300))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/")" = "200" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "FAILED: source Ghost never answered 200" >&2; docker logs "$SOURCE_GHOST" | tail -30; exit 1; }
    sleep 2
done
COOKIES="$WORK/cookies.txt"
curl -sf -c "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d "{\"setup\":[{\"name\":\"Drill Proof Owner\",\"email\":\"drill-owner@example.test\",\"password\":\"DrillProof123!\",\"blogTitle\":\"$SITE_TITLE\"}]}" \
    "$ORIGIN/ghost/api/admin/authentication/setup/" >/dev/null
curl -sf -c "$COOKIES" -b "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d '{"username":"drill-owner@example.test","password":"DrillProof123!"}' \
    "$ORIGIN/ghost/api/admin/session/" >/dev/null
curl -sf -b "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d "{\"posts\":[{\"title\":\"$KNOWN_POST\",\"html\":\"<p>$KNOWN_POST body</p>\",\"status\":\"published\"}]}" \
    "$ORIGIN/ghost/api/admin/posts/?source=html" >/dev/null
curl -sf -b "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d '{"members":[{"email":"drill-member@example.test"}]}' \
    "$ORIGIN/ghost/api/admin/members/" >/dev/null
pass "source Ghost titled $SITE_TITLE, with $KNOWN_POST published and one member"

note "The tenant's own age key, held where the drill reads identities"
docker run --rm --network none "$RECOVERY_IMAGE" age-keygen >"$WORK/identities/$TENANT.key" 2>/dev/null
chmod 0600 "$WORK/identities/$TENANT.key"
RECIPIENT="$(sed -n 's/^# public key: //p' "$WORK/identities/$TENANT.key")"
echo "$TENANT" >"$WORK/tenants"
echo "$TENANT $RECIPIENT" >"$WORK/recipients"

note "The REAL backup worker (nightly_dump_loop.py over RemoteMysqldumpTransport), inside the recovery image's toolchain, writing both copies"
docker run --rm --network "$NET" -v "$REPO_ROOT:/repo:ro" -v "$WORK/certs:/certs:ro" -v "$WORK/recipients:/recipients:ro" \
    -e BACKUP_WORKER_DB_HOST="$SOURCE_DB" -e BACKUP_WORKER_MYSQL_USER=backup_drill \
    -e BACKUP_WORKER_MYSQL_SSL_CA=/certs/db-ca.pem -e DB_DUMP_MYSQL_PWD="$DUMP_PW" \
    -e BACKUP_WORKER_RECIPIENTS_FILE=/recipients -e SSL_CERT_FILE=/certs/s3.crt \
    -e BACKUP_WORKER_COPY_PRIMARY_BUCKET=drill-primary -e BACKUP_WORKER_COPY_PRIMARY_ENDPOINT="$S3:7070" \
    -e BACKUP_WORKER_COPY_PRIMARY_REGION=us-east-1 -e BACKUP_WORKER_COPY_PRIMARY_ACCESS_KEY_ID="$S3_KEY" \
    -e BACKUP_WORKER_COPY_PRIMARY_SECRET_ACCESS_KEY="$S3_SECRET" \
    -e BACKUP_WORKER_COPY_SECONDARY_BUCKET=drill-secondary -e BACKUP_WORKER_COPY_SECONDARY_ENDPOINT="$S3:7070" \
    -e BACKUP_WORKER_COPY_SECONDARY_REGION=us-east-1 -e BACKUP_WORKER_COPY_SECONDARY_ACCESS_KEY_ID="$S3_KEY" \
    -e BACKUP_WORKER_COPY_SECONDARY_SECRET_ACCESS_KEY="$S3_SECRET" \
    -e BACKUP_WORKER_METRICS_DIR=/tmp/metrics -e NIGHTLY_DUMP_LOOP_RUN_LOCK_PATH=/tmp/loop.lock \
    "$RECOVERY_IMAGE" python3 /repo/infra/provisioning/scripts/nightly_dump_loop.py --tenant "$TENANT"
OBJECTS="$(s3 "$SCRIPTS" list "localhost:$S3_PORT" drill-primary "dumps/$TENANT/")"
[ -n "$OBJECTS" ] || { echo "FAILED: the worker stored nothing" >&2; exit 1; }
pass "the worker stored $OBJECTS to both copies"
docker rm -f -v "$SOURCE_GHOST" "$SOURCE_DB" >/dev/null
pass "the source database and its Ghost are gone: the drill restores from the backup alone"

note "GREEN (primary copy): restore, content on a drained colour, undrain last, erasure refused"
drill_expect pass "title='$SITE_TITLE'" "GREEN primary: the drill passed and read the tenant's own title" --copy primary
grep -qF "backed up: title='$SITE_TITLE' users=1 published_posts=2 members=1 newest_post='$KNOWN_POST'" "$WORK/drill.out" \
    && pass "GREEN primary: the worker's manifest recorded the source's title, counts and named post" || fail "GREEN primary: manifest"
grep -qF "newest_post='$KNOWN_POST'" "$WORK/drill.out" && grep -qF "members=1" "$WORK/drill.out" \
    && pass "GREEN primary: the named post and the member came back" || fail "GREEN primary: content missing"
grep -qF "no identity matched any of the recipients" "$WORK/drill.out" \
    && pass "GREEN primary: the shredded tenant was refused because no key matched" || fail "GREEN primary: erasure reason missing"
[ "$(metric last_run_success)" = "1.0" ] && pass "GREEN primary: last_run_success exported as 1" || fail "GREEN primary: metric"
[ -n "$(metric last_success_timestamp_seconds)" ] && pass "GREEN primary: last_success_timestamp_seconds exported" || fail "GREEN primary: no last success"
no_leftovers "GREEN primary"
if out="$(logs_clean)"; then pass "LOGS: $out"; else fail "LOGS: $out"; fi

note "GREEN (secondary copy): the other copy restores too"
drill_expect pass "copy=secondary" "GREEN secondary: the drill passed from the second copy" --copy secondary
GREEN_SUCCESS="$(metric last_success_timestamp_seconds)"
no_leftovers "GREEN secondary"

note "CONTROL: an empty backup object, newer than the real one"
: >"$WORK/empty.sql"
docker run --rm -i --network none "$RECOVERY_IMAGE" age -r "$RECIPIENT" <"$WORK/empty.sql" >"$WORK/empty.sql.age"
EMPTY_KEY="dumps/$TENANT/$(date -u -v+1M +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d '+1 min' +%Y%m%dT%H%M%SZ).sql.age"
s3 "$SCRIPTS" put "localhost:$S3_PORT" drill-primary "$EMPTY_KEY" "$WORK/empty.sql.age"
drill_expect fail "carries no manifest" "CONTROL: the empty backup is refused: it carries no manifest" --copy primary
[ "$(metric last_run_success)" = "0.0" ] && [ "$(metric last_success_timestamp_seconds)" = "$GREEN_SUCCESS" ] \
    && pass "CONTROL: last_run_success 0, last success left at the GREEN run's time" || fail "CONTROL: metrics"
no_leftovers "CONTROL"
s3 "$SCRIPTS" delete "localhost:$S3_PORT" drill-primary "$EMPTY_KEY"

note "CONTROL: a backup that restores nothing but carries the real tenant's manifest, so Ghost boots its own defaults"
REAL_KEY="$(s3 "$SCRIPTS" list "localhost:$S3_PORT" drill-primary "dumps/$TENANT/" | tail -1)"
s3get() {
    SSL_CERT_FILE="$WORK/certs/s3.crt" "$PYTHON" -c "
import sys; sys.path.insert(0, '$SCRIPTS')
import shared_objectstorage as s3
sys.stdout.buffer.write(s3.get_object(endpoint='localhost:$S3_PORT', region='us-east-1', access_key='$S3_KEY',
    secret_key='$S3_SECRET', bucket='drill-primary', key='$1'))"
}
s3get "$REAL_KEY" | docker run --rm -i --log-driver none --network none -v "$WORK/identities:/ids:ro" "$RECOVERY_IMAGE" \
    age --decrypt -i "/ids/$TENANT.key" | grep '^-- branchleft-backup-manifest v1 ' >"$WORK/manifest-only.sql"
[ -s "$WORK/manifest-only.sql" ] || { echo "FAILED: the real backup carries no manifest line" >&2; exit 1; }
docker run --rm -i --network none "$RECOVERY_IMAGE" age -r "$RECIPIENT" <"$WORK/manifest-only.sql" >"$WORK/defaults.sql.age"
DEFAULTS_KEY="dumps/$TENANT/$(date -u -v+2M +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d '+2 min' +%Y%m%dT%H%M%SZ).sql.age"
s3 "$SCRIPTS" put "localhost:$S3_PORT" drill-primary "$DEFAULTS_KEY" "$WORK/defaults.sql.age"
drill_expect fail "no Ghost schema" "DEFAULTS: refused before any colour starts -- nothing to compare with the backup" --copy primary
sabotage 's/^        compare_with_manifest(report.content, report.manifest)$/        pass  # SABOTAGE/' "comparison removed"
drill_expect fail "'$SITE_TITLE' not found" "DEFAULTS, comparison removed: still RED -- Ghost served its install defaults, not the backed-up title" --copy primary
revert
sabotage 's/^        compare_with_manifest(report.content, report.manifest)$/        pass  # SABOTAGE/;s/expected_from_manifest(report.manifest):/expected_from_manifest(report.content):/' "comparison removed and expectations taken from the restore"
drill_expect pass "restore_drill: PASS" "DEFAULTS SABOTAGE: RED confirmed -- judged against itself, Ghost's install defaults pass" --copy primary
revert
drill_expect fail "no Ghost schema" "DEFAULTS after revert: refused again" --copy primary
s3 "$SCRIPTS" delete "localhost:$S3_PORT" drill-primary "$DEFAULTS_KEY"
no_leftovers "DEFAULTS"

note "CONTROL: a real-shaped backup object with a second recipient"
docker run --rm --network none "$RECOVERY_IMAGE" age-keygen 2>/dev/null | sed -n 's/^# public key: //p' >"$WORK/second.pub"
echo "SECOND_RECIPIENT_CANARY" | docker run --rm -i --network none "$RECOVERY_IMAGE" \
    age -r "$RECIPIENT" -r "$(cat "$WORK/second.pub")" >"$WORK/two.sql.age"
s3 "$SCRIPTS" put "localhost:$S3_PORT" drill-primary "dumps/$TENANT/20000101T000000Z.sql.age" "$WORK/two.sql.age"
drill_expect fail "names 2 recipients" "CONTROL: an object with two recipients fails the recipient check" --copy primary
sabotage 's/^    if len(stanzas) != 1:$/    if len(stanzas) < 1:/' "one-recipient check"
drill_expect pass "restore_drill: PASS" "RECIPIENT SABOTAGE: RED confirmed -- with the check loosened the two-recipient object passes" --copy primary
revert
drill_expect fail "names 2 recipients" "RECIPIENT after revert: the two-recipient object fails again" --copy primary
s3 "$SCRIPTS" delete "localhost:$S3_PORT" drill-primary "dumps/$TENANT/20000101T000000Z.sql.age"

note "ERASURE SABOTAGE: the destroyed key survives where the drill holds keys"
sabotage 's#^        _destroy_file(key_path)$#        os.replace(key_path, identity_dir / f"leaked{IDENTITY_SUFFIX}")#' "key destruction"
drill_expect fail "ErasureBrokenError" "ERASURE SABOTAGE: RED confirmed -- a kept key decrypts the shredded tenant and the drill fails" --copy primary
revert
rm -f "$WORK/identities/leaked.key"
drill_expect pass "restore_drill: PASS" "ERASURE after revert: the full drill passes again" --copy primary
no_leftovers "final"

note "LOGS SABOTAGE: drop --log-driver none; Docker must then keep the decrypted dump in a container log"
rm -f "$WORK"/logs/*.log "$WORK/logs/drivers.txt"
sabotage 's/^NO_LOGS = ("--log-driver", "none")$/NO_LOGS = ()/' "no log driver"
drill --copy primary || true
if out="$(logs_clean)"; then fail "LOGS SABOTAGE: logs still clean without the flag -- $out"; else pass "LOGS SABOTAGE: RED confirmed -- $out"; fi
revert
rm -f "$WORK"/logs/*.log "$WORK/logs/drivers.txt"
drill --copy primary || true
if out="$(logs_clean)"; then pass "LOGS after revert: $out"; else fail "LOGS after revert: $out"; fi

note "SIGTERM: stop the drill while the decrypted dump is on disk"
sigterm_case() {
    (drill_exec --copy primary) >"$WORK/drill.out" 2>&1 &
    pid=$!
    deadline=$(($(date +%s) + 300))
    until ls "$WORK"/drill-work/run-*/dump.sql >/dev/null 2>&1 && [ -n "$(docker ps -q --filter name=restore-drill-mysql)" ]; do
        [ "$(date +%s)" -lt "$deadline" ] || { echo "the drill never reached its restore"; return 1; }
        sleep 0.5
    done
    echo "dump on disk: $(ls "$WORK"/drill-work/run-*/dump.sql)"
    kill -TERM "$pid"
    wait "$pid"
    rc=$?
    harvest_kept
    sed 's/^/    /' "$WORK/drill.out"
    echo "exit $rc"
    [ "$rc" = 143 ] && [ -z "$(ls -A "$WORK/drill-work")" ] \
        && [ -z "$(docker ps -aq --filter label=branchleft.restore-drill)" ] && grep -q SIGTERM "$WORK/drill.out" \
        && [ "$(metric last_run_success)" = "0.0" ]
}
if sigterm_case; then pass "SIGTERM: exit 143, no dump left, no drill container left, run exported as failed"
else fail "SIGTERM: something survived the stop"; fi
sabotage 's/^    previous = signal.signal(signal.SIGTERM, _on_sigterm)$/    previous = signal.getsignal(signal.SIGTERM)/' "SIGTERM handler not installed"
if sigterm_case; then fail "SIGTERM SABOTAGE: still clean with no handler"
else pass "SIGTERM SABOTAGE: RED confirmed -- with no handler the dump and the restore containers survive the stop"; fi
revert
teardown
rm -rf "$WORK"/drill-work/run-* "$WORK"/flags/run-*
if out="$(logs_clean)"; then pass "LOGS across every run since the sabotage: $out"; else fail "LOGS: $out"; fi

note "Teardown: every container, network and volume this proof created"
teardown
docker rm -f -v "$SOURCE_GHOST" "$SOURCE_DB" "$S3" >/dev/null 2>&1 || true
LEFT_CONTAINERS="$( (docker ps -aq --filter name=restore-drill; docker ps -aq --filter label=branchleft.restore-drill;
    docker ps -aq --filter "label=$KEPT_LABEL") | sort -u)"
LEFT_VOLUMES=""
for vol in $(grep -v '^$' "$VOLUMES" | sort -u); do
    if docker volume inspect "$vol" >/dev/null 2>&1; then LEFT_VOLUMES="$LEFT_VOLUMES $vol"; fi
done
echo "docker ps -a (restore-drill names and labels): ${LEFT_CONTAINERS:-none}"
echo "docker volume ls (the $(grep -cv '^$' "$VOLUMES") volume(s) the proof's containers used): ${LEFT_VOLUMES:-none}"
[ -z "$LEFT_CONTAINERS" ] && [ -z "$LEFT_VOLUMES" ] && [ -z "$(docker network ls -q --filter name=restore-drill)" ] \
    && pass "teardown: no container, network or volume of this proof remains" || fail "teardown: something remains"

if [ "$FAILURES" -gt 0 ]; then
    echo
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo
echo "All restore drill checks passed: GREEN on both copies, and every control red for its own reason."
