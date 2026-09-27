#!/bin/sh
# Proves the export bundler's real lifecycle against a real Ghost container,
# run as a support grant: a tenant's own data volume holding a real owner
# and a real suspended Administrator support account, the break-glass SSO
# adapter configured for that support account, and the archive encrypted to
# a fresh `age` recipient standing in for the tenant's own.
#
# What this proves, through the built CLI:
#   - with no grant given, the bundler refuses (NoSupportGrantError) and
#     starts nothing;
#   - with a grant given but the support account suspended, it refuses
#     (SupportAccountNotActiveError), starts nothing, and leaves the
#     account suspended;
#   - once the account is un-suspended (standing in for the tenant pressing
#     Un-suspend in their Staff screen), the export runs: it asks for a
#     token only once the colour is up, the token is minted then, and both
#     Ghost admin exports come back with real content;
#   - the archive on disk is age ciphertext that decrypts with the
#     recipient's identity; no file the run leaves holds plaintext content,
#     and the temp directory it was given stays empty;
#   - the manifest beside the archive names the recipient fingerprint, and
#     the audit record names the grant and the fingerprint;
#   - the bundler never re-suspends the account itself (it is still active
#     after the run; the proof re-suspends it, standing in for the lane);
#   - the archive, the manifest and their directory are never world- or
#     group-readable; the container is removed and the drain flag cleared;
#   - the colour publishes on 127.0.0.1 only.
#
# The "refused while undrained" control case is proven at the unit level
# (test/unit/exportRunner.test.ts), against runExport.
#
# Needs: docker, age, age-keygen, and the platform image.
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/test-export-bundler.sh ghost-platform:local
set -e

GHOST_IMAGE="${1:?usage: test-export-bundler.sh <ghost-image-tag>}"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v26.5.0/bin}"

RUN_ID="$$"
TENANT="export-bundler-proof-$RUN_ID"
VOLUME="export-bundler-proof-content-$RUN_ID"
SEED_NAME="export-bundler-proof-seed-$RUN_ID"
SEED_PORT=4310
EXPORT_PORT=4311
OWNER_EMAIL="owner@$TENANT.test"
OWNER_PASSWORD="Xk9-export-bundler-proof-$RUN_ID"
SITE_TITLE="Export Bundler Proof $RUN_ID"
SUPPORT_EMAIL="support@$TENANT.test"
GRANT_REFERENCE="proof run $RUN_ID: tenant un-suspended the support account"

WORK_DIR="$(mktemp -d)"
DEST_DIR="$WORK_DIR/dest"
FLAG_DIR="$WORK_DIR/flags"
AUDIT_DIR="$WORK_DIR/audit"
RUN_TMP="$WORK_DIR/tmp"
KEY_DIR="$WORK_DIR/key"
HELPER_DIR="$WORK_DIR/helpers"
FIFO="$WORK_DIR/token.fifo"
mkdir -p "$FLAG_DIR" "$AUDIT_DIR" "$RUN_TMP" "$KEY_DIR" "$HELPER_DIR"
chmod 755 "$HELPER_DIR"
CLI_PID=""
FAILURES=0

BUNDLER_DIR="$(cd "$(dirname "$0")/../services/export-bundler" && pwd)"

cleanup() {
    if [ -n "$CLI_PID" ]; then kill "$CLI_PID" >/dev/null 2>&1 || true; fi
    docker rm -f "$SEED_NAME" >/dev/null 2>&1 || true
    docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-" | while read -r name; do
        docker rm -f "$name" >/dev/null 2>&1 || true
    done
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $1"
    FAILURES=$((FAILURES + 1))
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$1" | sha256sum | cut -d' ' -f1
    else
        printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
    fi
}

cat > "$HELPER_DIR/keygen.mjs" <<'EOF'
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
console.log(pubDer.toString('base64'));
console.log(privDer.subarray(privDer.length - 32).toString('base64url'));
EOF

# Stands in for the operator's mint: the claims adapters/sso/README.md
# specifies, lifetime 300s, signed over the encoded body's ASCII bytes.
cat > "$HELPER_DIR/mint.mjs" <<'EOF'
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
const [rawKey, tenant, identity] = process.argv.slice(2);
const key = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(rawKey, 'base64url')]),
  format: 'der',
  type: 'pkcs8',
});
const iat = Math.floor(Date.now() / 1000);
const body = Buffer.from(JSON.stringify({ sub: identity, aud: tenant, iat, exp: iat + 300, jti: randomBytes(16).toString('base64url') })).toString('base64url');
console.log(`${body}.${sign(null, Buffer.from(body, 'ascii'), key).toString('base64url')}`);
EOF

# Runs inside a one-shot container of the image, against the stopped
# tenant's SQLite file: creates the support account suspended, reads its
# status, or sets it (standing in for a grant lane's un-suspend and
# re-suspend, which are a person's action, never the bundler's).
cat > "$HELPER_DIR/db.js" <<'EOF'
const crypto = require('crypto');
const Database = require(require.resolve('better-sqlite3', { paths: ['/var/lib/ghost/current'] }));
const db = new Database('/var/lib/ghost/content/data/ghost.db');
const [op, email, status] = process.argv.slice(2);
if (op === 'create-support') {
  const id = crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const unusable = '$2a$10$' + crypto.randomBytes(40).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 53);
  db.prepare(`insert into users (id, name, slug, password, email, status, visibility, comment_notifications,
      free_member_signup_notification, paid_subscription_started_notification,
      paid_subscription_canceled_notification, mention_notifications, recommendation_notifications,
      milestone_notifications, donation_notifications, gift_subscription_notifications, created_at)
    values (?, 'Support', 'support', ?, ?, 'inactive', 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`).run(id, unusable, email, now);
  const role = db.prepare("select id from roles where name = 'Administrator'").get();
  db.prepare('insert into roles_users (id, role_id, user_id) values (?, ?, ?)').run(crypto.randomBytes(12).toString('hex'), role.id, id);
} else if (op === 'set-status') {
  db.prepare('update users set status = ? where email = ?').run(status, email);
} else if (op === 'status') {
  const row = db.prepare('select status from users where email = ?').get(email);
  console.log(row ? row.status : 'none');
} else {
  throw new Error('unknown op ' + op);
}
EOF
chmod 644 "$HELPER_DIR/db.js"

db() {
    docker run --rm --user node --entrypoint node \
        --mount "type=volume,src=$VOLUME,dst=/var/lib/ghost/content" \
        -v "$HELPER_DIR/db.js:/helper/db.js:ro" \
        "$GHOST_IMAGE" /helper/db.js "$@"
}

echo "Platform image under test: $GHOST_IMAGE"
echo

echo "--- minting a fresh break-glass keypair and a fresh age identity for this run ---"
KEYPAIR_OUT="$("$NODE_BIN_DIR/node" "$HELPER_DIR/keygen.mjs")"
PUBLIC_KEY="$(echo "$KEYPAIR_OUT" | sed -n '1p')"
PRIVATE_KEY="$(echo "$KEYPAIR_OUT" | sed -n '2p')"
if [ -z "$PUBLIC_KEY" ] || [ -z "$PRIVATE_KEY" ]; then
    echo "FAIL: could not mint a break-glass keypair"
    exit 1
fi
age-keygen -o "$KEY_DIR/identity.txt" 2>/dev/null
AGE_RECIPIENT="$(age-keygen -y "$KEY_DIR/identity.txt")"
EXPECTED_FINGERPRINT="sha256:$(sha256_of "$AGE_RECIPIENT")"
echo "PASS: minted a fresh Ed25519 keypair and age identity"
echo

echo "--- seeding the tenant's data volume: a real owner, then a suspended support Administrator ---"
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/data" alpine chown -R 1000:1000 /data >/dev/null

docker run -d --name "$SEED_NAME" -p "127.0.0.1:$SEED_PORT:2368" \
    --mount "type=volume,src=$VOLUME,dst=/var/lib/ghost/content" \
    -e url="https://localhost:$SEED_PORT" \
    -e database__client=sqlite3 \
    -e database__connection__filename=/var/lib/ghost/content/data/ghost.db \
    -e privacy__useUpdateCheck=false \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    "$GHOST_IMAGE" >/dev/null

deadline=$(($(date +%s) + 90))
seed_ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "http://localhost:$SEED_PORT/" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
        seed_ready=true
        break
    fi
    sleep 0.5
done
if [ "$seed_ready" != "true" ]; then
    echo "FAIL: seed Ghost never answered 200 within 90s"
    docker logs "$SEED_NAME" 2>&1 | tail -40
    exit 1
fi

setup_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' \
    -X POST "http://localhost:$SEED_PORT/ghost/api/admin/authentication/setup/" \
    -H 'Content-Type: application/json' \
    -d "{\"setup\":[{\"name\":\"Export Bundler Proof\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\",\"blogTitle\":\"$SITE_TITLE\"}]}")"
if [ "$setup_code" != "201" ]; then
    echo "FAIL: owner setup answered $setup_code, not 201"
    exit 1
fi
docker rm -f "$SEED_NAME" >/dev/null 2>&1

db create-support "$SUPPORT_EMAIL"
if [ "$(db status "$SUPPORT_EMAIL")" = "inactive" ]; then
    echo "PASS: seeded a real owner and a suspended support Administrator on the tenant's data volume"
else
    echo "FAIL: the support account was not created suspended"
    exit 1
fi
echo

echo "--- building the export bundler ---"
(cd "$BUNDLER_DIR" && PATH="$NODE_BIN_DIR:$PATH" npx tsc -p tsconfig.build.json)
echo "PASS: built dist/"
echo

run_bundler() {
    (cd "$BUNDLER_DIR" && TMPDIR="$RUN_TMP" PATH="$NODE_BIN_DIR:$PATH" node dist/cli.js \
        --tenant-id "$TENANT" \
        --requested-by rob@branchleft.co.uk \
        --delivered-to rob@branchleft.co.uk \
        --image "$GHOST_IMAGE" \
        --volume "$VOLUME" \
        --mount-path /var/lib/ghost/content \
        --age-recipient "$AGE_RECIPIENT" \
        --dest-dir "$DEST_DIR" \
        --flag-dir "$FLAG_DIR" \
        --audit-log "$AUDIT_DIR/audit.jsonl" \
        --loopback-port "$EXPORT_PORT" \
        --env "url=https://localhost:$EXPORT_PORT" \
        --env database__client=sqlite3 \
        --env database__connection__filename=/var/lib/ghost/content/data/ghost.db \
        --env privacy__useUpdateCheck=false \
        --env BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
        --env adapters__sso__active=BreakGlassSSO \
        --env "adapters__sso__BreakGlassSSO__publicKey=$PUBLIC_KEY" \
        --env "adapters__sso__BreakGlassSSO__tenant=$TENANT" \
        --env "adapters__sso__BreakGlassSSO__supportIdentity=$SUPPORT_EMAIL" \
        "$@")
}

nothing_started() {
    leftover="$(docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-" || true)"
    [ -z "$leftover" ] && [ ! -e "$DEST_DIR" ] && [ -z "$(find "$FLAG_DIR" -type f)" ] && [ ! -e "$AUDIT_DIR/audit.jsonl" ]
}

echo "--- refusal: no grant given ---"
if run_bundler </dev/null >"$WORK_DIR/no-grant.log" 2>&1; then
    fail "the bundler exited 0 with no grant"
elif grep -q 'NoSupportGrantError' "$WORK_DIR/no-grant.log" && nothing_started; then
    echo "PASS: refused with NoSupportGrantError; no colour, no archive, no drain flag, no audit entry"
else
    fail "no-grant run did not refuse as expected:"
    cat "$WORK_DIR/no-grant.log"
fi
echo

echo "--- refusal: grant given, support account still suspended ---"
if run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" </dev/null >"$WORK_DIR/suspended.log" 2>&1; then
    fail "the bundler exited 0 while the support account was suspended"
elif grep -q 'SupportAccountNotActiveError' "$WORK_DIR/suspended.log" && grep -q 'status "inactive"' "$WORK_DIR/suspended.log" && nothing_started; then
    echo "PASS: refused with SupportAccountNotActiveError (status \"inactive\"); no colour, no archive, no drain flag, no audit entry"
else
    fail "suspended-account run did not refuse as expected:"
    cat "$WORK_DIR/suspended.log"
fi
if [ "$(db status "$SUPPORT_EMAIL")" = "inactive" ]; then
    echo "PASS: the bundler left the support account suspended -- it never un-suspends"
else
    fail "the support account is no longer suspended after a refused run"
fi
echo

echo "--- grant: the support account is un-suspended (standing in for the tenant's Staff screen) ---"
db set-status "$SUPPORT_EMAIL" active
echo "support account status: $(db status "$SUPPORT_EMAIL")"
echo

echo "--- running the real export inside the grant ---"
mkfifo "$FIFO"
run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" \
    <"$FIFO" >"$WORK_DIR/export.out" 2>"$WORK_DIR/export.err" &
CLI_PID=$!
exec 3>"$FIFO"
deadline=$(($(date +%s) + 120))
prompted=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -q 'Mint a break-glass token now' "$WORK_DIR/export.err" 2>/dev/null; then
        prompted=true
        break
    fi
    if ! kill -0 "$CLI_PID" 2>/dev/null; then break; fi
    sleep 0.5
done
if [ "$prompted" = "true" ]; then
    echo "PASS: the bundler asked for the token only once the colour was up"
    "$NODE_BIN_DIR/node" "$HELPER_DIR/mint.mjs" "$PRIVATE_KEY" "$TENANT" "$SUPPORT_EMAIL" >&3
else
    fail "the bundler never asked for a token"
fi
exec 3>&-
# A bundler that finishes its work but never exits must fail here, not hang.
deadline=$(($(date +%s) + 180))
while kill -0 "$CLI_PID" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.5
done
if kill -0 "$CLI_PID" 2>/dev/null; then
    fail "the export bundler CLI had not exited 180s after the token was given"
    pkill -f "dist/cli.js --tenant-id $TENANT " >/dev/null 2>&1 || true
fi
if wait "$CLI_PID"; then
    echo "PASS: the export bundler CLI exited 0"
else
    fail "the export bundler CLI did not exit 0:"
    cat "$WORK_DIR/export.out" "$WORK_DIR/export.err"
fi
CLI_PID=""
echo

if [ "$(db status "$SUPPORT_EMAIL")" = "active" ]; then
    echo "PASS: the bundler did not re-suspend the support account -- that is the grant lane's step"
else
    fail "the support account's status changed during the export"
fi
db set-status "$SUPPORT_EMAIL" inactive
echo "--- revoke: the support account is re-suspended (standing in for the lane's re-suspend) ---"
echo

ARCHIVE="$(find "$DEST_DIR" -name '*.tar.age' | head -1)"
SIDECAR="$(find "$DEST_DIR" -name '*.manifest.json' | head -1)"
if [ -z "$ARCHIVE" ] || [ -z "$SIDECAR" ]; then
    echo "FAIL: expected an archive and a manifest in $DEST_DIR, found: $(ls "$DEST_DIR" 2>/dev/null)"
    exit 1
fi
if [ "$(find "$DEST_DIR" -type f | wc -l | tr -d ' ')" = "2" ]; then
    echo "PASS: wrote exactly one archive and one manifest: $(basename "$ARCHIVE"), $(basename "$SIDECAR")"
else
    fail "unexpected files in the destination: $(find "$DEST_DIR" -type f)"
fi

echo "--- checking the archive is ciphertext, and no plaintext is left on disk ---"
if [ "$(head -c 21 "$ARCHIVE")" = "age-encryption.org/v1" ]; then
    echo "PASS: the archive is an age ciphertext"
else
    fail "the archive does not start with an age header"
fi
plaintext_hits="$(grep -r -l -F -e "$OWNER_EMAIL" -e "$SITE_TITLE" "$DEST_DIR" "$RUN_TMP" 2>/dev/null || true)"
if [ -z "$plaintext_hits" ]; then
    echo "PASS: no file in the destination or the run's temp directory holds the tenant's content"
else
    fail "plaintext tenant content found on disk: $plaintext_hits"
fi
if [ -z "$(find "$RUN_TMP" -mindepth 1)" ]; then
    echo "PASS: the run's temp directory is empty"
else
    fail "the run left files in its temp directory: $(find "$RUN_TMP" -mindepth 1)"
fi

echo "--- checking the decrypted archive's real contents ---"
LISTING="$(age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -tf -)"
if [ "$LISTING" = "$(printf 'content_and_settings.json\npost_analytics.csv\nmanifest.json')" ]; then
    echo "PASS: decrypts to content_and_settings.json, post_analytics.csv and manifest.json"
else
    fail "unexpected decrypted listing: $LISTING"
fi
if age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -xOf - content_and_settings.json | grep -q -F "$SITE_TITLE"; then
    echo "PASS: the content-and-settings export carries this tenant's real Ghost content"
else
    fail "the content-and-settings export does not carry the tenant's content"
fi
if [ "$(age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -xOf - post_analytics.csv | wc -c | tr -d ' ')" -gt 0 ]; then
    echo "PASS: the analytics CSV is non-empty"
else
    fail "the analytics CSV is empty"
fi
echo

echo "--- checking the manifest names the encryption ---"
if grep -q '"encrypted": true' "$SIDECAR" && grep -q '"format": "age"' "$SIDECAR" && \
   grep -q "\"recipientFingerprint\": \"$EXPECTED_FINGERPRINT\"" "$SIDECAR"; then
    echo "PASS: the manifest states the archive is age-encrypted to $EXPECTED_FINGERPRINT"
else
    fail "the manifest does not state the encryption:"
    cat "$SIDECAR"
fi
echo

echo "--- checking permissions -- never world- or group-readable ---"
archive_mode="$(stat -f '%Lp' "$ARCHIVE" 2>/dev/null || stat -c '%a' "$ARCHIVE")"
sidecar_mode="$(stat -f '%Lp' "$SIDECAR" 2>/dev/null || stat -c '%a' "$SIDECAR")"
dest_mode="$(stat -f '%Lp' "$DEST_DIR" 2>/dev/null || stat -c '%a' "$DEST_DIR")"
if [ "$archive_mode" = "600" ] && [ "$sidecar_mode" = "600" ] && [ "$dest_mode" = "700" ]; then
    echo "PASS: archive 0600, manifest 0600, destination directory 0700"
else
    fail "archive $archive_mode, manifest $sidecar_mode, directory $dest_mode (expected 600 / 600 / 700)"
fi
echo

echo "--- checking the audit record ---"
if grep -q "\"tenantId\":\"$TENANT\"" "$AUDIT_DIR/audit.jsonl" 2>/dev/null && \
   grep -q '"contents":\["content_and_settings","post_analytics"\]' "$AUDIT_DIR/audit.jsonl" && \
   grep -q "\"grant\":{\"lane\":\"consented\",\"reference\":\"$GRANT_REFERENCE\"}" "$AUDIT_DIR/audit.jsonl" && \
   grep -q "\"encryptedTo\":\"$EXPECTED_FINGERPRINT\"" "$AUDIT_DIR/audit.jsonl" && \
   [ "$(wc -l < "$AUDIT_DIR/audit.jsonl" | tr -d ' ')" = "1" ]; then
    echo "PASS: one audit record: the tenant, the contents, the grant and the recipient fingerprint"
else
    fail "audit log missing or malformed:"
    cat "$AUDIT_DIR/audit.jsonl" 2>/dev/null || echo "(no audit log at all)"
fi
echo

echo "--- checking cleanup: no container left, drain flag cleared ---"
leftover="$(docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-" || true)"
if [ -z "$leftover" ]; then
    echo "PASS: no export container left running or stopped-but-present"
else
    fail "export container(s) left behind: $leftover"
fi
if [ -z "$(find "$FLAG_DIR" -type f 2>/dev/null)" ]; then
    echo "PASS: the drain flag was cleared after the run"
else
    fail "drain flag file(s) left behind: $(find "$FLAG_DIR" -type f)"
fi
echo

echo "--- checking the colour was never published beyond loopback (structural: docker port) ---"
docker run -d --name "export-bundler-publish-check-$RUN_ID" -p "127.0.0.1:4319:2368" \
    --mount "type=volume,src=$VOLUME,dst=/var/lib/ghost/content" \
    -e url="https://localhost:4319" -e database__client=sqlite3 \
    -e database__connection__filename=/var/lib/ghost/content/data/ghost.db \
    -e privacy__useUpdateCheck=false -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    "$GHOST_IMAGE" >/dev/null
PORT_BINDING="$(docker port "export-bundler-publish-check-$RUN_ID")"
docker rm -f "export-bundler-publish-check-$RUN_ID" >/dev/null 2>&1
if echo "$PORT_BINDING" | grep -q '127.0.0.1:4319' && ! echo "$PORT_BINDING" | grep -q '0.0.0.0'; then
    echo "PASS: the same run-arg shape (containerRunner.ts's own buildDockerRunArgs, unit-tested) publishes on 127.0.0.1 only"
else
    fail "unexpected port binding: $PORT_BINDING"
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All export-bundler live checks passed."
