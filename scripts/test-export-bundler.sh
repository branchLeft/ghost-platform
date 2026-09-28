#!/bin/sh
# Proves the export bundler's real lifecycle against real containers, on the
# MySQL tier: a real Ghost database, seeded by a real Ghost, owned by the
# platform's own descriptor/stack shape rather than the bundler's flags.
# See test-export-bundler.md#what-this-proves. The "refused while undrained"
# control case is proven at the unit level instead (test/unit/exportRunner.test.ts).
#
# Needs: docker, age, age-keygen, and the platform image.
# Usage:
#   docker build -t ghost-platform:local .
#   ./scripts/test-export-bundler.sh ghost-platform:local
set -e

GHOST_IMAGE="${1:?usage: test-export-bundler.sh <ghost-image-tag>}"
NODE_BIN_DIR="${NODE_BIN_DIR:-$HOME/.nvm/versions/node/v26.5.0/bin}"
# db/RUNBOOK-db.md's pin for db1's server.
MYSQL_IMAGE="mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b"

RUN_ID="$$"
TENANT="export-bundler-proof-$RUN_ID"
VOLUME="export-bundler-proof-content-$RUN_ID"
LIVE_DB="export-bundler-proof-livedb-$RUN_ID"
SEED_NAME="export-bundler-proof-seed-$RUN_ID"
SEED_PORT=4310
EXPORT_PORT=4311
OWNER_EMAIL="owner@$TENANT.test"
OWNER_PASSWORD="Xk9-export-bundler-proof-$RUN_ID"
SITE_TITLE="Export Bundler Proof $RUN_ID"
SUPPORT_EMAIL="support@$TENANT.test"
GRANT_REFERENCE="proof run $RUN_ID: tenant un-suspended the support account"
DB_NAME="ghost_proof"
# The live database's password: a synthetic secret that must reach the
# snapshot, and never any argv or the export colour.
SECRET_SENTINEL="proof-live-db-secret-$RUN_ID-$(date +%s)"
LIVE_ROOT_PASSWORD="proof-live-root-$RUN_ID-$(date +%s)"

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
CLI_PID=""
FAILURES=0

BUNDLER_DIR="$(cd "$(dirname "$0")/../services/export-bundler" && pwd)"

# Everything the bundler names for a run starts "<tenant>-export-".
run_leftovers() {
    {
        docker ps -a --format 'container {{.Names}}' | grep " ${TENANT}-export-" || true
        docker network ls --format 'network {{.Name}}' | grep " ${TENANT}-export-" || true
        docker volume ls --format 'volume {{.Name}}' | grep " ${TENANT}-export-" || true
    }
}

cleanup() {
    if [ -n "$CLI_PID" ]; then kill "$CLI_PID" >/dev/null 2>&1 || true; fi
    pkill -f "dist/cli.js --descriptor $DESCRIPTOR" >/dev/null 2>&1 || true
    docker rm -f "$SEED_NAME" >/dev/null 2>&1 || true
    run_leftovers | while read -r kind name; do
        case "$kind" in
            container) docker rm -fv "$name" >/dev/null 2>&1 || true ;;
        esac
    done
    run_leftovers | while read -r kind name; do
        case "$kind" in
            network) docker network rm "$name" >/dev/null 2>&1 || true ;;
            volume) docker volume rm -f "$name" >/dev/null 2>&1 || true ;;
        esac
    done
    docker rm -fv "$LIVE_DB" >/dev/null 2>&1 || true
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

hexid() {
    od -An -tx1 -N12 /dev/urandom | tr -d ' \n'
}

# SQL on stdin against the LIVE tenant database, as its server's root.
live_sql() {
    docker exec -i "$LIVE_DB" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B '"$DB_NAME"
}

scratch_container() {
    docker ps --format '{{.Names}}' | grep "^${TENANT}-export-.*-db\$" | head -1
}

# SQL on stdin against the run's scratch copy, while it exists.
scratch_sql() {
    docker exec -i "$(scratch_container)" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B '"$DB_NAME"
}

# The rows Ghost's boot-time automation poll and newsletter resume act on,
# plus the post the scheduler would publish.
STATE_SQL="SELECT 'run', id, step_attempts, IFNULL(step_started_at,'-'), IFNULL(exit_reason,'-'), IFNULL(next_welcome_email_automated_email_id,'-') FROM welcome_email_automation_runs ORDER BY id;
SELECT 'recipients', COUNT(*) FROM automated_email_recipients;
SELECT 'email', id, status, IFNULL(error,'-'), IFNULL(updated_at,'-') FROM emails ORDER BY id;
SELECT 'batch', id, status, updated_at FROM email_batches ORDER BY id;
SELECT 'post', id, status FROM posts WHERE slug LIKE 'scheduled-during-export-%' ORDER BY id;"

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

echo "--- the live database: MySQL 8.0 (db1's pinned image), TLS required, one tenant schema and account ---"
docker run -d --name "$LIVE_DB" -e MYSQL_ROOT_PASSWORD="$LIVE_ROOT_PASSWORD" "$MYSQL_IMAGE" \
    --require-secure-transport=ON >/dev/null
deadline=$(($(date +%s) + 180))
until docker exec "$LIVE_DB" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=TCP -h127.0.0.1 -uroot -N -e "SELECT 1"' >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "FAIL: the live MySQL never came up"; exit 1; fi
    sleep 2
done
# The tenant account as db/provision/provision_tenant_db.py grants it.
printf "CREATE DATABASE %s; CREATE USER '%s'@'%%' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON %s.* TO '%s'@'%%';\n" \
    "$DB_NAME" "$DB_NAME" "$SECRET_SENTINEL" "$DB_NAME" "$DB_NAME" |
    docker exec -i "$LIVE_DB" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot'
LIVE_IP="$(docker inspect -f '{{.NetworkSettings.IPAddress}}' "$LIVE_DB")"
echo "PASS: live MySQL up at $LIVE_IP, tenant schema $DB_NAME"
echo

# The shape render-core renders (compose.ts / environment.ts), cut down to
# what a MySQL proof tenant needs. The database password is a `${VAR}`
# reference only the secrets env file fills.
write_stack() {
    cat > "$1/compose.yml" <<EOF
name: $TENANT
services:
  ghost-a:
    image: \${IMAGE}
    user: "1000:1000"
    environment:
      url: http://127.0.0.1:2368
      database__client: mysql
      database__connection__host: $LIVE_IP
      database__connection__port: "3306"
      database__connection__user: $DB_NAME
      database__connection__password: \${GHOST_DB_PASSWORD:?set in the secrets env}
      database__connection__database: $DB_NAME
      database__connection__ssl__rejectUnauthorized: "false"
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

echo "--- seeding the live database: a real owner, then a suspended support Administrator ---"
docker volume create "$VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/data" alpine chown -R 1000:1000 /data >/dev/null
docker run -d --name "$SEED_NAME" -p "127.0.0.1:$SEED_PORT:2368" \
    --mount "type=volume,src=$VOLUME,dst=/var/lib/ghost/content" \
    -e url="https://localhost:$SEED_PORT" \
    -e database__client=mysql \
    -e database__connection__host="$LIVE_IP" \
    -e database__connection__port=3306 \
    -e database__connection__user="$DB_NAME" \
    -e database__connection__password="$SECRET_SENTINEL" \
    -e database__connection__database="$DB_NAME" \
    -e database__connection__ssl__rejectUnauthorized=false \
    -e privacy__useUpdateCheck=false \
    -e BRANCHLEFT_ALLOW_LOCAL_STORAGE=true \
    "$GHOST_IMAGE" >/dev/null
deadline=$(($(date +%s) + 240))
seed_ready=false
while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "http://localhost:$SEED_PORT/" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
        seed_ready=true
        break
    fi
    sleep 1
done
if [ "$seed_ready" != "true" ]; then
    echo "FAIL: seed Ghost never answered 200 within 240s"
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

SUPPORT_ID="$(hexid)"
UNUSABLE_HASH="\$2a\$10\$$(printf '%s' "$(hexid)$(hexid)$(hexid)" | cut -c1-53)"
live_sql <<EOF
INSERT INTO users (id, name, slug, password, email, status, visibility, comment_notifications,
  free_member_signup_notification, paid_subscription_started_notification,
  paid_subscription_canceled_notification, mention_notifications, recommendation_notifications,
  milestone_notifications, donation_notifications, gift_subscription_notifications, created_at)
VALUES ('$SUPPORT_ID', 'Support', 'support', '$UNUSABLE_HASH', '$SUPPORT_EMAIL', 'inactive', 'public',
  1, 1, 1, 1, 1, 1, 1, 1, 1, UTC_TIMESTAMP());
INSERT INTO roles_users (id, role_id, user_id) SELECT '$(hexid)', id, '$SUPPORT_ID' FROM roles WHERE name = 'Administrator';
EOF
support_status() {
    echo "SELECT status FROM users WHERE email = '$SUPPORT_EMAIL';" | live_sql
}
if [ "$(support_status)" = "inactive" ]; then
    echo "PASS: seeded a real owner and a suspended support Administrator on the live database"
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
    (cd "$BUNDLER_DIR" && TMPDIR="$RUN_TMP" PATH="$NODE_BIN_DIR:$PATH" exec node dist/cli.js \
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
    [ -z "$(run_leftovers)" ] && [ ! -e "$DEST_DIR" ] && [ -z "$(find "$FLAG_DIR" -type f)" ] && \
        [ ! -e "$AUDIT_DIR/audit.jsonl" ] && [ -z "$(find "$RUN_TMP" -mindepth 1)" ]
}

refusal() {
    label="$1"; log="$2"; error="$3"; shift 3
    if run_bundler "$@" </dev/null >"$log" 2>&1; then
        fail "the bundler exited 0: $label"
    elif grep -q "$error" "$log" && nothing_started; then
        echo "PASS: refused with $error: $label; nothing created (no colour, scratch copy, network, archive, drain flag, audit entry or env file)"
    else
        fail "$label did not refuse as expected:"
        cat "$log"
        run_leftovers
    fi
}

echo "--- refusals, before anything is created ---"
refusal "no grant given" "$WORK_DIR/no-grant.log" NoSupportGrantError
RUN_RECIPIENT="$OTHER_RECIPIENT"
refusal "an --age-recipient that is not the descriptor's" "$WORK_DIR/recipient.log" RecipientMismatchError \
    --grant-lane consented --grant-reference "$GRANT_REFERENCE"
RUN_RECIPIENT="$AGE_RECIPIENT"
RUN_STACK="$OWNER_STACK_DIR"
refusal "the rendered support identity is the Owner" "$WORK_DIR/owner.log" NotTheSupportAccountError \
    --grant-lane consented --grant-reference "$GRANT_REFERENCE"
RUN_STACK="$STACK_DIR"
refusal "the support account is still suspended" "$WORK_DIR/suspended.log" SupportAccountNotActiveError \
    --grant-lane consented --grant-reference "$GRANT_REFERENCE"
if [ "$(support_status)" = "inactive" ]; then
    echo "PASS: the bundler left the support account suspended -- it never un-suspends"
else
    fail "the support account is no longer suspended after a refused run"
fi
echo

echo "--- grant: the support account is un-suspended (standing in for the tenant's Staff screen) ---"
echo "UPDATE users SET status = 'active' WHERE email = '$SUPPORT_EMAIL';" | live_sql
echo "support account status: $(support_status)"
echo

echo "--- on the LIVE database: a due welcome email, a newsletter mid-send, and a post due in ~2 minutes ---"
# What Ghost 6.55 acts on at boot with no setting to stop it: the automations
# poll locks and sends every welcome-email run whose ready_at has passed, and
# resumeInterruptedSends takes over any newsletter in `submitting`.
SRC_POST="$(echo "SELECT id FROM posts WHERE type = 'post' AND status = 'published' ORDER BY created_at LIMIT 1;" | live_sql)"
AUTOMATION="$(hexid)"; AUTOMATED_EMAIL="$(hexid)"; MEMBER="$(hexid)"; WELCOME_RUN="$(hexid)"
NEWSLETTER_EMAIL="$(hexid)"; BATCH="$(hexid)"; SCHEDULED_POST="$(hexid)"
live_sql <<EOF
INSERT INTO automations (id, status, name, slug, created_at)
  VALUES ('$AUTOMATION', 'active', 'Welcome email (free members)', 'member-welcome-email-free', UTC_TIMESTAMP());
INSERT INTO welcome_email_automated_emails (id, welcome_email_automation_id, delay_days, subject, email_design_setting_id, created_at)
  SELECT '$AUTOMATED_EMAIL', '$AUTOMATION', 0, 'Welcome', id, UTC_TIMESTAMP() FROM email_design_settings LIMIT 1;
INSERT INTO members (id, uuid, transient_id, email, name, status, created_at)
  VALUES ('$MEMBER', UUID(), '$(hexid)', 'reader@proof.invalid', 'Reader', 'free', UTC_TIMESTAMP());
INSERT INTO welcome_email_automation_runs (id, welcome_email_automation_id, member_id, next_welcome_email_automated_email_id, ready_at, step_attempts, created_at)
  VALUES ('$WELCOME_RUN', '$AUTOMATION', '$MEMBER', '$AUTOMATED_EMAIL', UTC_TIMESTAMP() - INTERVAL 1 MINUTE, 0, UTC_TIMESTAMP());
INSERT INTO emails (id, post_id, uuid, status, recipient_filter, email_count, submitted_at, newsletter_id, created_at, source_type)
  SELECT '$NEWSLETTER_EMAIL', '$SRC_POST', UUID(), 'submitting', 'status:free', 1, UTC_TIMESTAMP(), id, UTC_TIMESTAMP(), 'html' FROM newsletters LIMIT 1;
INSERT INTO email_batches (id, email_id, status, created_at, updated_at)
  VALUES ('$BATCH', '$NEWSLETTER_EMAIL', 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP());
CREATE TEMPORARY TABLE sp AS SELECT * FROM posts WHERE id = '$SRC_POST';
UPDATE sp SET id = '$SCHEDULED_POST', uuid = UUID(), slug = 'scheduled-during-export-$SCHEDULED_POST',
  title = 'Scheduled during export', status = 'scheduled', published_at = UTC_TIMESTAMP() + INTERVAL 120 SECOND, newsletter_id = NULL;
INSERT INTO posts SELECT * FROM sp;
CREATE TEMPORARY TABLE spa AS SELECT * FROM posts_authors WHERE post_id = '$SRC_POST';
UPDATE spa SET id = '$(hexid)', post_id = '$SCHEDULED_POST';
INSERT INTO posts_authors SELECT * FROM spa;
EOF
SCHEDULED_AT=$(($(date +%s) + 120))
echo "$STATE_SQL" | live_sql > "$WORK_DIR/live-before.txt"
cat "$WORK_DIR/live-before.txt"
if grep -q "^run	$WELCOME_RUN	0	-	-	$AUTOMATED_EMAIL\$" "$WORK_DIR/live-before.txt" && \
   grep -q "^email	$NEWSLETTER_EMAIL	submitting	" "$WORK_DIR/live-before.txt" && \
   grep -q "^post	$SCHEDULED_POST	scheduled\$" "$WORK_DIR/live-before.txt"; then
    echo "PASS: live state seeded"
else
    fail "could not seed the live state"
fi
echo

wait_for_prompt() {
    deadline=$(($(date +%s) + 300))
    prompted=false
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if grep -q 'Mint a break-glass token now' "$1" 2>/dev/null; then
            prompted=true
            return 0
        fi
        if ! kill -0 "$CLI_PID" 2>/dev/null; then return 1; fi
        sleep 1
    done
    return 1
}

echo "--- running the real export inside the grant ---"
# The dump container lives only while the dump streams (it is --rm), so a
# watcher catches it while it exists and records what Docker says about its
# logging: the dump's stdout is the whole database.
(
    deadline=$(($(date +%s) + 300))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        dump="$(docker ps -a --format '{{.Names}}' | grep "^${TENANT}-export-.*-dump\$" | head -1 || true)"
        if [ -n "$dump" ]; then
            docker inspect --format '{{.Name}} LogConfig.Type={{.HostConfig.LogConfig.Type}} LogPath="{{.LogPath}}"' "$dump" \
                > "$WORK_DIR/dump-log-config.txt" 2>/dev/null && break
        fi
        sleep 0.1
    done
) &
DUMP_WATCH_PID=$!
mkfifo "$FIFO"
run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" \
    <"$FIFO" >"$WORK_DIR/export.out" 2>"$WORK_DIR/export.err" &
CLI_PID=$!
exec 3>"$FIFO"
if wait_for_prompt "$WORK_DIR/export.err"; then
    kill "$DUMP_WATCH_PID" >/dev/null 2>&1 || true
    echo "dump container, while it ran: $(cat "$WORK_DIR/dump-log-config.txt" 2>/dev/null || echo '(never seen)')"
    if grep -q -- '-dump LogConfig.Type=none LogPath=""$' "$WORK_DIR/dump-log-config.txt" 2>/dev/null; then
        echo "PASS: the mysqldump container ran with LogConfig.Type=none and no json log file -- the dump stream was never written to /var/lib/docker"
    else
        fail "the dump container's logging was not none, or it was never seen"
    fi
    echo "PASS: the bundler asked for the token only once the colour was up"
    colour="$(docker ps --format '{{.Names}}' | grep "^${TENANT}-export-[0-9]*\$" | head -1)"
    scratch="$(scratch_container)"
    docker inspect --format '{{json .Config.Env}}' "$colour" > "$WORK_DIR/colour-env.json"

    # The colour's database is the run's scratch copy, never the live one.
    if grep -F -q -e "\"database__connection__host=$scratch\"" "$WORK_DIR/colour-env.json" && \
       ! grep -F -q -e "database__connection__host=$LIVE_IP" "$WORK_DIR/colour-env.json"; then
        echo "PASS: Docker reports the export colour's database host as the run's scratch copy ($scratch), not the live database ($LIVE_IP)"
    else
        fail "the export colour's database host is not the scratch copy"
    fi
    if grep -F -q -e "$SECRET_SENTINEL" "$WORK_DIR/colour-env.json"; then
        fail "the export colour holds the live database's password"
    else
        echo "PASS: the export colour never holds the live database's password"
    fi
    # Snapshot first: a grep in the same pipeline would carry the sentinel
    # in its own argv and match itself.
    ps -axww -o command= > "$WORK_DIR/ps.txt"
    if [ ! -s "$WORK_DIR/ps.txt" ] || ! grep -q 'dist/cli.js' "$WORK_DIR/ps.txt"; then
        fail "the process snapshot did not capture the running bundler"
    elif grep -F -q -e "$SECRET_SENTINEL" "$WORK_DIR/ps.txt"; then
        fail "the live database's password is visible in a process's argv"
    else
        echo "PASS: no process's argv carries the live database's password"
    fi
    relay="${colour}-relay"
    if [ -z "$(docker port "$colour")" ] && docker port "$relay" | grep -q '127.0.0.1:' && \
       ! docker port "$relay" | grep -q '0.0.0.0'; then
        echo "PASS: the export colour publishes nothing; its one way in is the relay, on 127.0.0.1 only"
    else
        fail "unexpected port bindings: colour [$(docker port "$colour")] relay [$(docker port "$relay")]"
    fi
    all_none=true
    for c in "$scratch" "$colour" "$relay"; do
        lc="$(docker inspect --format '{{.HostConfig.LogConfig.Type}} "{{.LogPath}}"' "$c")"
        echo "  $c logging: $lc"
        [ "$lc" = 'none ""' ] || all_none=false
    done
    if [ "$all_none" = "true" ]; then
        echo "PASS: the scratch database, the export colour and the relay all run with LogConfig.Type=none and no log file"
    else
        fail "a run container keeps a Docker log"
    fi
    net="${colour}-net"
    if [ "$(docker network inspect --format '{{.Internal}}' "$net")" = "true" ]; then
        echo "PASS: the run network $net is --internal"
    else
        fail "the run network is not internal"
    fi
    colour_out="$(docker exec "$colour" node -e "
const s = require('net').connect({ host: '1.1.1.1', port: 443, timeout: 5000 });
s.on('connect', () => { console.log('connected'); process.exit(0); });
s.on('timeout', () => { console.log('timeout'); process.exit(0); });
s.on('error', (e) => { console.log(e.code); process.exit(0); });
" 2>&1 || true)"
    db_out="$(docker exec "$scratch" bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" && echo connected || echo refused-or-unreachable' 2>&1 || true)"
    echo "  outbound from the colour: $colour_out; from the scratch database: $db_out"
    if [ "$colour_out" != "connected" ] && ! echo "$db_out" | grep -q '^connected$'; then
        echo "PASS: neither the export colour nor the scratch database has an outbound route"
    else
        fail "something on the run network reached the internet"
    fi

    # Defence in depth, read through Ghost's own config inside the colour.
    docker exec "$colour" node -e "
process.chdir('/var/lib/ghost');
const c = require('/var/lib/ghost/current/core/shared/config');
const out = {
  databaseHost: c.get('database:connection:host'),
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
    if grep -q "\"databaseHost\":\"$scratch\"" "$WORK_DIR/colour-config.json" && \
       grep -q '"transport":"stub"' "$WORK_DIR/colour-config.json" && \
       grep -q '"mailHost":null' "$WORK_DIR/colour-config.json" && \
       grep -q '"bulkSink":"ECONNREFUSED"' "$WORK_DIR/colour-config.json" && \
       grep -q '"scheduling":"SchedulingDisabled"' "$WORK_DIR/colour-config.json"; then
        echo "PASS: second layer: Ghost's database host is the copy, mail goes to the stub, bulk email to a refused sink, scheduler disabled"
    else
        fail "the export colour's own config is not isolated"
    fi

    # The control: Ghost's boot-time automation poll and newsletter resume
    # do act -- on the copy.
    deadline=$(($(date +%s) + 120))
    acted=false
    while [ "$(date +%s)" -lt "$deadline" ]; do
        echo "$STATE_SQL" | scratch_sql > "$WORK_DIR/copy-state.txt" 2>/dev/null || true
        # Acted on = the welcome run was locked for sending (its attempt
        # count moved off 0) and the resumed newsletter's rows are no longer
        # the ones seeded (the email row touched, the batch moved on).
        if [ -s "$WORK_DIR/copy-state.txt" ] && \
           ! grep -q "^run	$WELCOME_RUN	0	" "$WORK_DIR/copy-state.txt" && \
           ! grep -q -F -x -e "$(grep "^email	" "$WORK_DIR/live-before.txt")" "$WORK_DIR/copy-state.txt" && \
           ! grep -q -F -x -e "$(grep "^batch	" "$WORK_DIR/live-before.txt")" "$WORK_DIR/copy-state.txt"; then
            acted=true
            break
        fi
        sleep 2
    done
    echo "copy state while the colour runs:"
    cat "$WORK_DIR/copy-state.txt"
    if [ "$acted" = "true" ]; then
        echo "PASS: the export colour's boot-time welcome-email poll and newsletter resume acted -- on the copy"
    else
        fail "the copy's welcome-email run or newsletter never changed: the control did not fire"
    fi

    # Hold the export until the post has been due for 45s, then check the
    # copy: the scheduler, the second layer, published nothing there either.
    while [ "$(date +%s)" -lt $((SCHEDULED_AT + 45)) ]; do sleep 1; done
    copy_post="$(echo "SELECT status FROM posts WHERE id = '$SCHEDULED_POST';" | scratch_sql)"
    if [ "$copy_post" = "scheduled" ]; then
        echo "PASS: the post due during the export is still scheduled on the copy -- the scheduler published nothing"
    else
        fail "the post due during the export is \"$copy_post\" on the copy: the scheduler ran"
    fi
    echo "handing over the token"
    "$NODE_BIN_DIR/node" "$HELPER_DIR/mint.mjs" "$PRIVATE_KEY" "$TENANT" "$SUPPORT_EMAIL" >&3
else
    fail "the bundler never asked for a token"
    cat "$WORK_DIR/export.err"
fi
exec 3>&-
# A bundler that finishes its work but never exits must fail here, not hang.
deadline=$(($(date +%s) + 240))
while kill -0 "$CLI_PID" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.5
done
if kill -0 "$CLI_PID" 2>/dev/null; then
    fail "the export bundler CLI had not exited 240s after the token was given"
    kill "$CLI_PID" >/dev/null 2>&1 || true
fi
if wait "$CLI_PID"; then
    echo "PASS: the export bundler CLI exited 0"
else
    fail "the export bundler CLI did not exit 0:"
    cat "$WORK_DIR/export.out" "$WORK_DIR/export.err"
fi
CLI_PID=""
rm -f "$FIFO"
echo

echo "--- the LIVE database after the export ---"
echo "$STATE_SQL" | live_sql > "$WORK_DIR/live-after.txt"
if cmp -s "$WORK_DIR/live-before.txt" "$WORK_DIR/live-after.txt"; then
    echo "PASS: the live welcome-email run, recipients, newsletter, batches and scheduled post are byte-identical before and after the export"
else
    fail "the live rows changed during the export:"
    diff "$WORK_DIR/live-before.txt" "$WORK_DIR/live-after.txt" || true
fi
if [ "$(support_status)" = "active" ]; then
    echo "PASS: the bundler did not re-suspend the support account -- that is the grant lane's step"
else
    fail "the support account's status changed during the export"
fi
echo

echo "--- checking cleanup after a successful run ---"
leftover="$(run_leftovers)"
if [ -z "$leftover" ]; then
    echo "PASS: nothing the run created is left: no colour, no scratch container, network or volume"
else
    fail "the run left behind: $(echo "$leftover" | tr '\n' ' ')"
fi
if [ -z "$(find "$FLAG_DIR" -type f 2>/dev/null)" ]; then
    echo "PASS: the drain flag was cleared after the run"
else
    fail "drain flag file(s) left behind: $(find "$FLAG_DIR" -type f)"
fi
if [ -z "$(find "$RUN_TMP" -mindepth 1)" ]; then
    echo "PASS: the run's temp directory is empty -- every env file is gone"
else
    fail "the run left files in its temp directory: $(find "$RUN_TMP" -mindepth 1)"
fi
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

echo "--- checking the decrypted archive's real contents ---"
LISTING="$(age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -tf -)"
if [ "$LISTING" = "$(printf 'content_and_settings.json\npost_analytics.csv\nmanifest.json')" ]; then
    echo "PASS: decrypts to content_and_settings.json, post_analytics.csv and manifest.json"
else
    fail "unexpected decrypted listing: $LISTING"
fi
if age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -xOf - content_and_settings.json | grep -q -F "$SITE_TITLE"; then
    echo "PASS: the content-and-settings export carries this tenant's real Ghost content, from the copy"
else
    fail "the content-and-settings export does not carry the tenant's content"
fi
if [ "$(age -d -i "$KEY_DIR/identity.txt" "$ARCHIVE" | tar -xOf - post_analytics.csv | wc -c | tr -d ' ')" -gt 0 ]; then
    echo "PASS: the analytics CSV is non-empty"
else
    fail "the analytics CSV is empty"
fi

echo "--- checking the manifest, permissions and audit record ---"
if grep -q '"encrypted": true' "$SIDECAR" && grep -q '"format": "age"' "$SIDECAR" && \
   grep -q "\"recipientFingerprint\": \"$EXPECTED_FINGERPRINT\"" "$SIDECAR"; then
    echo "PASS: the manifest states the archive is age-encrypted to $EXPECTED_FINGERPRINT"
else
    fail "the manifest does not state the encryption:"
    cat "$SIDECAR"
fi
archive_mode="$(stat -f '%Lp' "$ARCHIVE" 2>/dev/null || stat -c '%a' "$ARCHIVE")"
sidecar_mode="$(stat -f '%Lp' "$SIDECAR" 2>/dev/null || stat -c '%a' "$SIDECAR")"
dest_mode="$(stat -f '%Lp' "$DEST_DIR" 2>/dev/null || stat -c '%a' "$DEST_DIR")"
if [ "$archive_mode" = "600" ] && [ "$sidecar_mode" = "600" ] && [ "$dest_mode" = "700" ]; then
    echo "PASS: archive 0600, manifest 0600, destination directory 0700"
else
    fail "archive $archive_mode, manifest $sidecar_mode, directory $dest_mode (expected 600 / 600 / 700)"
fi
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

echo "--- Ctrl-C at the token prompt: everything the run created is removed ---"
mkfifo "$FIFO"
run_bundler --grant-lane consented --grant-reference "$GRANT_REFERENCE" \
    <"$FIFO" >"$WORK_DIR/sigint.out" 2>"$WORK_DIR/sigint.err" &
CLI_PID=$!
exec 3>"$FIFO"
if wait_for_prompt "$WORK_DIR/sigint.err"; then
    during="$(run_leftovers | tr '\n' ' ')"
    echo "while waiting for the token: $during"
    # To the node process itself, as a terminal's Ctrl-C would deliver it: a
    # non-interactive shell's background job ignores SIGINT.
    kill -INT "$(pgrep -f "dist/cli.js --descriptor $DESCRIPTOR" | head -1)"
    set +e
    wait "$CLI_PID"
    sigint_exit=$?
    set -e
    CLI_PID=""
    leftover="$(run_leftovers)"
    if [ "$sigint_exit" = "130" ] && [ -z "$leftover" ] && [ -z "$(find "$RUN_TMP" -mindepth 1)" ] && [ -z "$(find "$FLAG_DIR" -type f)" ] && \
       echo "$during" | grep -q -- '-db ' && echo "$during" | grep -q -- '-net '; then
        echo "PASS: SIGINT exited 130 and removed the colour, the scratch container and its network, every env file and the drain flag"
    else
        fail "after SIGINT (exit $sigint_exit): left behind: $(echo "$leftover" | tr '\n' ' ') $(find "$RUN_TMP" -mindepth 1)"
    fi
else
    fail "the second run never reached the token prompt"
    cat "$WORK_DIR/sigint.err"
fi
exec 3>&-
echo "UPDATE users SET status = 'inactive' WHERE email = '$SUPPORT_EMAIL';" | live_sql
echo "--- revoke: the support account is re-suspended (standing in for the lane's re-suspend) ---"
echo

if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed."
    exit 1
fi

echo "All export-bundler live checks passed."
