#!/bin/sh
# Proves the export bundler's real lifecycle against a real Ghost container,
# run as a support grant: a tenant's own data volume holding a real owner
# and a real suspended Administrator support account, the break-glass SSO
# adapter configured for that support account, and the archive encrypted to
# a fresh `age` recipient standing in for the tenant's own.
#
# The tenant is described the way the platform describes one: a descriptor
# (slug, backup recipient) and a rendered stack directory (compose.yml,
# with the break-glass support identity in its environment) beside a
# secrets env file and an image env file. The bundler takes no identity,
# recipient or environment from its own flags.
#
# What this proves, through the built CLI:
#   - with no grant given, the bundler refuses (NoSupportGrantError) and
#     starts nothing;
#   - an --age-recipient that is not the descriptor's backup recipient is
#     refused (RecipientMismatchError), starting nothing;
#   - a stack whose rendered support identity is the Owner is refused
#     (NotTheSupportAccountError), starting nothing;
#   - no tenant secret appears in any process's argv while the colour runs;
#     the secret reaches the container through a 0600 env file that is
#     gone when the run ends;
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
#     the audit record names the grant, the support identity used, the
#     fingerprint and the archive's SHA-256;
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
# A synthetic secret: it must reach the container, and never any argv.
SECRET_SENTINEL="export-bundler-proof-secret-$RUN_ID-$(date +%s)"

WORK_DIR="$(mktemp -d)"
DEST_DIR="$WORK_DIR/dest"
FLAG_DIR="$WORK_DIR/flags"
AUDIT_DIR="$WORK_DIR/audit"
RUN_TMP="$WORK_DIR/tmp"
KEY_DIR="$WORK_DIR/key"
HELPER_DIR="$WORK_DIR/helpers"
FIFO="$WORK_DIR/token.fifo"
STACK_DIR="$WORK_DIR/stack"
OWNER_STACK_DIR="$WORK_DIR/stack-owner"
TENANT_ETC="$WORK_DIR/etc"
DESCRIPTOR="$WORK_DIR/descriptor.json"
mkdir -p "$FLAG_DIR" "$AUDIT_DIR" "$RUN_TMP" "$KEY_DIR" "$HELPER_DIR" "$STACK_DIR" "$OWNER_STACK_DIR" "$TENANT_ETC"
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
} else if (op === 'schedule-post') {
  // Copies a seeded published post (with its author link, which Ghost's
  // publish path loads) into a new post scheduled `email` seconds from now,
  // stored the way Ghost stores one: status scheduled, published_at in UTC.
  // The original stays published, so the exports still have content.
  const src = db.prepare("select id from posts where type = 'post' and status = 'published' order by created_at limit 1").get();
  const id = crypto.randomBytes(12).toString('hex');
  const at = new Date(Date.now() + Number(email) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('create temp table sp as select * from posts where id = ?').run(src.id);
  db.prepare("update sp set id = ?, uuid = ?, slug = ?, title = 'Scheduled during export', status = 'scheduled', published_at = ?, newsletter_id = null").run(id, crypto.randomUUID(), 'scheduled-during-export-' + id, at);
  db.prepare('insert into posts select * from sp').run();
  db.prepare('create temp table spa as select * from posts_authors where post_id = ?').run(src.id);
  db.prepare("update spa set id = ?, post_id = ?").run(crypto.randomBytes(12).toString('hex'), id);
  db.prepare('insert into posts_authors select * from spa').run();
  console.log(id);
} else if (op === 'post-status') {
  const row = db.prepare('select status from posts where id = ?').get(email);
  console.log(row ? row.status : 'none');
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
age-keygen -o "$KEY_DIR/other.txt" 2>/dev/null
OTHER_RECIPIENT="$(age-keygen -y "$KEY_DIR/other.txt")"
echo "PASS: minted a fresh Ed25519 keypair and age identity"
echo

# The shape render-core renders (compose.ts / environment.ts), cut down to
# what a SQLite proof tenant needs. The secret is a `${VAR}` reference that
# only the secrets env file fills.
write_stack() {
    cat > "$1/compose.yml" <<EOF
name: $TENANT
services:
  ghost-a:
    image: \${IMAGE}
    user: "1000:1000"
    environment:
      url: http://127.0.0.1:2368
      database__client: sqlite3
      database__connection__filename: /var/lib/ghost/content/data/ghost.db
      database__connection__password: \${GHOST_DB_PASSWORD:?set in the secrets env}
      privacy__useUpdateCheck: "false"
      logging__transports: '["stdout"]'
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: "true"
      mail__transport: SMTP
      mail__options__host: mail.proof.invalid
      mail__options__port: "587"
      mail__options__auth__user: proof
      mail__options__auth__pass: proof-mail-password
      bulkEmail__mailgun__baseUrl: https://spool.proof.invalid/v3
      bulkEmail__mailgun__apiKey: proof-bulk-key
      bulkEmail__mailgun__domain: proof.invalid
      adapters__sso__active: BreakGlassSSO
      adapters__sso__BreakGlassSSO__publicKey: $PUBLIC_KEY
      adapters__sso__BreakGlassSSO__tenant: $TENANT
      adapters__sso__BreakGlassSSO__supportIdentity: $2
    volumes:
      - $VOLUME:/var/lib/ghost/content
volumes:
  $VOLUME:
    external: true
EOF
}
write_stack "$STACK_DIR" "$SUPPORT_EMAIL"
write_stack "$OWNER_STACK_DIR" "$OWNER_EMAIL"
printf 'GHOST_DB_PASSWORD=%s\n' "$SECRET_SENTINEL" > "$TENANT_ETC/secrets.env"
printf 'IMAGE=%s\n' "$GHOST_IMAGE" > "$TENANT_ETC/image.env"
chmod 600 "$TENANT_ETC/secrets.env"
printf '{"slug":"%s","backup":{"kind":"bucket-native","encryptionRecipient":"%s"}}\n' "$TENANT" "$AGE_RECIPIENT" > "$DESCRIPTOR"
echo "PASS: rendered the tenant's stack directory, env files and descriptor"
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

RUN_STACK="$STACK_DIR"
RUN_RECIPIENT="$AGE_RECIPIENT"
run_bundler() {
    (cd "$BUNDLER_DIR" && TMPDIR="$RUN_TMP" PATH="$NODE_BIN_DIR:$PATH" node dist/cli.js \
        --descriptor "$DESCRIPTOR" \
        --stack-dir "$RUN_STACK" \
        --secrets-env "$TENANT_ETC/secrets.env" \
        --image-env "$TENANT_ETC/image.env" \
        --age-recipient "$RUN_RECIPIENT" \
        --requested-by rob@branchleft.co.uk \
        --delivered-to rob@branchleft.co.uk \
        --dest-dir "$DEST_DIR" \
        --flag-dir "$FLAG_DIR" \
        --audit-log "$AUDIT_DIR/audit.jsonl" \
        --loopback-port "$EXPORT_PORT" \
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

echo "--- refusal: an --age-recipient that is not the descriptor's backup recipient ---"
RUN_RECIPIENT="$OTHER_RECIPIENT"
if run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" </dev/null >"$WORK_DIR/recipient.log" 2>&1; then
    fail "the bundler exited 0 with another recipient"
elif grep -q 'RecipientMismatchError' "$WORK_DIR/recipient.log" && nothing_started; then
    echo "PASS: refused with RecipientMismatchError; no colour, no archive, no drain flag, no audit entry"
else
    fail "recipient-mismatch run did not refuse as expected:"
    cat "$WORK_DIR/recipient.log"
fi
RUN_RECIPIENT="$AGE_RECIPIENT"
echo

echo "--- refusal: the rendered support identity is the Owner (active, never suspended) ---"
RUN_STACK="$OWNER_STACK_DIR"
if run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" </dev/null >"$WORK_DIR/owner.log" 2>&1; then
    fail "the bundler exited 0 with the Owner as the support identity"
elif grep -q 'NotTheSupportAccountError' "$WORK_DIR/owner.log" && grep -q 'roles are \[Owner\]' "$WORK_DIR/owner.log" && nothing_started; then
    echo "PASS: refused with NotTheSupportAccountError (roles [Owner]); no colour, no archive, no drain flag, no audit entry"
else
    fail "owner-identity run did not refuse as expected:"
    cat "$WORK_DIR/owner.log"
fi
RUN_STACK="$STACK_DIR"
if [ -z "$(find "$RUN_TMP" -mindepth 1)" ]; then
    echo "PASS: the refused runs left no env file behind"
else
    fail "a refused run left files in its temp directory: $(find "$RUN_TMP" -mindepth 1)"
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

echo "--- a post scheduled for about a minute after the export colour boots ---"
# The colour boots within ~30s of the bundler starting; the post is due ~60s
# after that. The export is held (the token is not handed over) until well
# past the due time, so the colour is up across it. The stack's url is the
# colour's own in-container address, so Ghost's default scheduler, if it
# ran, would reach the colour itself when the post fell due and publish it.
# It is an IP literal: Ghost's request library refuses `localhost` as an
# invalid URL, which would silently stop the scheduler's ping and make this
# check pass for the wrong reason.
SCHEDULED_POST="$(db schedule-post 90)"
SCHEDULED_AT=$(($(date +%s) + 90))
if [ "$(db post-status "$SCHEDULED_POST")" = "scheduled" ]; then
    echo "PASS: post $SCHEDULED_POST is scheduled, due at $(date -r "$SCHEDULED_AT" -u +%H:%M:%S 2>/dev/null || date -d "@$SCHEDULED_AT" -u +%H:%M:%S)Z"
else
    fail "could not schedule a post"
fi
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
    # While the colour runs: the secret is in the container, in no argv, and
    # its only file is a 0600 env file under the run's temp directory.
    # Snapshot first: a grep in the same pipeline would carry the sentinel
    # in its own argv and match itself.
    ps -axww -o command= > "$WORK_DIR/ps.txt"
    if [ ! -s "$WORK_DIR/ps.txt" ] || ! grep -q 'dist/cli.js' "$WORK_DIR/ps.txt"; then
        fail "the process snapshot did not capture the running bundler"
    elif grep -F -q -e "$SECRET_SENTINEL" "$WORK_DIR/ps.txt"; then
        fail "the tenant secret is visible in a process's argv"
    else
        echo "PASS: no process's argv carries the tenant secret"
    fi
    colour="$(docker ps --format '{{.Names}}' | grep "^${TENANT}-export-" | head -1)"
    if [ -n "$colour" ] && docker inspect --format '{{json .Config.Env}}' "$colour" | grep -F -q -e "database__connection__password=$SECRET_SENTINEL"; then
        echo "PASS: the secret reached the export colour's environment from the tenant's own secrets file"
    else
        fail "the export colour's environment does not carry the tenant secret"
    fi
    env_files="$(find "$RUN_TMP" -type f -name tenant.env -perm 600)"
    env_dirs="$(find "$RUN_TMP" -mindepth 1 -maxdepth 1 -type d -perm 700)"
    if [ -n "$env_files" ] && [ -n "$env_dirs" ]; then
        echo "PASS: the env file is 0600 inside a 0700 directory while the run is live"
    else
        fail "no 0600 env file in a 0700 directory under the run's temp directory"
    fi

    # What Ghost itself resolved inside the running colour, read through
    # Ghost's own config module, and whether the bulk-email sink answers.
    started="$(docker inspect --format '{{.State.StartedAt}}' "$colour")"
    echo "export colour started at $started; post due at $(date -r "$SCHEDULED_AT" -u +%H:%M:%S 2>/dev/null || date -d "@$SCHEDULED_AT" -u +%H:%M:%S)Z"
    docker exec "$colour" node -e "
process.chdir('/var/lib/ghost');
const c = require('/var/lib/ghost/current/core/shared/config');
const out = {
  transport: c.get('mail:transport'),
  mailHost: (c.get('mail:options') || {}).host || null,
  bulkBaseUrl: c.get('bulkEmail:mailgun:baseUrl'),
  scheduling: c.get('adapters:scheduling:active'),
  emailAnalyticsJob: c.get('backgroundJobs:emailAnalytics'),
  stripeWebhookLocal: Boolean(process.env.WEBHOOK_SECRET),
};
const sink = new URL(out.bulkBaseUrl);
const s = require('net').connect(Number(sink.port), sink.hostname);
const done = (v) => { out.bulkSink = v; console.log(JSON.stringify(out)); process.exit(0); };
s.on('connect', () => done('open'));
s.on('error', (e) => done(e.code));
" > "$WORK_DIR/colour-config.json" 2>&1 || true
    echo "export colour's own config: $(cat "$WORK_DIR/colour-config.json")"
    if grep -q '"transport":"stub"' "$WORK_DIR/colour-config.json" && \
       grep -q '"mailHost":null' "$WORK_DIR/colour-config.json" && \
       grep -q '"bulkBaseUrl":"http://127.0.0.1:9/v3"' "$WORK_DIR/colour-config.json" && \
       grep -q '"bulkSink":"ECONNREFUSED"' "$WORK_DIR/colour-config.json"; then
        echo "PASS: no mail transport is reachable: Ghost's stub transport, no SMTP host, bulk email at a refused sink"
    else
        fail "the export colour can reach a mail transport"
    fi
    if docker inspect --format '{{json .Config.Env}}' "$colour" | grep -F -q -e 'mail.proof.invalid' -e 'spool.proof.invalid' -e 'proof-mail-password' -e 'proof-bulk-key'; then
        fail "the tenant's own mail settings reached the export colour"
    else
        echo "PASS: none of the tenant's mail or bulk-email settings reached the export colour"
    fi
    if grep -q '"scheduling":"SchedulingDisabled"' "$WORK_DIR/colour-config.json" && \
       grep -q '"emailAnalyticsJob":false' "$WORK_DIR/colour-config.json" && \
       grep -q '"stripeWebhookLocal":true' "$WORK_DIR/colour-config.json"; then
        echo "PASS: scheduler disabled, email-analytics job off, Stripe webhook manager in local mode"
    else
        fail "the export colour's scheduler, jobs or Stripe webhook settings are not isolated"
    fi

    # Hold the export until the post has been due for 45s.
    while [ "$(date +%s)" -lt $((SCHEDULED_AT + 45)) ]; do sleep 1; done
    echo "the post has been due for 45s; handing over the token"
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

post_status="$(db post-status "$SCHEDULED_POST")"
if [ "$post_status" = "scheduled" ] && [ "$(date +%s)" -gt $((SCHEDULED_AT + 45)) ]; then
    echo "PASS: the post due during the export is still scheduled after it -- the export colour published nothing"
else
    fail "the post due during the export is now \"$post_status\": the export colour's scheduler ran"
fi

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
if command -v sha256sum >/dev/null 2>&1; then
    ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
else
    ARCHIVE_SHA256="$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
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
    echo "PASS: the run's temp directory is empty -- the env file is gone"
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
   grep -q "\"supportIdentity\":\"$SUPPORT_EMAIL\"" "$AUDIT_DIR/audit.jsonl" && \
   grep -q "\"encryptedTo\":\"$EXPECTED_FINGERPRINT\"" "$AUDIT_DIR/audit.jsonl" && \
   grep -q "\"archiveSha256\":\"$ARCHIVE_SHA256\"" "$AUDIT_DIR/audit.jsonl" && \
   [ "$(wc -l < "$AUDIT_DIR/audit.jsonl" | tr -d ' ')" = "1" ]; then
    echo "PASS: one audit record: the tenant, the contents, the grant, the support identity used, the recipient fingerprint and the archive's SHA-256"
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
