#!/bin/sh
# Live proof that media backup/restore round-trips real bytes: a real,
# pinned Ghost 6.55.0 container (this repo's own image, its built-in
# S3Storage adapter, no mocks) uploads a real image to a real S3-compatible
# store; media_backup_restore.py's real CLI entry points back it up,
# encrypted to a real `age` identity, and restore it after the source is
# genuinely destroyed; a fresh SHA-256 of the restored bytes is compared
# against the original upload's digest.
#
# 09-backup-and-recovery.html's own control (a Ghost pointed at an empty
# database serves HTTP 200) is why this proof never treats "the restore
# command exited 0" as the assertion -- every round below checks the
# recovered bytes' digest, and every sabotage checks that the wrong outcome
# is caught rather than reported as success.
#
# Nine rounds:
#   GREEN-1   real backup + restore, genuine destroy in between, digest match
#   RED-1     a corrupted backup object must fail the restore  -> repaired
#   RED-2     a missing backup object must fail the restore    -> repaired
#   RED-3     a backup that captures zero objects must refuse BY DEFAULT;
#             only an explicit, loudly-named flag allows a genuinely empty
#             tenant through, and restoring THAT stays a legitimate success
#   RED-4     the CLI's own exit code, disconnected from the verification
#             it just ran, must be caught as a wiring defect -> reverted
#   RED-5     a second age recipient in a ciphertext's own header must be
#             refused, even though `encrypt_with_age`'s argv never carries
#             one -> reverted
#   RED-6     a backup id derived from the plaintext digest -- a content
#             fingerprint that survives crypto-shredding, since it needs no
#             key to recompute -- must not appear in the backup bucket's
#             listing -> reverted
#   C-REFRESH-1  a second backup run supersedes the first: a fresh random
#                key, the first generation's ciphertext genuinely gone (not
#                merely unreferenced), object count never grows across a
#                run, and restore still verifies afterwards
#   C-REFRESH-2  an upload failing partway through a run must leave the
#                PREVIOUS generation's objects untouched and still
#                restorable -- sabotage the module's own upload call to fail
#                on the second object -> reverted
#   CONCURRENT-1 two REAL, overlapping CLI `backup` invocations against the
#                same tenant, launched as genuinely parallel OS processes
#                against the same live Ghost/MinIO sandbox -- nothing is
#                deleted out from under a still-restorable generation, and
#                restore succeeds afterwards regardless of which process
#                actually finished last
#   LOSSY-PUT    an object PUT that answers success without the object
#                actually landing must be caught, before this run's own
#                manifest is ever written -- so a default restore afterwards
#                still succeeds, reading the untouched previous generation
#   MANIFEST-MISMATCH  the one failure the LOSSY-PUT ordering cannot itself
#                prevent: a manifest PUT that reports success but stores
#                different bytes. The torn manifest key DOES exist, so a
#                default restore must refuse it rather than invent a
#                fallback -- and must name the newest OLDER generation and
#                the exact --run-id command that recovers it, which this
#                round then runs for real
# Plus one direct check outside the RED/GREEN frame: restoring with a
# different tenant's identity is refused (the crypto-shredding property).
#
# Local-sandbox simplifications, never production shape: one MinIO root
# credential stands in for the live/backup/target custody split
# render-media-bucket-policy.py enforces for real (IAM scoping is that
# script's own proof, not this one's); MinIO's self-signed TLS cert is
# trusted via SSL_CERT_FILE rather than a real CA, because
# db/provision/objectstorage.py's request_url is deliberately hardcoded to
# https (Hetzner's endpoint always is) and this proof exercises that same
# unmodified code, not a plaintext-HTTP shortcut. C-refresh's own delete
# step is a plain DELETE against MinIO too -- MinIO turns that into a
# delete marker on a versioned bucket the same way Hetzner does, but this
# proof does not itself enable bucket versioning on `backup`/MinIO, so here
# it is a genuine removal; the noncurrent-version survival window is what
# `probe-media-lifecycle-expiration.py`'s prefix-split mode proves against
# real Hetzner Object Storage instead.
#
# Prerequisites on the workstation running this: docker, age (age-keygen),
# openssl, curl, jq, python3, comm (present in every base macOS/Linux
# install). Pulls quay.io/minio/minio and quay.io/minio/mc (Docker Hub's
# minio/minio now refuses anonymous pulls).
#
# Usage: ./infra/provisioning/scripts/media-backup-restore-proof.sh
# Run from anywhere -- it cds to the repo root itself.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

RUN=$$
NET="media-restore-proof-net-$RUN"
MINIO_NAME="media-restore-proof-minio-$RUN"
GHOST_NAME="media-restore-proof-ghost-$RUN"
WORKDIR="$(mktemp -d)"
GHOST_PORT=4310
MINIO_PORT=9510
ORIGIN="http://localhost:${GHOST_PORT}"
MINIO_ENDPOINT="127.0.0.1:${MINIO_PORT}"
MINIO_INTERNAL_ENDPOINT="https://${MINIO_NAME}:9000"
REGION="us-east-1"
MINIO_ROOT_USER="minioadmin"
MINIO_ROOT_PASSWORD="minioadmin123"
LIVE_BUCKET="live-tenant-a"
LIVE_EMPTY_BUCKET="live-tenant-a-empty"
BACKUP_BUCKET="backup"
RESTORED_BUCKET="restored-tenant-a"
SCRIPTS_DIR="infra/provisioning/scripts"

FAILURES=0
note() { echo; echo "== $* =="; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

cleanup() {
    docker rm -f "$GHOST_NAME" "$MINIO_NAME" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    # Belt-and-braces revert of the RED-4, RED-5, RED-6 and C-REFRESH-2
    # sabotages, in case the script exited before their own explicit reverts
    # ran. A saved copy on disk, not `git checkout --`: the latter depends
    # on this file's commit state, which this trap has no reason to assume
    # anything about, while a copy taken immediately before the sabotage is
    # unconditionally correct.
    for saved in "$WORKDIR/media_backup_restore.py.orig" "$WORKDIR/media_backup_restore.py.orig-red5" "$WORKDIR/media_backup_restore.py.orig-red6" "$WORKDIR/media_backup_restore.py.orig-crefresh2" "$WORKDIR/media_backup_restore.py.orig-lossyput"; do
        [ -f "$saved" ] && cp "$saved" "$SCRIPTS_DIR/media_backup_restore.py"
    done
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$WORKDIR/certs"

note "Generating tenant-a, tenant-b and tenant-c age identities"
age-keygen -o "$WORKDIR/tenant-a.identity" 2>"$WORKDIR/tenant-a.pub.raw"
TENANT_A_RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORKDIR/tenant-a.pub.raw" | head -1)"
age-keygen -o "$WORKDIR/tenant-b.identity" 2>"$WORKDIR/tenant-b.pub.raw"
TENANT_B_RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORKDIR/tenant-b.pub.raw" | head -1)"
# tenant-c: used only for the confirm-empty round below -- a genuinely brand-new
# tenant with NO previous generation, which is the only case
# --confirm-tenant-has-no-media is actually for.
age-keygen -o "$WORKDIR/tenant-c.identity" 2>"$WORKDIR/tenant-c.pub.raw"
TENANT_C_RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORKDIR/tenant-c.pub.raw" | head -1)"
[ -n "$TENANT_A_RECIPIENT" ] && [ -n "$TENANT_B_RECIPIENT" ] && [ -n "$TENANT_C_RECIPIENT" ] || {
    echo "FAILED: could not extract an age public key from age-keygen's output" >&2
    exit 1
}
echo "tenant-a recipient: $TENANT_A_RECIPIENT"
echo "tenant-b recipient: $TENANT_B_RECIPIENT"

note "Generating a self-signed cert for MinIO (this proof's endpoint is https, like Hetzner's real one)"
openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/certs/private.key" -out "$WORKDIR/certs/public.crt" \
    -days 1 -nodes -subj "/CN=${MINIO_NAME}" \
    -addext "subjectAltName=DNS:${MINIO_NAME},DNS:localhost,IP:127.0.0.1" 2>/dev/null
SSL_CERT_FILE="$WORKDIR/certs/public.crt"
export SSL_CERT_FILE

note "Writing the fixture image -- a real, valid, tiny PNG, generated rather than committed as a binary"
cat > "$WORKDIR/make_fixture.py" <<'PYEOF'
import struct
import sys
import zlib


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


width, height = 6, 6
raw = b""
for y in range(height):
    raw += b"\x00" + bytes(
        c for x in range(width) for c in ((x * 40 + y * 7) % 256, (y * 30) % 256, 128)
    )
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw))
    + chunk(b"IEND", b"")
)
with open(sys.argv[1], "wb") as f:
    f.write(png)
PYEOF
python3 "$WORKDIR/make_fixture.py" "$WORKDIR/fixture.png"
FIXTURE_SHA256="$(shasum -a 256 "$WORKDIR/fixture.png" | cut -d' ' -f1)"
echo "fixture: $WORKDIR/fixture.png sha256=$FIXTURE_SHA256"

note "Building the platform image"
docker build -q -t media-restore-proof-ghost:local . >/dev/null

note "Starting MinIO (TLS, path-style, like the real Hetzner endpoint) and creating buckets"
docker network create "$NET" >/dev/null
docker run -d --name "$MINIO_NAME" --network "$NET" -p "${MINIO_PORT}:9000" \
    -e MINIO_ROOT_USER="$MINIO_ROOT_USER" -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
    -v "$WORKDIR/certs:/root/.minio/certs" \
    quay.io/minio/minio:latest server /data >/dev/null

deadline=$(($(date +%s) + 30))
until curl -sk -o /dev/null "https://127.0.0.1:${MINIO_PORT}/minio/health/live"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "FAILED: MinIO did not become ready within 30s" >&2
        docker logs "$MINIO_NAME" >&2
        exit 1
    fi
    sleep 1
done

docker run --rm --network "$NET" \
    -e MC_HOST_local="https://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@${MINIO_NAME}:9000" \
    quay.io/minio/mc:latest --insecure mb \
    "local/${LIVE_BUCKET}" "local/${LIVE_EMPTY_BUCKET}" "local/${BACKUP_BUCKET}" "local/${RESTORED_BUCKET}" \
    >/dev/null

note "Starting Ghost, configured to store media on MinIO (real S3Storage adapter, no mock)"
docker run -d --name "$GHOST_NAME" --network "$NET" -p "${GHOST_PORT}:2368" \
    -e url="$ORIGIN" \
    -e database__client=sqlite3 \
    -e database__connection__filename=/var/lib/ghost/content/data/media-proof.db \
    -e privacy__useUpdateCheck=false \
    -e "logging__transports=[\"stdout\"]" \
    -e storage__active=S3Storage \
    -e storage__S3Storage__bucket="$LIVE_BUCKET" \
    -e storage__S3Storage__staticFileURLPrefix=content/images \
    -e storage__S3Storage__cdnUrl="${MINIO_INTERNAL_ENDPOINT}/${LIVE_BUCKET}" \
    -e storage__S3Storage__multipartUploadThresholdBytes=10485760 \
    -e storage__S3Storage__multipartChunkSizeBytes=5242880 \
    -e storage__S3Storage__endpoint="$MINIO_INTERNAL_ENDPOINT" \
    -e storage__S3Storage__region="$REGION" \
    -e storage__S3Storage__forcePathStyle=true \
    -e storage__S3Storage__accessKeyId="$MINIO_ROOT_USER" \
    -e storage__S3Storage__secretAccessKey="$MINIO_ROOT_PASSWORD" \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    media-restore-proof-ghost:local >/dev/null
# NODE_TLS_REJECT_UNAUTHORIZED=0: this sandbox's MinIO carries a self-signed
# cert; Hetzner's own endpoint is a real CA-issued one, so production Ghost
# never sets this. Same reasoning as SSL_CERT_FILE above, for the SDK that
# writes rather than the client that reads back.

deadline=$(($(date +%s) + 90))
until docker exec "$GHOST_NAME" wget -q -O /dev/null http://127.0.0.1:2368/ 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "FAILED: Ghost did not become ready within 90s" >&2
        docker logs "$GHOST_NAME" >&2
        exit 1
    fi
    sleep 1
done

note "Owner setup, session, and a real image upload through Ghost's admin API"
COOKIES="$WORKDIR/cookies.txt"
curl -sf -c "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d '{"setup":[{"name":"Proof Admin","email":"media-proof-admin@example.test","password":"MediaProof123!","blogTitle":"Media Restore Proof"}]}' \
    "$ORIGIN/ghost/api/admin/authentication/setup/" >/dev/null

curl -sf -c "$COOKIES" -b "$COOKIES" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
    -d '{"username":"media-proof-admin@example.test","password":"MediaProof123!"}' \
    "$ORIGIN/ghost/api/admin/session/" >/dev/null

UPLOAD_RESPONSE="$(curl -sf -b "$COOKIES" -H "Origin: $ORIGIN" \
    -F "file=@${WORKDIR}/fixture.png;type=image/png" -F "purpose=image" \
    "$ORIGIN/ghost/api/admin/images/upload/")"
UPLOADED_URL="$(echo "$UPLOAD_RESPONSE" | jq -r '.images[0].url')"
[ -n "$UPLOADED_URL" ] && [ "$UPLOADED_URL" != "null" ] || {
    echo "FAILED: image upload returned no url: $UPLOAD_RESPONSE" >&2
    exit 1
}
LIVE_KEY="${UPLOADED_URL#"${MINIO_INTERNAL_ENDPOINT}/${LIVE_BUCKET}/"}"
echo "uploaded url: $UPLOADED_URL"
echo "live object key: $LIVE_KEY"

UPLOADED_SHA256="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" sha256 \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$LIVE_BUCKET" --key "$LIVE_KEY")"
if [ "$UPLOADED_SHA256" = "$FIXTURE_SHA256" ]; then
    pass "Ghost's real S3Storage adapter wrote the uploaded image's exact bytes to MinIO"
else
    fail "uploaded object's digest ($UPLOADED_SHA256) does not match the source fixture ($FIXTURE_SHA256)"
fi

run_backup() {
    # $1: live bucket  $2: --confirm-tenant-has-no-media or ""  $3: recipient
    # $4: tenant (default tenant-a)
    live_bucket="$1"; confirm_flag="$2"; recipient="$3"; tenant="${4:-tenant-a}"
    # shellcheck disable=SC2086
    MEDIA_LIVE_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_LIVE_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        MEDIA_BACKUP_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_BACKUP_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        AGE_RECIPIENT_PUBLIC_KEY="$recipient" \
        python3 "$SCRIPTS_DIR/media_backup_restore.py" backup \
        --tenant "$tenant" --live-bucket "$live_bucket" --backup-bucket "$BACKUP_BUCKET" \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" $confirm_flag
}

run_restore() {
    # $1: --identity-file value  $2: target bucket or ""  $3: tenant (default
    # tenant-a)  $4: --run-id value or "" (default: the newest generation)
    identity="$1"; target="$2"; tenant="${3:-tenant-a}"; run_id="${4:-}"
    target_flag=""
    [ -n "$target" ] && target_flag="--target-bucket $target"
    run_id_flag=""
    [ -n "$run_id" ] && run_id_flag="--run-id $run_id"
    # shellcheck disable=SC2086
    MEDIA_LIVE_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_LIVE_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        MEDIA_BACKUP_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_BACKUP_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        python3 "$SCRIPTS_DIR/media_backup_restore.py" restore \
        --tenant "$tenant" --backup-bucket "$BACKUP_BUCKET" \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" --identity-file "$identity" $target_flag $run_id_flag
}

# Every run gets its own generation prefix (media/tenant-a/generations/<run
# id>/), and backup ids are RANDOM within it -- see the module docstring.
# Re-running a backup -- every "repairing" step below does exactly that --
# gives the SAME live object a DIFFERENT generation and a DIFFERENT backup
# key each time. A `BACKUP_KEY` (or a run id) computed once at the top of
# this script would go stale the moment the first repair ran, silently
# sabotaging every sabotage after it: corrupting or deleting a key from a
# superseded generation touches nothing the CURRENT manifest points at, and
# the restore that follows "passes" for the wrong reason. Resolved fresh,
# from the NEWEST generation's manifest, immediately before each use
# instead.
resolve_run_id() {
    python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" current-run-id \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
        --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
        --bucket "$BACKUP_BUCKET" --tenant tenant-a
}

resolve_backup_key() {
    run_id="$(resolve_run_id)"
    manifest_json="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" manifest \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
        --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
        --bucket "$BACKUP_BUCKET" --tenant tenant-a --identity-file "$WORKDIR/tenant-a.identity")"
    backup_id="$(echo "$manifest_json" | jq -r --arg k "$LIVE_KEY" '.objects[$k].backup_id')"
    if [ -z "$backup_id" ] || [ "$backup_id" = "null" ]; then
        echo "FAILED: resolve_backup_key: no backup_id for $LIVE_KEY in the current manifest: $manifest_json" >&2
        exit 1
    fi
    python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" backup-object-key \
        --tenant tenant-a --run-id "$run_id" --backup-id "$backup_id"
}

note "Backing up tenant-a's media through the real CLI entry point"
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    pass "backup: exit 0, manifest + ciphertext written to the backup bucket"
else
    fail "backup: unexpected non-zero exit on a healthy backup"
fi

# The backup key is opaque and RANDOM -- unrelated to LIVE_KEY and to the
# plaintext digest, both of which leak (a filename or a content fingerprint
# readable from the bucket listing after crypto-shredding). So this proof
# cannot derive the key itself; it asks the module for its own key, the same
# way any real caller would have to.
CURRENT_RUN_ID="$(resolve_run_id)"
MANIFEST_JSON="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" manifest \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --tenant tenant-a --identity-file "$WORKDIR/tenant-a.identity")"
LIVE_KEY_SHA256="$(echo "$MANIFEST_JSON" | jq -r --arg k "$LIVE_KEY" '.objects[$k].sha256')"
LIVE_KEY_BACKUP_ID="$(echo "$MANIFEST_JSON" | jq -r --arg k "$LIVE_KEY" '.objects[$k].backup_id')"
[ -n "$LIVE_KEY_SHA256" ] && [ "$LIVE_KEY_SHA256" != "null" ] || {
    echo "FAILED: manifest did not record a sha256 for $LIVE_KEY: $MANIFEST_JSON" >&2
    exit 1
}
[ -n "$LIVE_KEY_BACKUP_ID" ] && [ "$LIVE_KEY_BACKUP_ID" != "null" ] || {
    echo "FAILED: manifest did not record a backup_id for $LIVE_KEY: $MANIFEST_JSON" >&2
    exit 1
}
BACKUP_KEY="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" backup-object-key \
    --tenant tenant-a --run-id "$CURRENT_RUN_ID" --backup-id "$LIVE_KEY_BACKUP_ID")"
echo "manifest's live-key -> backup_id mapping resolved; backup object key: $BACKUP_KEY"
if echo "$BACKUP_KEY" | grep -qF "$LIVE_KEY"; then
    fail "the backup object key contains the live key's own text -- opacity is broken"
else
    pass "the backup object key carries no trace of the live key or its path"
fi
if [ "$LIVE_KEY_BACKUP_ID" = "$LIVE_KEY_SHA256" ]; then
    fail "the backup id equals the plaintext digest -- a content fingerprint that survives crypto-shredding"
else
    pass "the backup id is not the plaintext digest -- random, not content-derived"
fi

note "RED-1: a corrupted backup object must fail the restore"
BACKUP_KEY="$(resolve_backup_key)"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" corrupt \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --key "$BACKUP_KEY"
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    fail "RED-1: restore exited 0 against a corrupted backup object -- WRONG, sabotage not detected"
else
    pass "RED-1: restore refused a corrupted backup object (control proven)"
fi
echo "-- repairing: re-running a clean backup (source is still live) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "RED-2: a missing backup object must fail the restore"
BACKUP_KEY="$(resolve_backup_key)"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" delete \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --key "$BACKUP_KEY"
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    fail "RED-2: restore exited 0 against a missing backup object -- WRONG, sabotage not detected"
else
    pass "RED-2: restore refused a missing backup object (control proven)"
fi
echo "-- repairing: re-running a clean backup (source is still live) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "RED-3: a backup that captures zero objects must refuse BY DEFAULT -- no opt-in required to be safe"
if run_backup "$LIVE_EMPTY_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    fail "RED-3: backup exited 0 against an empty live bucket with NO flag -- WRONG, the floor must be on by default"
else
    pass "RED-3: backup refused a zero-object result with no flag (control proven -- the floor defaults on, like dump_tenant.py's)"
fi
echo "-- CONFIRM-EMPTY-GUARD: the explicit opt-out must itself be refused against a tenant that already has a POPULATED previous generation --"
TENANT_A_GEN_COUNT_BEFORE_GUARD="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "media/tenant-a/generations/")"
if run_backup "$LIVE_EMPTY_BUCKET" "--confirm-tenant-has-no-media" "$TENANT_A_RECIPIENT"; then
    fail "CONFIRM-EMPTY-GUARD: backup succeeded with --confirm-tenant-has-no-media against tenant-a, which already has a populated previous generation -- WRONG, this must be refused"
else
    pass "CONFIRM-EMPTY-GUARD: --confirm-tenant-has-no-media was correctly refused against tenant-a's populated previous generation"
fi
TENANT_A_GEN_COUNT_AFTER_GUARD="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "media/tenant-a/generations/")"
if [ "$TENANT_A_GEN_COUNT_AFTER_GUARD" = "$TENANT_A_GEN_COUNT_BEFORE_GUARD" ]; then
    pass "CONFIRM-EMPTY-GUARD: tenant-a's existing generation was left completely untouched by the refused run"
else
    fail "CONFIRM-EMPTY-GUARD: tenant-a's generation content changed even though the run was refused ($TENANT_A_GEN_COUNT_BEFORE_GUARD -> $TENANT_A_GEN_COUNT_AFTER_GUARD)"
fi
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "CONFIRM-EMPTY-GUARD: tenant-a's real backup still restores correctly after the refused confirm-empty attempt"
else
    fail "CONFIRM-EMPTY-GUARD: tenant-a's restore broke after the refused confirm-empty attempt"
fi
echo "-- the explicit opt-out DOES work for its real purpose: a brand-new tenant with NO previous generation at all --"
if run_backup "$LIVE_EMPTY_BUCKET" "--confirm-tenant-has-no-media" "$TENANT_C_RECIPIENT" "tenant-c"; then
    pass "backup succeeded for a genuinely new, empty tenant, only because the explicit flag was passed"
else
    fail "backup failed even with --confirm-tenant-has-no-media on a brand-new empty tenant -- the opt-out should have worked"
fi
echo "-- and restoring that deliberately-empty backup is a legitimate success, not a failure --"
if run_restore "$WORKDIR/tenant-c.identity" "" "tenant-c"; then
    pass "restore of a manifest explicitly marked deliberately_empty succeeds with zero objects, as intended"
else
    fail "restore refused a manifest that WAS explicitly marked deliberately_empty -- the opt-out should be honoured on the way back too"
fi

note "RED-4: sabotage the CLI's own wiring -- disconnect its exit code from the verification it ran"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig"
sed -i.bak 's/^        return 1$/        return 0/' "$SCRIPTS_DIR/media_backup_restore.py"
if ! diff -q "$WORKDIR/media_backup_restore.py.orig" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "wiring sabotage applied: the failure branch now returns 0"
else
    echo "FAILED: the sed sabotage did not change the file -- cannot prove the wiring test" >&2
    exit 1
fi
BACKUP_KEY="$(resolve_backup_key)"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" corrupt \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --key "$BACKUP_KEY"
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "RED-4: with the exit-code wiring disconnected, the same corruption now exits 0 (proves the earlier PASS depended on real wiring, not luck)"
else
    fail "RED-4: sabotaged CLI still exited non-zero -- the exit code is not what RED-1 actually depended on"
fi
echo "-- reverting the wiring sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig" "$SCRIPTS_DIR/media_backup_restore.py"
rm -f "$SCRIPTS_DIR/media_backup_restore.py.bak"
if diff -q "$WORKDIR/media_backup_restore.py.orig" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "wiring sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
echo "-- repairing: re-running a clean backup (source is still live) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "GREEN restored: with real wiring back, restore succeeds again on a clean backup"
else
    fail "restore failed on a clean backup after reverting the wiring sabotage -- something else broke"
fi

note "RED-5: a second age recipient in a ciphertext's header must be refused"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig-red5"
sed -i.bak "s/argv = \[\"age\", \"-r\", recipient\]/argv = [\"age\", \"-r\", recipient, \"-r\", \"$TENANT_B_RECIPIENT\"]/" \
    "$SCRIPTS_DIR/media_backup_restore.py"
if ! diff -q "$WORKDIR/media_backup_restore.py.orig-red5" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "second-recipient sabotage applied: encrypt_with_age's argv now carries two -r flags"
else
    echo "FAILED: the sed sabotage did not change the file -- cannot prove this control" >&2
    exit 1
fi
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    fail "RED-5: backup exited 0 while encrypting to two age recipients -- WRONG, the recipient-count guard did not catch it"
else
    pass "RED-5: backup refused a ciphertext carrying a second age recipient stanza (control proven)"
fi
echo "-- reverting the second-recipient sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig-red5" "$SCRIPTS_DIR/media_backup_restore.py"
rm -f "$SCRIPTS_DIR/media_backup_restore.py.bak"
if diff -q "$WORKDIR/media_backup_restore.py.orig-red5" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "second-recipient sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
echo "-- repairing: re-running a clean backup (source is still live) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "RED-6: a content-derived backup id (the plaintext digest) must not appear in the listing"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig-red6"
sed -i.bak \
    -e "s/    del digest$/    pass  # SABOTAGE: digest kept rather than discarded/" \
    -e "s/    return secrets.token_hex(32)$/    return digest  # SABOTAGE: content-derived id, not random/" \
    "$SCRIPTS_DIR/media_backup_restore.py"
if ! diff -q "$WORKDIR/media_backup_restore.py.orig-red6" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "digest-derived-id sabotage applied: generate_backup_object_id now returns the plaintext digest"
else
    echo "FAILED: the sed sabotage did not change the file -- cannot prove this control" >&2
    exit 1
fi
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null
SABOTAGED_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" --bucket "$BACKUP_BUCKET")"
if echo "$SABOTAGED_LISTING" | grep -qF "$LIVE_KEY_SHA256"; then
    pass "RED-6: with the sabotage applied, the backup bucket's listing now contains the plaintext digest -- readable to anyone with list access after crypto-shredding (control proven)"
else
    fail "RED-6: sabotaged backup did NOT leak the plaintext digest into the listing -- unexpected"
fi
echo "-- reverting the digest-derived-id sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig-red6" "$SCRIPTS_DIR/media_backup_restore.py"
rm -f "$SCRIPTS_DIR/media_backup_restore.py.bak"
if diff -q "$WORKDIR/media_backup_restore.py.orig-red6" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "digest-derived-id sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
# The sabotaged run's object -- keyed by the digest itself -- is now
# orphaned by a fresh backup (a new random id), not overwritten: reverting
# the CODE does not un-leak an object a prior, sabotaged run already wrote.
# That is real and worth being honest about rather than papering over, so
# this cleans it up explicitly rather than letting a stale "clean" listing
# check quietly stop meaning what it says.
RED6_SABOTAGED_RUN_ID="$(resolve_run_id)"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" delete \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" \
    --key "$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" backup-object-key --tenant tenant-a --run-id "$RED6_SABOTAGED_RUN_ID" --backup-id "$LIVE_KEY_SHA256")"
echo "-- repairing: re-running a clean backup (source is still live) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null
REPAIRED_BACKUP_ID="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" manifest \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --tenant tenant-a --identity-file "$WORKDIR/tenant-a.identity" \
    | jq -r --arg k "$LIVE_KEY" '.objects[$k].backup_id')"
if [ "$REPAIRED_BACKUP_ID" = "$LIVE_KEY_SHA256" ]; then
    fail "RED-6 revert: the repaired backup's own backup_id is STILL the plaintext digest"
else
    pass "RED-6 reverted: the repaired backup's id is random again, not the plaintext digest"
fi
REPAIRED_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" --bucket "$BACKUP_BUCKET")"
if echo "$REPAIRED_LISTING" | grep -qF "$LIVE_KEY_SHA256"; then
    fail "RED-6 revert: the plaintext digest is STILL in the listing after cleaning up the orphan"
else
    pass "RED-6 reverted: the backup bucket's listing no longer contains the plaintext digest"
fi

note "C-REFRESH-1: a second backup run deletes the first run's objects, and restore still verifies"
# The whole tenant's generations/ prefix, across every run -- not one run's
# own objects/ subdirectory -- since a "did storage grow" question is about
# the tenant's total footprint, and each run now lives under its own
# generation prefix rather than sharing one.
TENANT_GENERATIONS_PREFIX="media/tenant-a/generations/"
FIRST_GEN_KEY="$(resolve_backup_key)"
FIRST_GEN_COUNT="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX")"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null
SECOND_GEN_KEY="$(resolve_backup_key)"
SECOND_GEN_COUNT="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX")"
if [ "$FIRST_GEN_KEY" = "$SECOND_GEN_KEY" ]; then
    fail "C-REFRESH-1: the second run reused the first run's backup key -- ids are supposed to be fresh and random every run"
else
    pass "C-REFRESH-1: the second run used a fresh random backup key ($SECOND_GEN_KEY != $FIRST_GEN_KEY)"
fi
SECOND_GEN_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX")"
if echo "$SECOND_GEN_LISTING" | grep -qF "$FIRST_GEN_KEY"; then
    fail "C-REFRESH-1: the first generation's ciphertext is STILL in the backup bucket after a second run"
else
    pass "C-REFRESH-1: the first generation's ciphertext is genuinely gone from the backup bucket, not merely unreferenced"
fi
if [ "$SECOND_GEN_COUNT" = "$FIRST_GEN_COUNT" ]; then
    pass "C-REFRESH-1: object count under $TENANT_GENERATIONS_PREFIX did not grow across the second run ($SECOND_GEN_COUNT)"
else
    fail "C-REFRESH-1: object count under $TENANT_GENERATIONS_PREFIX changed unexpectedly ($FIRST_GEN_COUNT -> $SECOND_GEN_COUNT)"
fi
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "C-REFRESH-1: restore still succeeds (exit 0) after a second, superseding backup run"
else
    fail "C-REFRESH-1: restore failed after a second backup run"
fi
RESTORED_AFTER_SECOND_SHA256="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" sha256 \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$LIVE_BUCKET" --key "$LIVE_KEY")"
if [ "$RESTORED_AFTER_SECOND_SHA256" = "$FIXTURE_SHA256" ]; then
    pass "C-REFRESH-1: the live object's digest after two backup runs still matches the original upload"
else
    fail "C-REFRESH-1: the live object's digest changed unexpectedly across two backup runs"
fi

note "C-REFRESH-2: an upload failure mid-run must leave the previous generation intact and restorable"
echo "-- adding a second live object so this run has something to fail partway through --"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" put \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$LIVE_BUCKET" --key "content/images/2026/09/second-live-object.txt" \
    --body "a second live object, added only for C-REFRESH-2"
LIVE_OBJECT_COUNT="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" --bucket "$LIVE_BUCKET")"
echo "-- repairing: one clean backup run so this generation covers every live object ($LIVE_OBJECT_COUNT of them -- Ghost's own upload pipeline writes more than the one this proof uploaded) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null
PRE_SABOTAGE_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX" | sort)"

cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig-crefresh2"
python3 - "$SCRIPTS_DIR/media_backup_restore.py" <<'PYEOF'
import sys
path = sys.argv[1]
text = open(path).read()
marker = "        backup_key = _object_key_for_backup(tenant, run_id, backup_id)\n        put_object(\n"
assert marker in text, "expected marker not found -- has the loop shape changed?"
sabotaged = text.replace(
    marker,
    "        backup_key = _object_key_for_backup(tenant, run_id, backup_id)\n"
    "        _SABOTAGE_UPLOAD_COUNT[0] += 1\n"
    "        if _SABOTAGE_UPLOAD_COUNT[0] == 2:\n"
    "            raise ObjectStorageError('SABOTAGE: simulated upload failure mid-run')\n"
    "        put_object(\n",
    1,
)
assert sabotaged != text
sabotaged = sabotaged.replace(
    "MEDIA_PREFIX = \"media\"\n",
    "MEDIA_PREFIX = \"media\"\n_SABOTAGE_UPLOAD_COUNT = [0]\n",
    1,
)
open(path, "w").write(sabotaged)
PYEOF
if ! diff -q "$WORKDIR/media_backup_restore.py.orig-crefresh2" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "upload-failure sabotage applied: the second object's upload now raises"
else
    echo "FAILED: the sabotage patch did not change the file -- cannot prove this control" >&2
    exit 1
fi

if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    fail "C-REFRESH-2: backup exited 0 despite the sabotaged upload failure -- WRONG"
else
    pass "C-REFRESH-2: the sabotaged run's own exit code is non-zero, as expected"
fi
POST_SABOTAGE_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX" | sort)"
# Temp files, not `comm -23 <(...) <(...)`: process substitution is a
# bashism this `#!/bin/sh` script cannot rely on, and a shell that rejects
# it turns the whole check into a silent, always-empty (so always "PASS")
# no-op rather than a loud failure -- exactly the shape of bug this proof
# exists to catch elsewhere, so it must not carry one of its own.
echo "$PRE_SABOTAGE_LISTING" >"$WORKDIR/pre-sabotage-listing.txt"
echo "$POST_SABOTAGE_LISTING" >"$WORKDIR/post-sabotage-listing.txt"
MISSING_FROM_PREVIOUS_GENERATION="$(comm -23 "$WORKDIR/pre-sabotage-listing.txt" "$WORKDIR/post-sabotage-listing.txt")"
if [ -z "$MISSING_FROM_PREVIOUS_GENERATION" ]; then
    pass "C-REFRESH-2: RED: every object from the pre-sabotage generation is still present after the failed run"
else
    fail "C-REFRESH-2: RED: at least one pre-sabotage object is MISSING after the failed run -- the previous generation was not preserved ($MISSING_FROM_PREVIOUS_GENERATION)"
fi
if run_restore "$WORKDIR/tenant-a.identity" "$RESTORED_BUCKET"; then
    pass "C-REFRESH-2: RED: restore from the (untouched) previous generation still succeeds after the failed run"
else
    fail "C-REFRESH-2: RED: restore from the previous generation failed after the sabotaged run -- the old generation was not left restorable"
fi
echo "-- reverting the upload-failure sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig-crefresh2" "$SCRIPTS_DIR/media_backup_restore.py"
if diff -q "$WORKDIR/media_backup_restore.py.orig-crefresh2" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "upload-failure sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
echo "-- repairing: re-running a clean backup (both live objects) --"
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    pass "C-REFRESH-2: GREEN: with the sabotage reverted, a clean backup run succeeds again"
else
    fail "C-REFRESH-2: GREEN: a clean backup run failed after reverting the sabotage"
fi
# This run's own objects/ subdirectory specifically -- not the whole
# tenant-wide generations/ prefix -- so this is an exact count again (one
# object per live object, no manifest key mixed in).
POST_REPAIR_RUN_ID="$(resolve_run_id)"
POST_REPAIR_OBJECTS_PREFIX="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" objects-prefix \
    --tenant tenant-a --run-id "$POST_REPAIR_RUN_ID")"
POST_REPAIR_LISTING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$POST_REPAIR_OBJECTS_PREFIX")"
POST_REPAIR_COUNT="$(echo "$POST_REPAIR_LISTING" | grep -c .)"
if [ "$POST_REPAIR_COUNT" = "$LIVE_OBJECT_COUNT" ]; then
    pass "C-REFRESH-2: GREEN: the repaired generation covers exactly the $LIVE_OBJECT_COUNT live objects, and the sabotaged run's own partial orphan is gone too"
else
    fail "C-REFRESH-2: GREEN: expected exactly $LIVE_OBJECT_COUNT objects after repair (one per live object), found $POST_REPAIR_COUNT"
fi
echo "-- cleaning up the extra live object added for this round --"
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" delete \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$LIVE_BUCKET" --key "content/images/2026/09/second-live-object.txt"
echo "-- repairing: one more clean backup so later rounds see tenant-a's original single-object generation --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "CONCURRENT-1: two REAL, overlapping CLI backup runs against the same tenant must never leave it unrestorable"
# Genuinely parallel OS processes, not a simulated interleaving -- both
# start against the SAME live Ghost-uploaded media and the SAME real
# MinIO-backed backup bucket, launched with no ordering between them.
# Whichever process's own manifest ends up newest (by generation id, not by
# which process happened to start first) is the tenant's current, fully
# restorable generation; the other either already finished earlier and was
# safely superseded, or lost the race and exited non-zero having deleted
# nothing -- see media_backup_restore.py's own docstring for why every
# interleaving lands one of those two ways, and test_media_backup_restore.py's
# ConcurrentRunSafetyTests for the same property proven deterministically.
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >"$WORKDIR/concurrent-a.log" 2>&1 &
CONCURRENT_PID_A=$!
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >"$WORKDIR/concurrent-b.log" 2>&1 &
CONCURRENT_PID_B=$!
CONCURRENT_RC_A=0
CONCURRENT_RC_B=0
wait "$CONCURRENT_PID_A" || CONCURRENT_RC_A=$?
wait "$CONCURRENT_PID_B" || CONCURRENT_RC_B=$?
echo "concurrent run A exit=$CONCURRENT_RC_A, run B exit=$CONCURRENT_RC_B"
if [ "$CONCURRENT_RC_A" -eq 0 ] || [ "$CONCURRENT_RC_B" -eq 0 ]; then
    pass "CONCURRENT-1: at least one of the two overlapping runs completed successfully"
else
    fail "CONCURRENT-1: BOTH overlapping runs failed -- see $WORKDIR/concurrent-a.log and $WORKDIR/concurrent-b.log"
fi
if run_restore "$WORKDIR/tenant-a.identity" "$RESTORED_BUCKET"; then
    pass "CONCURRENT-1: restore succeeds after two real overlapping backup runs -- nothing was left unrestorable"
else
    fail "CONCURRENT-1: restore FAILED after two overlapping runs -- the concurrency fix is not actually working"
fi
CONCURRENT_RESTORED_SHA256="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" sha256 \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$RESTORED_BUCKET" --key "$LIVE_KEY")"
if [ "$CONCURRENT_RESTORED_SHA256" = "$FIXTURE_SHA256" ]; then
    pass "CONCURRENT-1: the digest recovered after two overlapping runs still matches the original upload"
else
    fail "CONCURRENT-1: the digest recovered after two overlapping runs does NOT match the original upload"
fi
echo "-- repairing: one clean backup so later rounds see a single, unambiguous generation --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "LOSSY-PUT: an object PUT that answers success without landing must be caught before any delete"
PRE_LOSSY_TENANT_COUNT="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX")"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig-lossyput"
python3 - "$SCRIPTS_DIR/media_backup_restore.py" <<'PYEOF'
import sys
path = sys.argv[1]
text = open(path).read()
marker = "    _assert_valid_tenant_slug(tenant, MediaBackupError)\n\n    live_objects = list_objects("
assert marker in text, "expected marker not found -- has the function's own opening shape changed?"
sabotaged = text.replace(
    marker,
    "    _assert_valid_tenant_slug(tenant, MediaBackupError)\n\n"
    "    _SABOTAGE_PUT_COUNT = [0]\n"
    "    _SABOTAGE_REAL_PUT_OBJECT = put_object\n"
    "    def put_object(**kw):  # noqa: F811 -- SABOTAGE: local shadow, object puts only\n"
    "        _SABOTAGE_PUT_COUNT[0] += 1\n"
    "        if _SABOTAGE_PUT_COUNT[0] == 2 and '/objects/' in kw.get('key', ''):\n"
    "            return  # SABOTAGE: 2xx in spirit -- no exception -- but never actually stored\n"
    "        return _SABOTAGE_REAL_PUT_OBJECT(**kw)\n\n"
    "    live_objects = list_objects(",
    1,
)
assert sabotaged != text
open(path, "w").write(sabotaged)
PYEOF
if ! diff -q "$WORKDIR/media_backup_restore.py.orig-lossyput" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "lossy-put sabotage applied: the second object's PUT now silently drops its ciphertext"
else
    echo "FAILED: the sabotage patch did not change the file -- cannot prove this control" >&2
    exit 1
fi
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    fail "LOSSY-PUT: backup exited 0 despite a silently dropped object PUT -- WRONG"
else
    pass "LOSSY-PUT: the sabotaged run's own exit code is non-zero, as expected"
fi
POST_LOSSY_TENANT_COUNT="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --prefix "$TENANT_GENERATIONS_PREFIX")"
if [ "$POST_LOSSY_TENANT_COUNT" -ge "$PRE_LOSSY_TENANT_COUNT" ]; then
    pass "LOSSY-PUT: nothing was deleted -- the tenant's total object/manifest count did not shrink ($PRE_LOSSY_TENANT_COUNT -> $POST_LOSSY_TENANT_COUNT)"
else
    fail "LOSSY-PUT: the tenant's total object/manifest count SHRANK ($PRE_LOSSY_TENANT_COUNT -> $POST_LOSSY_TENANT_COUNT) -- something was deleted despite the missing object"
fi
# The sabotaged run's own presence check -- run BEFORE its manifest is ever
# written -- caught the missing object and raised without writing one. So
# the tenant's newest generation with a manifest is still the PREVIOUS
# (good) one, untouched by this run: a default restore must SUCCEED here,
# reading that previous generation, with no --run-id needed. A manifest
# existing means the generation it names is complete -- see
# media_backup_restore.py's own docstring.
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "LOSSY-PUT: restore succeeds by default -- the lossy run never wrote a manifest, so the previous (good) generation is still the newest one"
else
    fail "LOSSY-PUT: restore FAILED -- WRONG, the previous generation should still be the newest, unbroken one"
fi
echo "-- reverting the lossy-put sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig-lossyput" "$SCRIPTS_DIR/media_backup_restore.py"
if diff -q "$WORKDIR/media_backup_restore.py.orig-lossyput" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "lossy-put sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
echo "-- repairing: a clean run supersedes the broken generation --"
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    pass "LOSSY-PUT: GREEN: with the sabotage reverted, a clean backup run succeeds again"
else
    fail "LOSSY-PUT: GREEN: a clean backup run failed after reverting the sabotage"
fi
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "LOSSY-PUT: GREEN: restore succeeds again once a clean run supersedes the broken one"
else
    fail "LOSSY-PUT: GREEN: restore still fails after a clean run -- the broken generation was not actually superseded"
fi

note "MANIFEST-MISMATCH: a manifest PUT that reports success but stores different bytes must never be silently trusted"
GOOD_RUN_ID_BEFORE_MISMATCH="$(resolve_run_id)"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig-mismatch"
python3 - "$SCRIPTS_DIR/media_backup_restore.py" <<'PYEOF'
import sys
path = sys.argv[1]
text = open(path).read()
marker = "    _assert_valid_tenant_slug(tenant, MediaBackupError)\n\n    live_objects = list_objects("
assert marker in text, "expected marker not found -- has the function's own opening shape changed?"
sabotaged = text.replace(
    marker,
    "    _assert_valid_tenant_slug(tenant, MediaBackupError)\n\n"
    "    _SABOTAGE_REAL_PUT_OBJECT = put_object\n"
    "    def put_object(**kw):  # noqa: F811 -- SABOTAGE: local shadow, manifest only\n"
    "        if kw.get('key', '').endswith('manifest.json.age'):\n"
    "            kw = dict(kw)\n"
    "            kw['data'] = kw['data'][:-5]  # SABOTAGE: PUT 'succeeds'; stored bytes differ\n"
    "        return _SABOTAGE_REAL_PUT_OBJECT(**kw)\n\n"
    "    live_objects = list_objects(",
    1,
)
assert sabotaged != text
open(path, "w").write(sabotaged)
PYEOF
if ! diff -q "$WORKDIR/media_backup_restore.py.orig-mismatch" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "manifest-mismatch sabotage applied: the manifest PUT now stores truncated bytes"
else
    echo "FAILED: the sabotage patch did not change the file -- cannot prove this control" >&2
    exit 1
fi
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    fail "MANIFEST-MISMATCH: backup exited 0 despite a torn manifest read-back -- WRONG"
else
    pass "MANIFEST-MISMATCH: the sabotaged run's own exit code is non-zero, as expected"
fi
echo "-- reverting the manifest-mismatch sabotage --"
cp "$WORKDIR/media_backup_restore.py.orig-mismatch" "$SCRIPTS_DIR/media_backup_restore.py"
if diff -q "$WORKDIR/media_backup_restore.py.orig-mismatch" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "manifest-mismatch sabotage reverted: file matches the pre-sabotage original"
else
    echo "FAILED: revert did not restore the original file" >&2
    exit 1
fi
# Unlike LOSSY-PUT, the torn manifest key itself DOES now exist -- the PUT
# reported success -- so this run IS the tenant's newest generation with a
# manifest present. A default restore must refuse it rather than invent a
# fallback on its own.
DEFAULT_RESTORE_OUTPUT="$(run_restore "$WORKDIR/tenant-a.identity" "" 2>&1)" && DEFAULT_RESTORE_RC=0 || DEFAULT_RESTORE_RC=$?
echo "$DEFAULT_RESTORE_OUTPUT"
if [ "$DEFAULT_RESTORE_RC" -eq 0 ]; then
    fail "MANIFEST-MISMATCH: default restore succeeded against the torn newest manifest -- WRONG, this should never report success"
else
    pass "MANIFEST-MISMATCH: default restore correctly refuses the torn newest generation -- no silent false success"
fi
if echo "$DEFAULT_RESTORE_OUTPUT" | grep -q -- "--run-id $GOOD_RUN_ID_BEFORE_MISMATCH"; then
    pass "MANIFEST-MISMATCH: the refusal names the newest OLDER generation ($GOOD_RUN_ID_BEFORE_MISMATCH) and the exact --run-id command to recover it"
else
    fail "MANIFEST-MISMATCH: the refusal did NOT name the older generation's exact --run-id recovery command"
fi
if run_restore "$WORKDIR/tenant-a.identity" "" "" "$GOOD_RUN_ID_BEFORE_MISMATCH"; then
    pass "MANIFEST-MISMATCH: the named --run-id recovery actually works -- restore succeeds against the older, unbroken generation"
else
    fail "MANIFEST-MISMATCH: the named --run-id recovery FAILED -- WRONG, that generation was never touched by the sabotaged run"
fi
echo "-- repairing: a clean run supersedes the torn generation --"
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    pass "MANIFEST-MISMATCH: GREEN: with the sabotage reverted, a clean backup run succeeds again"
else
    fail "MANIFEST-MISMATCH: GREEN: a clean backup run failed after reverting the sabotage"
fi
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "MANIFEST-MISMATCH: GREEN: default restore succeeds again once a clean run supersedes the torn one"
else
    fail "MANIFEST-MISMATCH: GREEN: restore still fails after a clean run -- the torn generation was not actually superseded"
fi

note "Direct check: a different tenant's identity cannot restore tenant-a's media"
if run_restore "$WORKDIR/tenant-b.identity" ""; then
    fail "restore succeeded with tenant-b's identity against tenant-a's backup -- crypto-shredding property broken"
else
    pass "restore refused tenant-b's identity against tenant-a's backup (crypto-shredding property holds live)"
fi

note "GREEN-1: the official round -- genuine destroy, then restore, then digest match"
# Deletes EVERY object in the live bucket, not only the one key this proof
# uploaded: Ghost's own upload pipeline writes more than one object per
# image (the original plus responsive-size variants), and a "genuine
# destroy" that left any of them behind would not be genuine.
python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" list \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$LIVE_BUCKET" | while IFS= read -r key; do
    [ -n "$key" ] || continue
    python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" delete \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
        --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
        --bucket "$LIVE_BUCKET" --key "$key"
done
REMAINING="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" count \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" --bucket "$LIVE_BUCKET")"
if [ "$REMAINING" = "0" ]; then
    pass "genuine destroy: the live bucket now holds zero objects"
else
    fail "genuine destroy did not empty the live bucket (still holds $REMAINING objects)"
fi

if run_restore "$WORKDIR/tenant-a.identity" "$RESTORED_BUCKET"; then
    pass "restore (after genuine destroy): exit 0"
else
    fail "restore (after genuine destroy): unexpected non-zero exit"
fi
RESTORED_SHA256="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" sha256 \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$RESTORED_BUCKET" --key "$LIVE_KEY")"
if [ "$RESTORED_SHA256" = "$FIXTURE_SHA256" ]; then
    pass "restored object's SHA-256 ($RESTORED_SHA256) matches the original upload -- the bytes came back"
else
    fail "restored object's SHA-256 ($RESTORED_SHA256) does NOT match the original ($FIXTURE_SHA256)"
fi

note "Summary"
if [ "$FAILURES" -eq 0 ]; then
    echo "PROOF OK: media backup/restore round-trips real bytes through a real Ghost upload, a real S3-compatible store and real age encryption; a corrupted object, a missing object, a default-empty backup, a disconnected exit code, a second age recipient and a content-derived backup id are each independently caught; a genuinely empty tenant still restores successfully with the explicit flag; a different tenant's identity is independently refused; backup object keys are random, not derived from the live key or the plaintext digest; a second run supersedes the first (fresh generation, old ciphertext genuinely gone, object count steady, restore still verifies) and an upload failure mid-run leaves the previous generation untouched and restorable; two REAL overlapping CLI backup runs against the same tenant never leave it unrestorable; an object PUT that answers success without landing is caught before this run's own manifest is ever written, so a default restore afterwards still succeeds against the untouched previous generation; and a manifest PUT that reports success but stores different bytes leaves a default restore refusing rather than guessing, naming the newest older generation and the exact --run-id command that recovers it -- which this proof then runs for real."
    exit 0
else
    echo "PROOF FAILED: $FAILURES check(s) did not behave as expected -- see the FAIL lines above."
    exit 1
fi
