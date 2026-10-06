#!/usr/bin/env bash
# Builds the replica tunnel end to end in throwaway containers, then breaks
# each control and shows the probe go red. Never touches a real host.
# See prove-replica-tunnel.md for the topology, the steps and the sabotages.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
: "${SHARED_INFRA_DIR:?set SHARED_INFRA_DIR to a branchLeft/shared-infra checkout}"
CLIENT_DIR="$SHARED_INFRA_DIR/hetzner/provision"
[[ -f "$CLIENT_DIR/45-install-db-tunnel.sh" ]] || { echo "no db1 installer under $CLIENT_DIR" >&2; exit 2; }

SOURCE_IMAGE="${SOURCE_IMAGE:-mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b}"
REPLICA_IMAGE="${REPLICA_IMAGE:-percona/percona-server@sha256:a4ba7d1afd325f40bc6d65b6455fb4f15388638dfa39e3b85f9755755fd9ec2d}"
EXPORTER_IMAGE="${EXPORTER_IMAGE:-prom/mysqld-exporter:v0.20.0@sha256:abed8dac117b4ae5b70757f988e44795935b9a72c3b58d720c67ba688f8cb79e}"
LAB_IMAGE="branchleft-tunnel-lab:proof"
P="tunnelproof"
DB1_ORG_IP="10.20.1.20"
DB1_WAN_IP="203.0.113.20"
DBT1_WAN_IP="203.0.113.30"
PW="proof-only-$RANDOM$RANDOM"
WORK="$(mktemp -d)"

step() { printf '\n== %s\n' "$*"; }
die() { echo "PROOF FAILED: $*" >&2; exit 1; }

cleanup() {
    local rc=$?
    if [[ "$rc" -ne 0 ]]; then
        docker exec "$P-db1-client" journalctl -u branchleft-db-tunnel.service --no-pager -n 20 || true
        if [[ "${KEEP_ON_FAILURE:-0}" == 1 ]]; then return; fi
    fi
    docker rm -f "$P-exporter" "$P-replica" "$P-dbt1" "$P-db1-client" "$P-db1" >/dev/null 2>&1 || true
    docker network rm "$P-org" "$P-wan" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

db1_sql() { docker exec -i "$P-db1" mysql -uroot -p"$PW" -N -B "$@" 2>/dev/null; }
replica_sql() { docker exec -i "$P-replica" mysql -uroot -p"$PW" -N -B "$@" 2>/dev/null; }
on_db1() { docker exec "$P-db1-client" "$@"; }
on_dbt1() { docker exec "$P-dbt1" "$@"; }

wait_for() {
    local what="$1" tries="$2"
    shift 2
    for _ in $(seq "$tries"); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    die "timed out waiting for $what"
}

replica_field() {
    docker exec -i "$P-replica" mysql -uroot -p"$PW" -e "SHOW REPLICA STATUS\G" 2>/dev/null \
        | awk -v f="$1:" '$1 == f { print $2 }'
}

probes_key_holder() {
    on_db1 bash /opt/tunnel/probe_tunnel_controls.sh key-holder --host "$DBT1_WAN_IP" \
        --key /etc/branchleft/db-tunnel/id_ed25519 --known-hosts /etc/branchleft/db-tunnel/known_hosts
}

probes_direct_dial() {
    on_dbt1 bash /opt/tunnel/probe_tunnel_controls.sh direct-dial \
        --target "$DB1_ORG_IP:3306" --target "$DB1_WAN_IP:3306"
}

expect_green() {
    local label="$1"
    shift
    if "$@"; then echo ">> GREEN ($label)"; else die "$label: expected every probe to pass"; fi
}

expect_red() {
    local label="$1"
    shift
    if "$@"; then die "$label: the sabotage did not turn any probe red"; else echo ">> RED ($label)"; fi
}

reinstall_account() {
    on_dbt1 usermod -s /usr/sbin/nologin dbtunnel 2>/dev/null
    on_dbt1 python3 /opt/tunnel/tunnel_account.py install \
        --public-key-file /root/db1-tunnel.pub --from-address "$DB1_WAN_IP" >/dev/null
}

widen_key() { on_dbt1 sed -i "s|$1|$2|" /etc/branchleft/db-tunnel/authorized_keys; }

widen_sshd() {
    on_dbt1 sed -i "s|$1|$2|" /etc/ssh/sshd_config.d/60-branchleft-db-tunnel.conf
    on_dbt1 systemctl reload ssh
}

step "Lab image and networks"
docker build -q -t "$LAB_IMAGE" -f "$HERE/proof/lab.Dockerfile" "$HERE/proof" >/dev/null
docker network create --subnet 10.20.1.0/24 --internal "$P-org" >/dev/null
docker network create --subnet 203.0.113.0/24 "$P-wan" >/dev/null

step "db1: MySQL with the committed branchleft.cnf, bound to $DB1_ORG_IP only"
docker run -d --name "$P-db1" --network "$P-org" --ip "$DB1_ORG_IP" -e MYSQL_ROOT_PASSWORD="$PW" \
    -v "$REPO_ROOT/db/stack/conf.d:/etc/mysql/conf.d:ro" "$SOURCE_IMAGE" >/dev/null
docker network connect --ip "$DB1_WAN_IP" "$P-wan" "$P-db1"
docker run -d --name "$P-db1-client" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --network "container:$P-db1" \
    -v "$CLIENT_DIR:/opt/provision:ro" -v "$HERE:/opt/tunnel:ro" "$LAB_IMAGE" /sbin/init >/dev/null
wait_for "db1 MySQL on its TCP listener" 90 on_db1 bash -c "exec 3<>/dev/tcp/$DB1_ORG_IP/3306"
db1_sql -e "SELECT VERSION(), @@bind_address, @@require_secure_transport"

step "db-t1: sshd, the Percona replica and its exporter on loopback"
docker run -d --name "$P-dbt1" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --network "$P-wan" --ip "$DBT1_WAN_IP" -v "$HERE:/opt/tunnel:ro" "$LAB_IMAGE" /sbin/init >/dev/null
docker run -d --name "$P-replica" --network "container:$P-dbt1" -e MYSQL_ROOT_PASSWORD="$PW" \
    "$REPLICA_IMAGE" --server-id=2 --relay-log=relay-bin --read-only=ON >/dev/null
wait_for "replica MySQL on its TCP listener" 120 on_dbt1 bash -c "exec 3<>/dev/tcp/127.0.0.1/3306"
replica_sql -e "CREATE USER 'exporter'@'127.0.0.1' IDENTIFIED BY '$PW';
    GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'exporter'@'127.0.0.1';"
printf '[client]\nuser=exporter\npassword=%s\n' "$PW" > "$WORK/exporter.my.cnf"
chmod 0644 "$WORK/exporter.my.cnf"
docker run -d --name "$P-exporter" --network "container:$P-dbt1" \
    -v "$WORK/exporter.my.cnf:/cnf/.my.cnf:ro" "$EXPORTER_IMAGE" \
    --config.my-cnf=/cnf/.my.cnf --mysqld.address=127.0.0.1:3306 \
    --web.listen-address=127.0.0.1:9104 >/dev/null
wait_for "db-t1 sshd" 30 on_dbt1 systemctl is-active ssh

step "db1: keygen (shared-infra 45-install-db-tunnel.sh)"
wait_for "db1 systemd" 30 on_db1 systemctl is-active basic.target
on_db1 env DB_TUNNEL_SUBNET_PREFIX=10.20.1. bash /opt/provision/45-install-db-tunnel.sh keygen \
    | tee "$WORK/keygen.out"
tail -n1 "$WORK/keygen.out" > "$WORK/db1-tunnel.pub"
docker cp "$WORK/db1-tunnel.pub" "$P-dbt1:/root/db1-tunnel.pub"

step "db-t1: the tunnel account (ghost-platform tunnel_account.py)"
on_dbt1 python3 /opt/tunnel/tunnel_account.py install \
    --public-key-file /root/db1-tunnel.pub --from-address "$DB1_WAN_IP" | tee "$WORK/account.out"
HOST_KEY="$(sed -n 's/^tunnel_account: host key to pin on the dialling side: //p' "$WORK/account.out")"
[[ -n "$HOST_KEY" ]] || die "the account installer printed no host key"

step "db1: install and start branchleft-db-tunnel.service"
on_db1 bash /opt/provision/45-install-db-tunnel.sh install "$DBT1_WAN_IP" "$HOST_KEY"
wait_for "tunnel listener on db-t1" 30 on_dbt1 bash -c "ss -ltnH | grep -q '127.0.0.1:13306'"
on_db1 systemctl --no-pager --lines=0 status branchleft-db-tunnel.service | head -n 3

step "db-t1 127.0.0.1:13306 answers with db1's MySQL handshake"
greeting="$(on_dbt1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/13306; head -c 80 <&3 | tr -c "[:print:]" "."')"
echo "greeting: $greeting"
[[ "$greeting" == *"8.0."* ]] || die "no MySQL handshake on db-t1's loopback"

step "The only cross-estate TCP connection was opened by db1"
echo "db-t1 listeners:"
on_dbt1 ss -ltnH
echo "db-t1 established:"
on_dbt1 ss -tnH state established '( sport = :22 )'
echo "db1 established to db-t1:"
on_db1 ss -tnH state established dst "$DBT1_WAN_IP"

step "Replication through the tunnel, TLS, account host part proven"
db1_sql -e "CREATE DATABASE blog; CREATE TABLE blog.posts (id INT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(64));
    CREATE USER 'repl'@'$DB1_ORG_IP' IDENTIFIED BY '$PW' REQUIRE SSL;
    GRANT REPLICATION SLAVE ON *.* TO 'repl'@'$DB1_ORG_IP';"
read -r BINLOG_FILE BINLOG_POS < <(db1_sql -e "SHOW MASTER STATUS" | awk '{print $1, $2}')
replica_sql -e "CREATE DATABASE blog; CREATE TABLE blog.posts (id INT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(64));
    CHANGE REPLICATION FILTER REPLICATE_WILD_DO_TABLE = ('blog.%');
    CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=13306, SOURCE_USER='repl',
      SOURCE_PASSWORD='$PW', SOURCE_SSL=1, SOURCE_LOG_FILE='$BINLOG_FILE', SOURCE_LOG_POS=$BINLOG_POS;
    START REPLICA;"
db1_sql -e "INSERT INTO blog.posts (title) VALUES ('before-outage');"
wait_for "replica threads Yes" 30 bash -c "[[ \"\$(docker exec $P-replica mysql -uroot -p$PW -N -B -e 'SELECT COUNT(*) FROM blog.posts' 2>/dev/null)\" == 1 ]]"
echo "IO=$(replica_field Replica_IO_Running) SQL=$(replica_field Replica_SQL_Running) SSL=$(replica_field Source_SSL_Allowed)"
echo "db1 sees the replication session from:"
db1_sql -e "SELECT HOST FROM information_schema.PROCESSLIST WHERE USER='repl'"
db1_sql -e "SELECT VARIABLE_VALUE FROM performance_schema.status_by_thread s JOIN performance_schema.threads t USING (THREAD_ID) WHERE t.PROCESSLIST_USER='repl' AND VARIABLE_NAME='Ssl_version'"

step "Metrics forward: db-t1's exporter read on db1's $DB1_ORG_IP:9105"
on_db1 curl -fsS "http://$DB1_ORG_IP:9105/metrics" > "$WORK/metrics.txt"
grep -E '^mysql_(up|slave_status_(slave_io_running|slave_sql_running|seconds_behind_master))[ {]' "$WORK/metrics.txt" \
    || die "the exporter published no replica status through the forward"

step "Outage: stop the tunnel, write on db1, restart, nothing lost"
on_db1 systemctl stop branchleft-db-tunnel.service
db1_sql -e "INSERT INTO blog.posts (title) VALUES ('during-outage');"
sleep 15
echo "during outage: IO=$(replica_field Replica_IO_Running) lag=$(replica_field Seconds_Behind_Source)"
if on_db1 curl -fsS -m 5 "http://$DB1_ORG_IP:9105/metrics" >/dev/null 2>&1; then
    die "the metrics forward still answered with the tunnel stopped"
fi
echo "metrics forward refused while the tunnel is down (the scrape that ReplicaTunnelDown reads)"
on_db1 systemctl start branchleft-db-tunnel.service
wait_for "replica caught up" 60 bash -c "[[ \"\$(docker exec $P-replica mysql -uroot -p$PW -N -B -e 'SELECT COUNT(*) FROM blog.posts' 2>/dev/null)\" == 2 ]]"
echo "after restore: IO=$(replica_field Replica_IO_Running) rows=$(replica_sql -e 'SELECT GROUP_CONCAT(title) FROM blog.posts')"

step "Self-restart: kill ssh outright, systemd brings it back"
before="$(on_db1 systemctl show -p NRestarts --value branchleft-db-tunnel.service)"
on_db1 systemctl kill -s KILL branchleft-db-tunnel.service
wait_for "restart" 30 bash -c "[[ \"\$(docker exec $P-db1-client systemctl show -p NRestarts --value branchleft-db-tunnel.service)\" -gt $before ]]"
wait_for "listener back" 30 on_dbt1 bash -c "ss -ltnH | grep -q '127.0.0.1:13306'"
echo "NRestarts $before -> $(on_db1 systemctl show -p NRestarts --value branchleft-db-tunnel.service)"

step "Control cases, all green"
expect_green "baseline key-holder probes" probes_key_holder
expect_green "baseline direct-dial probes" probes_direct_dial

step "Sabotage: widen permitopen (key, then sshd, then both)"
widen_key 'permitopen="127.0.0.1:9104"' 'permitopen="127.0.0.1:9104",permitopen="127.0.0.1:22"'
expect_green "key layer widened, sshd layer still refuses" probes_key_holder
reinstall_account
widen_sshd 'PermitOpen 127.0.0.1:9104' 'PermitOpen 127.0.0.1:9104 127.0.0.1:22'
expect_green "sshd layer widened, key layer still refuses" probes_key_holder
widen_key 'permitopen="127.0.0.1:9104"' 'permitopen="127.0.0.1:9104",permitopen="127.0.0.1:22"'
expect_red "both layers widened" probes_key_holder
reinstall_account
on_dbt1 systemctl reload ssh
expect_green "reverted" probes_key_holder

step "Sabotage: widen permitlisten on both layers"
widen_key 'permitlisten="127.0.0.1:13306"' 'permitlisten="127.0.0.1:13306",permitlisten="127.0.0.1:13307"'
widen_sshd 'PermitListen 127.0.0.1:13306' 'PermitListen 127.0.0.1:13306 127.0.0.1:13307'
expect_red "listen widened" probes_key_holder
reinstall_account
on_dbt1 systemctl reload ssh
expect_green "reverted" probes_key_holder

step "Sabotage: give the key a shell (login shell, then ForceCommand, then both)"
on_dbt1 usermod -s /bin/bash dbtunnel
expect_green "login shell set, ForceCommand still refuses" probes_key_holder
reinstall_account
widen_sshd '    ForceCommand /usr/sbin/nologin' ''
expect_green "ForceCommand removed, nologin still refuses" probes_key_holder
on_dbt1 usermod -s /bin/bash dbtunnel
expect_red "both removed" probes_key_holder
reinstall_account
on_dbt1 systemctl reload ssh
expect_green "reverted" probes_key_holder

step "Sabotage: give db-t1 a route into db1's network"
docker network connect "$P-org" "$P-dbt1"
expect_red "db-t1 can reach db1 directly" probes_direct_dial
docker network disconnect "$P-org" "$P-dbt1"
expect_green "reverted" probes_direct_dial

step "Replication still healthy after every sabotage"
db1_sql -e "INSERT INTO blog.posts (title) VALUES ('after-sabotage');"
wait_for "final row" 60 bash -c "[[ \"\$(docker exec $P-replica mysql -uroot -p$PW -N -B -e 'SELECT COUNT(*) FROM blog.posts' 2>/dev/null)\" == 3 ]]"
echo "IO=$(replica_field Replica_IO_Running) SQL=$(replica_field Replica_SQL_Running) rows=3"

printf '\nALL PASSED\n'
