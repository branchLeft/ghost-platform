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
# Six rounds:
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
# unmodified code, not a plaintext-HTTP shortcut.
#
# Prerequisites on the workstation running this: docker, age (age-keygen),
# openssl, curl, jq, python3. Pulls quay.io/minio/minio and quay.io/minio/mc
# (Docker Hub's minio/minio now refuses anonymous pulls).
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
    # Belt-and-braces revert of the RED-4 and RED-5 sabotages, in case the
    # script exited before their own explicit reverts ran. A saved copy on
    # disk, not `git checkout --`: the latter depends on this file's commit
    # state, which this trap has no reason to assume anything about, while a
    # copy taken immediately before the sabotage is unconditionally correct.
    for saved in "$WORKDIR/media_backup_restore.py.orig" "$WORKDIR/media_backup_restore.py.orig-red5"; do
        [ -f "$saved" ] && cp "$saved" "$SCRIPTS_DIR/media_backup_restore.py"
    done
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$WORKDIR/certs"

note "Generating tenant-a and tenant-b age identities"
age-keygen -o "$WORKDIR/tenant-a.identity" 2>"$WORKDIR/tenant-a.pub.raw"
TENANT_A_RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORKDIR/tenant-a.pub.raw" | head -1)"
age-keygen -o "$WORKDIR/tenant-b.identity" 2>"$WORKDIR/tenant-b.pub.raw"
TENANT_B_RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$WORKDIR/tenant-b.pub.raw" | head -1)"
[ -n "$TENANT_A_RECIPIENT" ] && [ -n "$TENANT_B_RECIPIENT" ] || {
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
    live_bucket="$1"; confirm_flag="$2"; recipient="$3"
    # shellcheck disable=SC2086
    MEDIA_LIVE_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_LIVE_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        MEDIA_BACKUP_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_BACKUP_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        AGE_RECIPIENT_PUBLIC_KEY="$recipient" \
        python3 "$SCRIPTS_DIR/media_backup_restore.py" backup \
        --tenant tenant-a --live-bucket "$live_bucket" --backup-bucket "$BACKUP_BUCKET" \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" $confirm_flag
}

run_restore() {
    # $1: --identity-file value  $2: target bucket or ""
    identity="$1"; target="$2"
    target_flag=""
    [ -n "$target" ] && target_flag="--target-bucket $target"
    # shellcheck disable=SC2086
    MEDIA_LIVE_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_LIVE_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        MEDIA_BACKUP_ACCESS_KEY_ID="$MINIO_ROOT_USER" MEDIA_BACKUP_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
        python3 "$SCRIPTS_DIR/media_backup_restore.py" restore \
        --tenant tenant-a --backup-bucket "$BACKUP_BUCKET" \
        --endpoint "$MINIO_ENDPOINT" --region "$REGION" --identity-file "$identity" $target_flag
}

note "Backing up tenant-a's media through the real CLI entry point"
if run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT"; then
    pass "backup: exit 0, manifest + ciphertext written to the backup bucket"
else
    fail "backup: unexpected non-zero exit on a healthy backup"
fi

# The backup key is opaque and content-addressed (finding 2's fix), so this
# proof cannot derive it from LIVE_KEY the way it used to -- it asks the
# module for its own key, the same way any real caller would have to.
MANIFEST_JSON="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" manifest \
    --endpoint "$MINIO_ENDPOINT" --region "$REGION" \
    --access-key "$MINIO_ROOT_USER" --secret-key "$MINIO_ROOT_PASSWORD" \
    --bucket "$BACKUP_BUCKET" --tenant tenant-a --identity-file "$WORKDIR/tenant-a.identity")"
LIVE_KEY_SHA256="$(echo "$MANIFEST_JSON" | jq -r --arg k "$LIVE_KEY" '.objects[$k].sha256')"
[ -n "$LIVE_KEY_SHA256" ] && [ "$LIVE_KEY_SHA256" != "null" ] || {
    echo "FAILED: manifest did not record a sha256 for $LIVE_KEY: $MANIFEST_JSON" >&2
    exit 1
}
BACKUP_KEY="$(python3 "$SCRIPTS_DIR/media_backup_restore_proof_helpers.py" backup-object-key \
    --tenant tenant-a --sha256 "$LIVE_KEY_SHA256")"
echo "manifest's live-key -> digest mapping resolved; backup object key: $BACKUP_KEY"
if echo "$BACKUP_KEY" | grep -qF "$LIVE_KEY"; then
    fail "the backup object key contains the live key's own text -- opacity is broken"
else
    pass "the backup object key is content-addressed and carries no trace of the live key or its path"
fi

note "RED-1: a corrupted backup object must fail the restore"
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
echo "-- the explicit, loudly-named opt-out: only --confirm-tenant-has-no-media allows a genuinely empty tenant through --"
if run_backup "$LIVE_EMPTY_BUCKET" "--confirm-tenant-has-no-media" "$TENANT_A_RECIPIENT"; then
    pass "backup succeeded for a genuinely empty tenant, only because the explicit flag was passed"
else
    fail "backup failed even with --confirm-tenant-has-no-media on a genuinely empty tenant -- the opt-out should have worked"
fi
echo "-- and restoring that deliberately-empty backup is a legitimate success, not a failure --"
if run_restore "$WORKDIR/tenant-a.identity" ""; then
    pass "restore of a manifest explicitly marked deliberately_empty succeeds with zero objects, as intended"
else
    fail "restore refused a manifest that WAS explicitly marked deliberately_empty -- the opt-out should be honoured on the way back too"
fi
echo "-- repairing: re-running a clean backup of tenant-a's REAL media (the empty-tenant test above overwrote its manifest, exactly as the explicit flag permits) --"
run_backup "$LIVE_BUCKET" "" "$TENANT_A_RECIPIENT" >/dev/null

note "RED-4: sabotage the CLI's own wiring -- disconnect its exit code from the verification it ran"
cp "$SCRIPTS_DIR/media_backup_restore.py" "$WORKDIR/media_backup_restore.py.orig"
sed -i.bak 's/^        return 1$/        return 0/' "$SCRIPTS_DIR/media_backup_restore.py"
if ! diff -q "$WORKDIR/media_backup_restore.py.orig" "$SCRIPTS_DIR/media_backup_restore.py" >/dev/null; then
    echo "wiring sabotage applied: the failure branch now returns 0"
else
    echo "FAILED: the sed sabotage did not change the file -- cannot prove the wiring test" >&2
    exit 1
fi
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

note "RED-5: reproduce the reviewer's attack -- a second age recipient in a ciphertext's header must be refused"
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
    echo "PROOF OK: media backup/restore round-trips real bytes through a real Ghost upload, a real S3-compatible store and real age encryption; a corrupted object, a missing object, a default-empty backup, a disconnected exit code and a second age recipient are each independently caught; a genuinely empty tenant still restores successfully with the explicit flag; a different tenant's identity is independently refused; backup object keys are opaque and content-addressed."
    exit 0
else
    echo "PROOF FAILED: $FAILURES check(s) did not behave as expected -- see the FAIL lines above."
    exit 1
fi
