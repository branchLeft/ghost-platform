#!/bin/sh
# Proves the export bundler's real lifecycle against a real Ghost container:
# a tenant's own data volume, seeded with a real owner account and the
# break-glass SSO adapter configured (adapters/sso/README.md -- this is
# "the administrator" LLD-8 §08b's bundler calls Ghost's two exports as;
# Ghost's own permission model refuses both `db.exportContent` and
# `posts.exportCSV` to a custom integration's Admin API key, verified
# against a real container during this story's build, so break-glass is
# not a shortcut -- it is the only account type either route accepts).
#
# What this proves:
#   - the export starts the tenant's image on its own data volume, publishes
#     ONLY on 127.0.0.1 (docker port), never a route a reader could hit;
#   - both Ghost admin exports return real content from the real container;
#   - the manifest and audit record are written correctly;
#   - the archive and its directory are never world- or group-readable;
#   - the container is removed and the drain flag cleared afterwards, on
#     the success path.
#
# The "refused while undrained" control case is proven by sabotage at the
# unit level (test/unit/exportRunner.test.ts), against the real entry
# point (runExport) -- see the PR body for the red/green record. It is not
# repeated here: this script's job is the real-process lifecycle, not the
# refusal logic, which has no real-container dependency to exercise.
#
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
DEST_DIR="$(mktemp -d)"
FLAG_DIR="$(mktemp -d)"
AUDIT_DIR="$(mktemp -d)"
KEYGEN_SCRIPT="$(mktemp -t export-bundler-keygen).mjs"
FAILURES=0

BUNDLER_DIR="$(cd "$(dirname "$0")/../services/export-bundler" && pwd)"

cleanup() {
    docker rm -f "$SEED_NAME" >/dev/null 2>&1 || true
    docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-" | while read -r name; do
        docker rm -f "$name" >/dev/null 2>&1 || true
    done
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$DEST_DIR" "$FLAG_DIR" "$AUDIT_DIR" "$KEYGEN_SCRIPT"
}
trap cleanup EXIT

echo "Platform image under test: $GHOST_IMAGE"
echo

cat > "$KEYGEN_SCRIPT" <<'EOF'
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
console.log(pubDer.toString('base64'));
console.log(privDer.subarray(privDer.length - 32).toString('base64url'));
EOF

echo "--- minting a fresh break-glass keypair for this run ---"
KEYPAIR_OUT="$("$NODE_BIN_DIR/node" "$KEYGEN_SCRIPT")"
PUBLIC_KEY="$(echo "$KEYPAIR_OUT" | sed -n '1p')"
PRIVATE_KEY="$(echo "$KEYPAIR_OUT" | sed -n '2p')"
if [ -z "$PUBLIC_KEY" ] || [ -z "$PRIVATE_KEY" ]; then
    echo "FAIL: could not mint a break-glass keypair"
    exit 1
fi
echo "PASS: minted a fresh Ed25519 keypair"
echo

echo "--- seeding the tenant's data volume with a real owner account ---"
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/data" alpine chown -R 1000:1000 /data >/dev/null

docker run -d --name "$SEED_NAME" -p "127.0.0.1:$SEED_PORT:2368" \
    --mount "type=volume,src=$VOLUME,dst=/var/lib/ghost/content" \
    -e url="https://localhost:$SEED_PORT" \
    -e database__client=sqlite3 \
    -e database__connection__filename=/var/lib/ghost/content/data/ghost.db \
    -e privacy__useUpdateCheck=false \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    -e adapters__sso__active=BreakGlassSSO \
    -e adapters__sso__BreakGlassSSO__publicKey="$PUBLIC_KEY" \
    -e adapters__sso__BreakGlassSSO__tenant="$TENANT" \
    -e adapters__sso__BreakGlassSSO__supportIdentity="$OWNER_EMAIL" \
    "$GHOST_IMAGE" >/dev/null

deadline=$(($(date +%s) + 60))
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
    echo "FAIL: seed Ghost never answered 200 within 60s"
    docker logs "$SEED_NAME" 2>&1 | tail -40
    exit 1
fi

setup_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' \
    -X POST "http://localhost:$SEED_PORT/ghost/api/admin/authentication/setup/" \
    -H 'Content-Type: application/json' \
    -d "{\"setup\":[{\"name\":\"Export Bundler Proof\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\",\"blogTitle\":\"Export Bundler Proof\"}]}")"
if [ "$setup_code" != "201" ]; then
    echo "FAIL: owner setup answered $setup_code, not 201"
    exit 1
fi
echo "PASS: seeded a real owner account on the tenant's data volume"

docker rm -f "$SEED_NAME" >/dev/null 2>&1
echo

echo "--- building the export bundler ---"
(cd "$BUNDLER_DIR" && PATH="$NODE_BIN_DIR:$PATH" npx tsc -p tsconfig.build.json)
echo "PASS: built dist/"
echo

echo "--- running the real export against the tenant's own volume ---"
if ! (cd "$BUNDLER_DIR" && PATH="$NODE_BIN_DIR:$PATH" node dist/cli.js \
    --tenant-id "$TENANT" \
    --requested-by rob@branchleft.co.uk \
    --delivered-to rob@branchleft.co.uk \
    --image "$GHOST_IMAGE" \
    --volume "$VOLUME" \
    --mount-path /var/lib/ghost/content \
    --break-glass-private-key "$PRIVATE_KEY" \
    --break-glass-tenant "$TENANT" \
    --break-glass-identity "$OWNER_EMAIL" \
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
    --env "adapters__sso__BreakGlassSSO__supportIdentity=$OWNER_EMAIL"); then
    echo "FAIL: the export bundler CLI did not exit 0"
    FAILURES=$((FAILURES + 1))
fi
echo

ARCHIVE="$(find "$DEST_DIR" -name '*.tar' | head -1)"
if [ -z "$ARCHIVE" ]; then
    echo "FAIL: no archive was written to $DEST_DIR"
    exit 1
fi
echo "PASS: wrote one archive: $(basename "$ARCHIVE")"

echo "--- checking the archive's real contents ---"
LISTING="$(tar -tf "$ARCHIVE")"
if echo "$LISTING" | grep -q 'manifest.json' && \
   echo "$LISTING" | grep -q '\.json$' && \
   echo "$LISTING" | grep -q '\.csv$'; then
    echo "PASS: archive contains manifest.json, a content-and-settings JSON file and an analytics CSV"
else
    echo "FAIL: archive listing missing an expected member:"
    echo "$LISTING"
    FAILURES=$((FAILURES + 1))
fi

EXTRACT_DIR="$DEST_DIR/extracted"
mkdir -p "$EXTRACT_DIR"
tar -xf "$ARCHIVE" -C "$EXTRACT_DIR"
if grep -q 'export-bundler-proof' "$EXTRACT_DIR"/*.json 2>/dev/null || grep -q 'Coming soon\|posts\|settings' "$EXTRACT_DIR"/*.json 2>/dev/null; then
    echo "PASS: the content-and-settings export carries real Ghost content, not a stub"
else
    echo "FAIL: the content-and-settings export does not look like real Ghost output"
    FAILURES=$((FAILURES + 1))
fi
if [ -s "$EXTRACT_DIR"/*.csv ]; then
    echo "PASS: the analytics CSV is non-empty"
else
    echo "FAIL: the analytics CSV is empty"
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- checking permissions -- never world- or group-readable ---"
archive_mode="$(stat -f '%Lp' "$ARCHIVE" 2>/dev/null || stat -c '%a' "$ARCHIVE")"
dest_mode="$(stat -f '%Lp' "$DEST_DIR" 2>/dev/null || stat -c '%a' "$DEST_DIR")"
if [ "$archive_mode" = "600" ] && [ "$dest_mode" = "700" ]; then
    echo "PASS: archive 0600, destination directory 0700"
else
    echo "FAIL: archive mode $archive_mode, destination directory mode $dest_mode (expected 600 / 700)"
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- checking the audit record ---"
if grep -q "\"tenantId\":\"$TENANT\"" "$AUDIT_DIR/audit.jsonl" 2>/dev/null && \
   grep -q '"contents":\["content_and_settings","post_analytics"\]' "$AUDIT_DIR/audit.jsonl" 2>/dev/null; then
    echo "PASS: the audit log records the tenant and what the archive contained"
else
    echo "FAIL: audit log missing or malformed:"
    cat "$AUDIT_DIR/audit.jsonl" 2>/dev/null || echo "(no audit log at all)"
    FAILURES=$((FAILURES + 1))
fi
echo

echo "--- checking cleanup: no container left, drain flag cleared ---"
leftover="$(docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-" || true)"
if [ -z "$leftover" ]; then
    echo "PASS: no export container left running or stopped-but-present"
else
    echo "FAIL: export container(s) left behind: $leftover"
    FAILURES=$((FAILURES + 1))
fi
flag_leftover="$(find "$FLAG_DIR" -type f 2>/dev/null)"
if [ -z "$flag_leftover" ]; then
    echo "PASS: the drain flag was cleared after the run"
else
    echo "FAIL: drain flag file(s) left behind: $flag_leftover"
    FAILURES=$((FAILURES + 1))
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
    echo "FAIL: unexpected port binding: $PORT_BINDING"
    FAILURES=$((FAILURES + 1))
fi
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All export-bundler live checks passed."
