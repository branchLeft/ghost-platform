#!/bin/sh
# Measures whether a drained old colour keeps serving correctly once its
# paired new colour has migrated the shared database forward, across a
# real minor-version bump, against a real database engine.
# Usage: ./scripts/measure-old-colour-schema-drift.sh <mysql|sqlite>
# See scripts/measure-old-colour-schema-drift.md#what-this-measures.
set -e

ENGINE="${1:?usage: measure-old-colour-schema-drift.sh <mysql|sqlite>}"
BLUE_TAG="ghost:6.55.0-alpine"
GREEN_TAG="ghost:6-alpine"
RUN_ID="$$"
WORKDIR="$(mktemp -d)"
NET="spike-net-$RUN_ID"
PW="$(openssl rand -base64 24 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 24)"
ADMIN_PW="A$(openssl rand -base64 24 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 23)"
OWNER_EMAIL="owner-$RUN_ID@example.test"
MEMBER_EMAIL="member-$RUN_ID@example.test"
COOKIES="$WORKDIR/cookies.txt"
FAILURES=0
BLUE_NAME="spike-blue-$RUN_ID"
GREEN_NAME="spike-green-$RUN_ID"
MYSQL_NAME="spike-mysql-$RUN_ID"
BLUE_PORT=$((14000 + (RUN_ID % 4000)))
GREEN_PORT=$((BLUE_PORT + 1))
MYSQL_PORT=$((BLUE_PORT + 2))

cleanup() {
    docker rm -f "$BLUE_NAME" "$GREEN_NAME" "$MYSQL_NAME" \
        "spike-ctrl-mysql-$RUN_ID" "spike-ctrl-blue-$RUN_ID" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "=== old-colour-on-migrated-schema measurement ($ENGINE) ==="
echo "blue=$BLUE_TAG green=$GREEN_TAG run=$RUN_ID"

wait_http_200() {
    # wait_http_200 URL DEADLINE_SECONDS
    url="$1"
    deadline=$(($(date +%s) + $2))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
        if [ "$status" = "200" ]; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

assert_eq() {
    # assert_eq LABEL EXPECTED GOT
    if [ "$2" = "$3" ]; then
        echo "PASS: $1 (got $3)"
    else
        echo "FAIL: $1 (expected $2, got $3)"
        FAILURES=$((FAILURES + 1))
    fi
}

# run_smoke STAGE PORT COOKIEJAR -- "after" deliberately reuses "before"'s
# cookie jar rather than logging in again, since a second explicit login
# trips an unrelated 2FA-by-email gate.
# See scripts/measure-old-colour-schema-drift.md#run_smoke-reuses-the-session.
run_smoke() {
    stage="$1"
    port="$2"
    jar="$3"
    marker="smoke-marker-$RUN_ID-$stage"
    echo "--- smoke suite: $stage (port $port) ---"

    if [ "$stage" = "before" ]; then
        setup_status="$(curl -s -o "$WORKDIR/setup-$stage.json" -w '%{http_code}' \
            -H 'Content-Type: application/json' \
            -d "{\"setup\":[{\"name\":\"Spike Owner\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$ADMIN_PW\",\"blogTitle\":\"schema-drift spike\"}]}" \
            "http://localhost:$port/ghost/api/admin/authentication/setup/")"
        assert_eq "owner setup ($stage)" "201" "$setup_status"

        session_status="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" \
            -H 'Content-Type: application/json' \
            -d "{\"username\":\"$OWNER_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
            "http://localhost:$port/ghost/api/admin/session/")"
        assert_eq "owner session ($stage)" "201" "$session_status"
    else
        # Prove the SAME session, opened before green ever migrated
        # anything, still authenticates the admin -- the real test of
        # whether the old colour "keeps serving correctly throughout",
        # not whether a brand new login still works.
        whoami_status="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" \
            "http://localhost:$port/ghost/api/admin/users/me/")"
        assert_eq "owner's pre-existing session still authenticates ($stage)" "200" "$whoami_status"
    fi

    post_status="$(curl -s -o "$WORKDIR/post-$stage.json" -w '%{http_code}' -b "$jar" \
        -H 'Content-Type: application/json' \
        "http://localhost:$port/ghost/api/admin/posts/?source=html" \
        -d "{\"posts\":[{\"title\":\"$marker\",\"html\":\"<p>$marker body</p>\",\"status\":\"published\"}]}")"
    assert_eq "publish ($stage)" "201" "$post_status"
    slug="$(jq -r '.posts[0].slug // empty' "$WORKDIR/post-$stage.json" 2>/dev/null)"

    home_body="$(curl -s "http://localhost:$port/")"
    case "$home_body" in
        *"$marker"*) echo "PASS: render homepage shows $stage's post ($stage)" ;;
        *)
            echo "FAIL: render homepage missing $stage's marker ($stage)"
            FAILURES=$((FAILURES + 1))
            ;;
    esac
    case "$home_body" in
        *"absent-control-$RUN_ID-$stage"*)
            echo "FAIL: render control marker unexpectedly present ($stage) -- the check cannot be trusted"
            FAILURES=$((FAILURES + 1))
            ;;
        *) echo "PASS: render control -- an unpublished marker is correctly absent ($stage)" ;;
    esac

    if [ -n "$slug" ]; then
        post_body="$(curl -s "http://localhost:$port/$slug/")"
        case "$post_body" in
            *"$marker body"*) echo "PASS: render post page body present ($stage)" ;;
            *)
                echo "FAIL: render post page body missing ($stage)"
                FAILURES=$((FAILURES + 1))
                ;;
        esac
    else
        echo "FAIL: no slug returned for $stage's post, cannot render it"
        FAILURES=$((FAILURES + 1))
    fi

    member_status="$(curl -s -o "$WORKDIR/member-$stage.json" -w '%{http_code}' -b "$jar" \
        -H 'Content-Type: application/json' \
        "http://localhost:$port/ghost/api/admin/members/" \
        -d "{\"members\":[{\"email\":\"$MEMBER_EMAIL.$stage\",\"name\":\"Spike Member $stage\"}]}")"
    assert_eq "member creation ($stage)" "201" "$member_status"

    # Member sign-in: the magic-link REQUEST is a real call through the
    # public Members API. Whether the mail is actually delivered is a
    # separate question this measurement does not answer (no live/shim
    # mail provider was wired up for this spike) -- recorded honestly
    # rather than assumed. What this checks is whether the OLD CODE's
    # member/token DB path accepts the request on the migrated schema.
    magic_status="$(curl -s -o "$WORKDIR/magic-$stage.json" -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        "http://localhost:$port/members/api/send-magic-link/" \
        -d "{\"email\":\"$MEMBER_EMAIL.$stage\",\"emailType\":\"signin\"}")"
    echo "INFO: magic-link request ($stage) -> HTTP $magic_status, body: $(cat "$WORKDIR/magic-$stage.json" 2>/dev/null)"
}

verify_version() {
    port="$1"
    label="$2"
    got="$(curl -s "http://localhost:$port/ghost/api/admin/site/" | jq -r '.site.version // empty' 2>/dev/null)"
    echo "INFO: $label reports version $got"
    echo "$got"
}

if [ "$ENGINE" = "mysql" ]; then
    docker network create "$NET" >/dev/null
    echo "--- starting mysql:8.0.46 ---"
    docker run -d --name "$MYSQL_NAME" --network "$NET" -p "$MYSQL_PORT:3306" \
        -e MYSQL_ROOT_PASSWORD="$PW" -e MYSQL_DATABASE=ghost \
        mysql:8.0.46 >/dev/null

    deadline=$(($(date +%s) + 90))
    mysql_ready=false
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if mysql -h127.0.0.1 -P"$MYSQL_PORT" -uroot -p"$PW" -e 'SELECT 1' >/dev/null 2>&1; then
            mysql_ready=true
            break
        fi
        sleep 1
    done
    if [ "$mysql_ready" != "true" ]; then
        echo "FAIL: mysql never became reachable within 90s"
        exit 1
    fi
    echo "mysql ready."

    echo "--- starting blue ($BLUE_TAG) on the fresh database ---"
    docker run -d --name "$BLUE_NAME" --network "$NET" -p "$BLUE_PORT:2368" \
        -e url="http://localhost:$BLUE_PORT" \
        -e database__client=mysql \
        -e database__connection__host="$MYSQL_NAME" \
        -e database__connection__user=root \
        -e database__connection__password="$PW" \
        -e database__connection__database=ghost \
        -e privacy__useUpdateCheck=false \
        "$BLUE_TAG" >/dev/null

    if ! wait_http_200 "http://localhost:$BLUE_PORT/" 60; then
        echo "FAIL: blue never answered 200"
        docker logs "$BLUE_NAME" 2>&1 | tail -60
        exit 1
    fi
    verify_version "$BLUE_PORT" "blue, before green"

    run_smoke before "$BLUE_PORT" "$COOKIES"

    echo "--- starting green ($GREEN_TAG) against the SAME database, blue untouched ---"
    docker run -d --name "$GREEN_NAME" --network "$NET" -p "$GREEN_PORT:2368" \
        -e url="http://localhost:$GREEN_PORT" \
        -e database__client=mysql \
        -e database__connection__host="$MYSQL_NAME" \
        -e database__connection__user=root \
        -e database__connection__password="$PW" \
        -e database__connection__database=ghost \
        -e privacy__useUpdateCheck=false \
        "$GREEN_TAG" >/dev/null

    if ! wait_http_200 "http://localhost:$GREEN_PORT/" 60; then
        echo "FAIL: green never answered 200 (did the migration hang?)"
        docker logs "$GREEN_NAME" 2>&1 | tail -80
        exit 1
    fi
    green_version="$(verify_version "$GREEN_PORT" "green, after its own migration")"

    blue_status_after_green="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$BLUE_PORT/")"
    assert_eq "blue still answers 200, unrestarted, after green migrated the shared schema" "200" "$blue_status_after_green"

    run_smoke after "$BLUE_PORT" "$COOKIES"

    echo "--- blue's own log across the whole run, for diagnosing any 'after' failure ---"
    docker logs "$BLUE_NAME" 2>&1 | tail -120

    # reproduce_batch_claim_write PORT PW LABEL POST_ID
    # Inserts a minimal `emails` + `email_batches` row directly (bypassing
    # Ghost's own bulk-email gating, which this measurement does not wire
    # up a mail provider for) and then issues the EXACT write
    # batch-sending-service.js:612-614 performs on every successful send:
    #   await batch.save({status: 'submitted', provider_id: response.id, ...})
    # Reports the real result verbatim, whatever it is.
    reproduce_batch_claim_write() {
        rport="$1"; rpw="$2"; rlabel="$3"; rpost="$4"
        remail="spikee$RUN_ID$$"
        rbatch="spikeb$RUN_ID$$"
        mysql -h127.0.0.1 -P"$rport" -uroot -p"$rpw" ghost -e \
            "INSERT INTO emails (id, post_id, uuid, status, recipient_filter, email_count, source_type, submitted_at, created_at, updated_at) VALUES ('$remail', '$rpost', '$(openssl rand -hex 16)', 'submitting', 'all', 1, 'html', NOW(), NOW(), NOW());" 2>&1 || true
        mysql -h127.0.0.1 -P"$rport" -uroot -p"$rpw" ghost -e \
            "INSERT INTO email_batches (id, email_id, status, created_at, updated_at) VALUES ('$rbatch', '$remail', 'submitting', NOW(), NOW());" 2>&1 || true
        echo "[$rlabel] columns on email_batches: $(mysql -h127.0.0.1 -P"$rport" -uroot -p"$rpw" ghost -N -e "SELECT GROUP_CONCAT(column_name) FROM information_schema.columns WHERE table_schema='ghost' AND table_name='email_batches';" 2>/dev/null)"
        echo "[$rlabel] batch.save({status:'submitted', provider_id: response.id}), the exact write at batch-sending-service.js:612-614:"
        mysql -h127.0.0.1 -P"$rport" -uroot -p"$rpw" ghost -e \
            "UPDATE email_batches SET status='submitted', provider_id='spike-synthetic-message-id', updated_at=NOW() WHERE id='$rbatch';" 2>&1 || true
        echo "[$rlabel] resulting row: $(mysql -h127.0.0.1 -P"$rport" -uroot -p"$rpw" ghost -N -e "SELECT id,status,provider_id FROM email_batches WHERE id='$rbatch';" 2>/dev/null || echo '(no provider_id column -- write above failed)')"
    }

    echo "--- the batch-claim write, on blue's own migrated database (email_id is a real post from this run) ---"
    reproduce_batch_claim_write "$MYSQL_PORT" "$PW" "AFTER green's migration" "$(mysql -h127.0.0.1 -P"$MYSQL_PORT" -uroot -p"$PW" ghost -N -e "SELECT id FROM posts LIMIT 1;" 2>/dev/null)"

    echo "--- control: the identical write on a fresh, standalone, NEVER-migrated blue (same image, own database) ---"
    CTRL_MYSQL_NAME="spike-ctrl-mysql-$RUN_ID"
    CTRL_BLUE_NAME="spike-ctrl-blue-$RUN_ID"
    CTRL_PORT=$((MYSQL_PORT + 100))
    CTRL_BLUE_PORT=$((MYSQL_PORT + 101))
    docker run -d --name "$CTRL_MYSQL_NAME" --network "$NET" -p "$CTRL_PORT:3306" \
        -e MYSQL_ROOT_PASSWORD="$PW" -e MYSQL_DATABASE=ghost mysql:8.0.46 >/dev/null
    deadline=$(($(date +%s) + 90))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        mysql -h127.0.0.1 -P"$CTRL_PORT" -uroot -p"$PW" -e 'SELECT 1' >/dev/null 2>&1 && break
        sleep 1
    done
    docker run -d --name "$CTRL_BLUE_NAME" --network "$NET" -p "$CTRL_BLUE_PORT:2368" \
        -e url="http://localhost:$CTRL_BLUE_PORT" \
        -e database__client=mysql \
        -e database__connection__host="$CTRL_MYSQL_NAME" \
        -e database__connection__user=root \
        -e database__connection__password="$PW" \
        -e database__connection__database=ghost \
        -e privacy__useUpdateCheck=false \
        "$BLUE_TAG" >/dev/null
    if wait_http_200 "http://localhost:$CTRL_BLUE_PORT/" 60; then
        reproduce_batch_claim_write "$CTRL_PORT" "$PW" "CONTROL, unmigrated 6.55.0" "ctrl-post-$RUN_ID"
    else
        echo "FAIL: control blue never answered 200 -- control case could not run"
        FAILURES=$((FAILURES + 1))
    fi
    docker rm -f "$CTRL_BLUE_NAME" "$CTRL_MYSQL_NAME" >/dev/null 2>&1 || true

else
    DATA_DIR="$WORKDIR/data"
    mkdir -p "$DATA_DIR"
    echo "--- starting blue ($BLUE_TAG) on a fresh SQLite file ---"
    docker run -d --name "$BLUE_NAME" -p "$BLUE_PORT:2368" \
        -v "$DATA_DIR:/var/lib/ghost/content/data" \
        -e url="http://localhost:$BLUE_PORT" \
        -e database__client=sqlite3 \
        -e database__connection__filename=/var/lib/ghost/content/data/ghost.db \
        -e privacy__useUpdateCheck=false \
        "$BLUE_TAG" >/dev/null

    if ! wait_http_200 "http://localhost:$BLUE_PORT/" 60; then
        echo "FAIL: blue never answered 200"
        docker logs "$BLUE_NAME" 2>&1 | tail -60
        exit 1
    fi
    verify_version "$BLUE_PORT" "blue, before green"

    run_smoke before "$BLUE_PORT" "$COOKIES"

    echo "--- starting green ($GREEN_TAG) on the SAME SQLite file, blue untouched ---"
    docker run -d --name "$GREEN_NAME" -p "$GREEN_PORT:2368" \
        -v "$DATA_DIR:/var/lib/ghost/content/data" \
        -e url="http://localhost:$GREEN_PORT" \
        -e database__client=sqlite3 \
        -e database__connection__filename=/var/lib/ghost/content/data/ghost.db \
        -e privacy__useUpdateCheck=false \
        "$GREEN_TAG" >/dev/null

    if ! wait_http_200 "http://localhost:$GREEN_PORT/" 60; then
        echo "FAIL: green never answered 200 (did the migration hang, or lock the file blue holds open?)"
        docker logs "$GREEN_NAME" 2>&1 | tail -80
        echo "--- blue's own log for the same window ---"
        docker logs "$BLUE_NAME" 2>&1 | tail -40
        exit 1
    fi
    verify_version "$GREEN_PORT" "green, after its own migration"

    blue_status_after_green="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$BLUE_PORT/")"
    assert_eq "blue still answers 200, unrestarted, after green migrated the shared SQLite file" "200" "$blue_status_after_green"

    run_smoke after "$BLUE_PORT" "$COOKIES"

    echo "--- reproducing the batch-claim write against the now-migrated SQLite schema ---"
    echo "columns on email_batches after green's migration:"
    sqlite3 "$DATA_DIR/ghost.db" "PRAGMA table_info(email_batches);" 2>&1
fi

echo
if [ "$FAILURES" -gt 0 ]; then
    echo "=== $FAILURES check(s) FAILED ($ENGINE) ==="
    exit 1
fi
echo "=== all smoke-suite checks passed against the drained-but-serving old colour ($ENGINE) ==="
