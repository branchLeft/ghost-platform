#!/bin/sh
# Proves the demo host's one mail spool against a real dockerd inside a
# privileged Docker-in-Docker stand-in for demo1; see scripts/test-demo-mail-spool.md.
# The spool is rendered by render-core, installed the way the delivery runbook
# installs it, and sits behind the real demo egress policy.
#
# Usage:  ./scripts/test-demo-mail-spool.sh            (must exit 0)
#         SABOTAGE=open-route ./scripts/test-demo-mail-spool.sh     (must exit 1)
#         SABOTAGE=no-spool ./scripts/test-demo-mail-spool.sh       (must exit 1)
#         SABOTAGE=wrong-message ./scripts/test-demo-mail-spool.sh  (must exit 1)
# Needs `npm ci && npm run build` in render-core first. Creates only
# containers and a network under one prefix.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="bl-spool-proof-$$"
HOST="$PREFIX-host"
OUTSIDE="$PREFIX-outside"
NET="$PREFIX-net"
DIND_IMAGE="docker:27-dind"
PROBE_IMAGE="python:3.12-alpine"
# ghcr.io/branchleft/mailgun-shim:latest at the time of writing (df3092c).
SPOOL_IMAGE="${SPOOL_IMAGE:-ghcr.io/branchleft/mailgun-shim@sha256:7d832ac2f4835a04911263d168b2fa384fce4c5aba6df478c19516bc2783d015}"
DRAIN_PORT=8095
# Compose names the container <project>-<service>-1.
SPOOL_C="mail-spool-mail-spool-1"
DOMAIN="tenant1.example.com"
# Each message's subject carries a marker unique to this run, so the queue can
# be asked for these two messages and no others.
MARK="m$$"
SMTP_MARK="$MARK-smtp"
HTTP_MARK="$MARK-http"
SABOTAGE="${SABOTAGE:-}"
WORK="$(mktemp -d)"

PASSES=0
FAILURES=0

# shellcheck disable=SC2317,SC2329 # run only through the trap below
cleanup() {
    docker rm -f -v "$HOST" "$OUTSIDE" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
[ -n "${KEEP_PROOF_CONTAINERS:-}" ] || trap cleanup EXIT INT TERM

finish() {
    echo
    echo "$PASSES passed, $FAILURES failed"
    [ "$FAILURES" -eq 0 ] || exit 1
    exit 0
}

pass() { PASSES=$((PASSES + 1)); echo "PASS: $*"; }
fail() { FAILURES=$((FAILURES + 1)); echo "FAIL: $*"; }
expect_ok() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
expect_refused() { if eval "$2"; then fail "$1"; else pass "$1"; fi; }

DOCKERD_PATH=""
on_host() {
    if [ -n "$DOCKERD_PATH" ]; then
        docker exec -e PATH="$DOCKERD_PATH" "$HOST" sh -c "$1"
    else
        docker exec "$HOST" sh -c "$1"
    fi
}

wait_dockerd() {
    tries=0
    until on_host "docker info" >/dev/null 2>&1; do
        tries=$((tries + 1))
        [ "$tries" -lt 60 ] || { echo "the stand-in host's dockerd never came up"; exit 1; }
        sleep 1
    done
}

wait_spool_healthy() {
    tries=0
    until [ "$(on_host "docker inspect -f '{{.State.Health.Status}}' $SPOOL_C" 2>/dev/null)" = healthy ]; do
        tries=$((tries + 1))
        [ "$tries" -lt 90 ] || { echo "the spool never became healthy"; on_host "docker logs $SPOOL_C" || true; exit 1; }
        sleep 1
    done
}

apply_policy() { on_host "sh /policy/branchleft_demo_egress.sh" >/dev/null; }

# Runs inside the spool container, which has node and nothing else.
# shellcheck disable=SC2317,SC2329 # run only through eval, in expect_ok and expect_refused
spool_connects() { on_host "docker exec -i $SPOOL_C node - $1 $2 < /work/tcpprobe.js" >/dev/null 2>&1; }
spool_resolves() { on_host "docker exec -i $SPOOL_C node - $1 < /work/dnsprobe.js" >/dev/null 2>&1; }

undrained() {
    on_host "wget -q -T 5 -O - http://127.0.0.1:$DRAIN_PORT/metrics" |
        sed -n 's/^mailgun_shim_undrained_recipients //p'
}
queued() { n="$(undrained)"; echo "${n:-unreadable}"; }

# The subject of every message the spool is holding, sorted, read from the
# spool's own database from inside its container.
queued_subjects() { on_host "docker exec -i $SPOOL_C node - < /work/queuesubjects.js"; }

# A one-shot Ghost stand-in on a slot's own mail network.
on_slot_network() {
    net="$1"
    shift
    on_host "docker run --rm --network $net -v /work:/work:ro $PROBE_IMAGE $*"
}

[ -f "$HERE/render-core/dist/index.js" ] || { echo "run 'npm ci && npm run build' in render-core first"; exit 1; }

cp "$HERE/scripts/mail-spool-proof/"* "$WORK/"
node "$HERE/scripts/render-mail-spool-compose.mjs" "$SPOOL_IMAGE" "$DRAIN_PORT" 30001 30002 >"$WORK/compose.yml"
# The posture check ran inside render; this is the file the host gets.
grep -q "image: '$SPOOL_IMAGE'" "$WORK/compose.yml" ||
    { echo "the rendered file does not carry the pinned image"; exit 1; }
chmod 0644 "$WORK"/*

docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 || docker pull -q "$PROBE_IMAGE" >/dev/null
docker image inspect "$DIND_IMAGE" >/dev/null 2>&1 || docker pull -q "$DIND_IMAGE" >/dev/null

docker network create "$NET" >/dev/null
docker run -d --name "$OUTSIDE" --network "$NET" "$PROBE_IMAGE" python -m http.server 8080 >/dev/null
OUTSIDE_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$OUTSIDE")"

docker run -d --privileged --name "$HOST" --hostname demo1 --network "$NET" \
    -e DOCKER_TLS_CERTDIR= \
    -v "$HERE/demo-host/provision:/policy:ro" \
    -v "$WORK:/work:ro" \
    "$DIND_IMAGE" >/dev/null
wait_dockerd
# shellcheck disable=SC2016 # expanded on the stand-in host, not here
DOCKERD_PATH="$(on_host 'tr "\0" "\n" < /proc/$(pidof dockerd)/environ | sed -n "s/^PATH=//p"')"
[ -n "$DOCKERD_PATH" ] || { echo "could not read dockerd's PATH on the stand-in host"; exit 1; }

# The host pulls the spool image itself (the host keeps its egress); the probe
# image comes from the outer daemon.
docker save "$PROBE_IMAGE" | docker exec -i "$HOST" docker load >/dev/null
on_host "docker pull -q $SPOOL_IMAGE" >/dev/null

echo "== control, before the fence: the same probe sees a route when there is one"
on_host "docker run -d --name control $SPOOL_IMAGE sleep 600" >/dev/null
expect_ok "a spool-image container on an ordinary bridge reaches the outside" \
    "on_host \"docker exec -i control node - $OUTSIDE_IP 8080 < /work/tcpprobe.js\" >/dev/null 2>&1"
on_host "docker rm -f control" >/dev/null

echo "== host build, as the runbook does it"
on_host "docker volume create branchleft-mail-spool-data >/dev/null &&
    docker run --rm -u 0 -v branchleft-mail-spool-data:/data --entrypoint chown $SPOOL_IMAGE 31000:31000 /data"
on_host "install -d -m 0755 /etc/branchleft /opt/branchleft/mail-spool &&
    printf 'SHIM_DRAIN_TOKEN=%s\n' \"\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')\" >/etc/branchleft/mail-spool.env &&
    chmod 0600 /etc/branchleft/mail-spool.env &&
    cp /work/compose.yml /opt/branchleft/mail-spool/compose.yml"
apply_policy
on_host "cd /opt/branchleft/mail-spool && docker compose --env-file /etc/branchleft/mail-spool.env up -d --wait" >/dev/null
wait_spool_healthy
pass "the spool started from the rendered file and is healthy"

if [ "$SABOTAGE" = open-route ]; then
    echo "== SABOTAGE: open a route off the host (drain network masqueraded, fence jump removed)"
    SUBNET="$(on_host "docker network inspect branchleft-mail-spool-drain -f '{{(index .IPAM.Config 0).Subnet}}'")"
    on_host "iptables -t nat -I POSTROUTING -s $SUBNET -j MASQUERADE && iptables -D DOCKER-USER -j BRANCHLEFT-DEMO-EGRESS"
fi

echo "== no route off the host, asserted from inside the spool's container"
GATEWAY="$(on_host "docker network inspect branchleft-mail-spool-drain -f '{{(index .IPAM.Config 0).Gateway}}'")"
docker exec -d "$HOST" sh -c "while true; do echo ok | nc -l -p 9099 >/dev/null 2>&1; done"
expect_refused "the spool cannot open a connection to a host outside" "spool_connects $OUTSIDE_IP 8080"
expect_refused "the spool cannot open a connection to a service on its own host" "spool_connects $GATEWAY 9099"
if spool_resolves example.com; then
    echo "NOTE: the spool resolved a public name through dockerd's resolver (reported, not asserted; see the .md Limits)"
fi
expect_refused "a slot's Ghost network gives the Ghost no route off the host" \
    "on_slot_network branchleft-mail-30001 python /work/pyconnect.py $OUTSIDE_IP 8080 >/dev/null 2>&1"

echo "== a slot's Ghost submits on both paths; both messages are in the queue"
REGISTER="$(on_host "docker exec $SPOOL_C node dist/cli.js register $DOMAIN --sender-domain $DOMAIN")"
API_KEY="$(echo "$REGISTER" | tail -n 1)"
if [ "$SABOTAGE" = no-spool ]; then
    echo "== SABOTAGE: the spool is gone when Ghost submits"
    on_host "docker stop $SPOOL_C" >/dev/null
fi
# The sabotage sends the bulk message under a different subject: the count
# stays 2, only the identity check can see it.
SENT_HTTP_MARK="$HTTP_MARK"
[ "$SABOTAGE" != wrong-message ] || SENT_HTTP_MARK="$MARK-other"
expect_ok "Ghost's SMTP path (transactional) is accepted" \
    "on_slot_network branchleft-mail-30001 python /work/ghostmail.py $DOMAIN $API_KEY smtp $SMTP_MARK >/dev/null 2>&1"
expect_ok "Ghost's Mailgun-shaped path (bulk) is accepted" \
    "on_slot_network branchleft-mail-30001 python /work/ghostmail.py $DOMAIN $API_KEY http $SENT_HTTP_MARK >/dev/null 2>&1"
if [ "$(queued)" = 2 ]; then pass "the queue holds both messages"; else fail "the queue holds $(queued) messages, not 2"; fi
[ "$SABOTAGE" != no-spool ] || finish

echo "== the drain port"
if [ "$(on_host "docker port $SPOOL_C 8080/tcp")" = "127.0.0.1:$DRAIN_PORT" ]; then
    pass "the drain port is published on host loopback only"
else
    fail "the drain port is published as: $(on_host "docker port $SPOOL_C 8080/tcp")"
fi
CODE="$(on_host "wget -S -q -T 5 -O /dev/null http://127.0.0.1:$DRAIN_PORT/drain 2>&1 | sed -n 's/.*HTTP\/1.[01] \([0-9]*\).*/\1/p' | head -n 1")"
if [ "$CODE" = 401 ]; then pass "the drain endpoint refuses a caller with no token"; else fail "the drain endpoint answered '$CODE' with no token"; fi

echo "== the queue survives a host reboot"
docker restart "$HOST" >/dev/null
wait_dockerd
apply_policy
wait_spool_healthy
if [ "$(queued)" = 2 ]; then pass "both messages are still queued after the reboot"; else fail "after the reboot the queue holds $(queued) messages, not 2"; fi
if [ "$SABOTAGE" != open-route ]; then
    expect_refused "after the reboot the spool still cannot open a connection off the host" "spool_connects $OUTSIDE_IP 8080"
fi

# What a client sees when the spool is not there to answer. Ghost awaits a
# transactional send inside the reader's request, so an error must come back
# in bounded time; this measures the client side only (see the .md Limits).
CLIENT_LIMIT=6
probe_unavailable() {
    on_slot_network branchleft-mail-30001 python /work/ghostprobe.py "$DOMAIN" "$API_KEY" "$CLIENT_LIMIT" 2>&1
}
seconds_of() { echo "$1" | sed -n "s/^$2 .* after \([0-9]*\)\..*/\1/p"; }

echo "== the spool is down: a send fails fast with an error, and no message is dropped or made up"
on_host "docker stop $SPOOL_C" >/dev/null
if OUT="$(probe_unavailable)"; then pass "with the spool down, both paths raise an error"; else fail "with the spool down: $OUT"; fi
echo "$OUT" | sed 's/^/    /'
for path in smtp http; do
    t="$(seconds_of "$OUT" $path)"
    if [ -n "$t" ] && [ "$t" -lt 3 ]; then pass "the $path path failed in under 3s with the spool down"; else fail "the $path path took '${t:-no result}'s with the spool down"; fi
done
on_host "docker start $SPOOL_C" >/dev/null
wait_spool_healthy

echo "== the spool is hung (frozen, still holding its sockets): the client's own timeout is the only bound"
on_host "docker pause $SPOOL_C" >/dev/null
if OUT="$(probe_unavailable)"; then pass "with the spool hung, both paths raise an error"; else fail "with the spool hung: $OUT"; fi
echo "$OUT" | sed 's/^/    /'
for path in smtp http; do
    t="$(seconds_of "$OUT" $path)"
    if [ -n "$t" ] && [ "$t" -ge $((CLIENT_LIMIT - 1)) ] && [ "$t" -le $((CLIENT_LIMIT + 3)) ]; then
        pass "the $path path was cut off by the client's ${CLIENT_LIMIT}s timeout, not by anything in the spool"
    else
        fail "the $path path ended after '${t:-no result}'s, not near the ${CLIENT_LIMIT}s the client allowed"
    fi
done
on_host "docker unpause $SPOOL_C" >/dev/null
wait_spool_healthy
if [ "$(queued)" = 2 ]; then pass "after down and hung, the queue still holds exactly the two messages"; else fail "after down and hung the queue holds $(queued) messages, not 2"; fi

echo "== the queue holds the two messages that were sent, and no others"
WANT="$(printf 'magic link %s\nnewsletter %s\n' "$SMTP_MARK" "$HTTP_MARK")"
GOT="$(queued_subjects || true)"
if [ "$GOT" = "$WANT" ]; then
    pass "the queue's two messages are the SMTP and bulk messages that were sent"
else
    fail "the queue holds [$(echo "$GOT" | tr '\n' ',')] but the sends were [$(echo "$WANT" | tr '\n' ',')]"
fi
echo "== the probe mail is cleared the way the delivery runbook clears it (drain and ack inside the spool's container)"
if on_host "docker exec -i $SPOOL_C node - 2 < /work/drainack.js" >/dev/null 2>&1; then
    pass "draining and acking hands over both probe messages"
else
    fail "draining and acking did not clear both probe messages"
fi
if [ "$(queued)" = 0 ]; then pass "the queue then reads 0"; else fail "after the ack the queue holds $(queued) messages, not 0"; fi

finish
