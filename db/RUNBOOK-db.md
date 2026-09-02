# Runbook — the db1 MySQL stack

Deploying the shared MySQL 8 host, provisioning a tenant database, and the
restore drill both amendment scenarios on
[branchLeft/workspace#10](https://github.com/branchLeft/workspace/issues/10)
require.

**Connection model, stated once up front because it shapes every step
below:** `root`, `exporter`, `backup` and `replicator` all connect over the
Unix socket bind-mounted out of the mysql container to
`/opt/branchleft/db/run/mysqld/mysqld.sock` on the bare host -- never TCP.
Only the tenant accounts `provision_tenant_db.py` creates connect over TCP
(`10.20.1.20:3306`, TLS-required). `root` in particular has no TCP-reachable
account at all: the official mysql image creates only `'root'@'localhost'`,
which the client library reaches solely via a socket.

## 0. Preconditions

`db1` exists as a Hetzner server (created by `infra/hosts`, private-only,
`10.20.1.20`) but is **base-unprovisioned**: no Docker, no deploy account.
Base-provision it first, exactly as shared-infra's
[`RUNBOOK-provision-host.md`](https://github.com/branchLeft/shared-infra/blob/main/hetzner/RUNBOOK-provision-host.md)
§4 describes for any host with no public address -- through `edge1` as a
jump host. That is a platform-owner-only step (root SSH); this repo's own
PR states the exact command. Confirm it completed before anything below:

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 '
  systemctl is-active fail2ban unattended-upgrades docker &&
  test -x /usr/local/sbin/branchleft-deploy &&
  echo "db1 base-provisioned"
'
```

The backup bucket must also exist before step 2 (`db.env` names it), with
versioning, a lifecycle rule and its fence set — see "The backup bucket" below.

## The backup bucket

> **STOP — the fencing half of this step does not run yet.** A bucket policy
> this repository wrote was accepted by the endpoint and then enforced against
> nobody: neither the key it exempted nor a key it should have denied was
> refused. Whether a bucket policy can fence anything at all on this provider is
> an open question, and `configure_backup_bucket.py` below will refuse to apply
> one until it has been answered.
>
> Answer it first with section 0 of
> [`RUNBOOK-bucket-fencing.md`](../RUNBOOK-bucket-fencing.md) — it is reversible,
> writes no fence, and takes one command. Then follow what its verdict says. On
> every reading but one, no fence is applied to this bucket at all and the
> bucket is left as versioning and the lifecycle rule make it; the estate's
> offsite backups then rest on the project boundary alone, which is a fact for
> the platform owner to decide about rather than something to work around here.
>
> Tracked as branchLeft/workspace#301.

Console-only (no `hcloud` API for Object Storage), one time, before `db.env`
is written. This repo's PR body carries the exact bucket name, location and
S3 credential step with a priced estimate; once it exists, run this repo's own
setup for the versioning, lifecycle and fencing layers, from a workstation with
the **operator's** S3 credential in the environment — not `db1`'s backup
credential, and never from `db1`:

```bash
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --bucket branchleft-db-backups \
  --project-id 15766609 \
  --workload-access-key '<db1 backup key id>' \
  --admin-access-key '<operator key id>' \
  > /tmp/branchleft-db-backups-policy.json

AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  python3 db/provision/configure_backup_bucket.py \
  --bucket branchleft-db-backups --endpoint hel1.your-objectstorage.com --region hel1 \
  --policy-file /tmp/branchleft-db-backups-policy.json
```

**The fence is not optional and there is no flag to skip it.** Every Hetzner
Object Storage key pair is valid for every bucket in its own project by
default, so a backup bucket without a policy is readable and deletable by every
credential in that project. It also cannot be treated as applied until it has
been proven in both directions against the live bucket — a successful
`put-bucket-policy` says nothing, and a single `AccessDenied` says nothing
either. The apply order, the verification, and what to do if the policy locks
the bucket are in
[`RUNBOOK-bucket-fencing.md`](../RUNBOOK-bucket-fencing.md); read its lockout
section before running either command above.

The credential must be the operator's because the fence withholds every
bucket-configuration action from `db1`'s backup key: once it lands, that key
can no longer set versioning or lifecycle, which is the point.

Why this exists alongside the `@@server_uuid`-namespaced object keys
(`dump_nightly.py`, `ship_binlogs.py`): the namespace is the primary defence
against a rebuilt `db1` overwriting a pre-rebuild archive under a reused
name, but versioning is doc 14 §8's independent second layer for every write
this pipeline did not anticipate — a bug in the namespacing, or a manually
re-run dump under a hand-typed key, still lands as a new version rather than
destroying what it replaces. See the script's own docstring for the
35-day noncurrent-version lifetime and why that number.

Versioning and the noncurrent lifecycle only bound how long a *replaced*
object survives. How long a *current* dump or binlog object survives before
this pipeline prunes it is a separate policy -- see "Backup retention"
below, after the timers that enforce it.

## 1. Create the socket directory, copy the stack, install host prerequisites

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 'mkdir -p /opt/branchleft/db/run/mysqld && chmod 777 /opt/branchleft/db/run/mysqld'
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/stack/. root@10.20.1.20:/opt/branchleft/db
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/provision root@10.20.1.20:/opt/branchleft/db/
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 'python3 /opt/branchleft/db/provision/install_host_prereqs.py'
```

`chmod 777` is deliberate, not sloppy: the directory holds nothing but an
ephemeral socket file, and it is opened by three distinct, unrelated UIDs
(the container's internal `mysql` user, the `mysqld-exporter` container's
user, and root running the host-side scripts below) that share no other
relationship to coordinate a tighter mode around.

`db/provision/` must ship alongside `db/stack/`: §5 below copies systemd
units from `/opt/branchleft/db/provision/`, and both units' `ExecStart`
runs scripts from that same path -- nothing else puts it on the host.
`install_host_prereqs.py` then installs what those scripts shell out to
(`age`, and a MySQL-8.0-matched `mysql`/`mysqldump`/`mysqlbinlog` -- see the
script's own docstring for the exact version-pairing constraints); it is
idempotent, so re-running this step against an already-provisioned db1
completes in seconds with no network access at all.

## 2. Write `/etc/branchleft/db.env`

Hand-written on the host, as root, and never machine-managed -- the same
convention every other `branchleft-compose@` stack follows. Variable names,
never values:

| Variable                     | Consumed by                              |
| ----------------------------- | ------------------------------------------ |
| `MYSQL_ROOT_PASSWORD`         | `mysql` container, at first start only    |
| `EXPORTER_MYSQL_PWD`          | `render_exporter_my_cnf.py`, which writes the `mysqld-exporter` container's `.my.cnf` (step 3) |
| `DB_DUMP_MYSQL_PWD`           | `dump_nightly.py` (the `backup` account)  |
| `DB_BINLOG_MYSQL_PWD`         | `ship_binlogs.py` (the `replicator` account) |
| `AGE_RECIPIENT_PUBLIC_KEY`    | both pipelines -- the public half of the escrowed keypair |
| `DB_BACKUP_BUCKET`            | both pipelines                            |
| `DB_BACKUP_ENDPOINT`          | both pipelines                            |
| `DB_BACKUP_REGION`            | both pipelines                            |
| `AWS_ACCESS_KEY_ID`           | both pipelines (Object Storage credential) |
| `AWS_SECRET_ACCESS_KEY`       | both pipelines                            |

```bash
install -m 600 /dev/null /etc/branchleft/db.env
# then edit it in place with the real values
```

**`EXPORTER_MYSQL_PWD` must be at least 20 characters of `A-Za-z0-9._~-` and
nothing else.** The exporter runs Go's `os.ExpandEnv` over every value it
parses out of its `.my.cnf`, so a `$` in the password is silently replaced by
an empty environment variable and the exporter authenticates as a different,
shorter string; `"`, `#`, `;` and `\` are ini syntax to the same parser. Every
one of those leaves the container running and serving `/metrics` while
reporting `mysql_up 0`. `render_exporter_my_cnf.py` refuses the whole class
rather than trying to escape it, so an unacceptable password fails the stack
start with a message naming the variable. Generate one with:

```bash
LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40
```

**Never source this file with `bash` to read a value out of it.** A parse
error makes bash echo the offending line, password included. Read a single
key with `sed -n 's/^VAR=//p'`, or hand the whole file to a command with
`systemd-run --property=EnvironmentFile=/etc/branchleft/db.env`.

## 3. Install the stack's systemd drop-in, pin the image, and start

The drop-in goes on **before** the first start. It adds one `ExecStartPre`
that renders `/etc/branchleft/db-exporter.my.cnf` from `EXPORTER_MYSQL_PWD`,
and the exporter bind-mounts that file. Docker creates a *directory* at a
bind-mount source it cannot find, so a start without the drop-in loaded leaves
a stub directory there. The renderer removes an empty one; a non-empty one it
refuses, and the stack then fails every start until someone clears it by hand.

All three commands run against `db1`, which has no public address -- the same
`$JUMP` hop through `edge1` as every other remote command in this file:

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 \
  'install -d -m 0755 /etc/systemd/system/branchleft-compose@db.service.d'
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" db/systemd/db.override.conf \
  root@10.20.1.20:/etc/systemd/system/branchleft-compose@db.service.d/override.conf
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 'systemctl daemon-reload'
```

It is installed by hand rather than by shared-infra's
`install-systemd-drop-ins.sh`. That script would match this file if pointed at
this checkout, but nothing points it here and no host provisioning run does --
so **a rebuilt db1 does not get this drop-in back**, and this step has to be
repeated as part of any rebuild.

The first pin is also the first deploy -- there is no separate bootstrap
path, because `branchleft-compose@.service`'s `EnvironmentFile` for the pin
is mandatory:

```bash
branchleft-deploy db mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
```

**Expect this first run to fail, and expect it to delete the pin.** The
exporter declares a healthcheck asserting `mysql_up 1`; the unit's
`docker compose up --wait` waits for it; and the `exporter` account does not
exist until step 4. So the restart returns non-zero, and `branchleft-deploy`
-- finding no previous pin to roll back to -- removes
`/etc/branchleft/db.image.env` and reports *"the stack has never run"*.

Two things about that message. It is **wrong about the containers**: a failed
oneshot runs `ExecStopPost`, not `ExecStop`, so MySQL is up with an
initialised data directory. Do not reach for `docker compose down -v` --
that destroys the datadir. And the missing pin means the next `systemctl`
command would fail on the `EnvironmentFile` before reaching anything else.

So the order is: run `branchleft-deploy` once as above, complete **step 4**,
then re-pin and enable:

```bash
branchleft-deploy db mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
systemctl enable --now branchleft-compose@db.service
systemctl status branchleft-compose@db.service
```

That second run is the one that must return zero. From here on, a
`branchleft-deploy db` that returns zero is evidence the exporter is
authenticating against MySQL -- not merely that its process is alive.

Verify the socket and TLS posture from `db1` itself, over the socket inside
the `mysql` container (never `-h 10.20.1.20` -- root has no account
reachable that way, and base provisioning installs no host-side `mysql`
client for this step to assume):

```bash
docker exec -it db-mysql-1 mysql --socket=/var/run/mysqld/mysqld.sock -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "SHOW VARIABLES LIKE 'require_secure_transport'; SHOW VARIABLES LIKE 'have_ssl';"
```

Expect `require_secure_transport = ON` and `have_ssl = YES`. The healthcheck
in `docker compose ps` reaching `healthy` is the same proof from inside the
container -- if it never does, `mysqld-exporter`'s `service_healthy`
dependency will never start it either, and this command is the first thing
to run to see why.

### Migrating a db1 that is already running

An already-provisioned host has none of the three preconditions above, and
**the wrong order is an outage rather than an error message**: `systemctl
restart` on an active `RemainAfterExit=yes` unit runs `ExecStop=docker compose
down` first, so MySQL stops, and the start then fails at `ExecStartPre` with
nothing to fall back to. Do all four before restarting anything.

1. **Copy both the provisioning and the stack directory.** They are two
   separate hand-delivered paths and both changed: `render_exporter_my_cnf.py`
   is new and the drop-in's `ExecStartPre` runs it by absolute path, and the
   compose file is what stops requiring `EXPORTER_DATA_SOURCE_NAME`.

   ```bash
   JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
   scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/provision root@10.20.1.20:/opt/branchleft/db/
   scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/stack/. root@10.20.1.20:/opt/branchleft/db
   ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 \
     'grep -c DATA_SOURCE_NAME /opt/branchleft/db/compose.yml'
   ```

   **That `grep` must print `0` before you go on.** Copying only the
   provisioning half leaves the old compose file in place, and step 3 below
   removes the variable it still requires -- so the restart fails on its `:?`
   guard with the stack half-migrated. The trailing `/.` is load-bearing and
   the destination takes no trailing slash.

2. **Decide whether the existing password survives the new rule.** The old DSN
   form only forbade `@`, `:` and `/`; the rule in step 2 forbids everything
   outside `A-Za-z0-9._~-` and sets a 20-character floor, so a password
   generated under the old rule may contain a character that is now fatal.
   Check without printing it:

   ```bash
   sed -n 's/^EXPORTER_DATA_SOURCE_NAME=exporter:\(.*\)@unix(.*/\1/p' /etc/branchleft/db.env \
     | grep -cE '^[A-Za-z0-9._~-]{20,}$'
   ```

   `1` means it survives; `0` means rotate it in step 3.

3. **Set `EXPORTER_MYSQL_PWD` in `/etc/branchleft/db.env`.** If step 2 printed
   `1`, carry the existing value across without printing it:

   ```bash
   sed -n 's/^EXPORTER_DATA_SOURCE_NAME=exporter:\(.*\)@unix(.*/EXPORTER_MYSQL_PWD=\1/p' \
     /etc/branchleft/db.env >> /etc/branchleft/db.env
   ```

   If it printed `0`, rotate instead -- generate a new password, write
   `EXPORTER_MYSQL_PWD=` with it, and change it in MySQL to match (see
   "Rotating the exporter password" below). Then delete the
   `EXPORTER_DATA_SOURCE_NAME` line either way: nothing reads it, and it is a
   password sitting in a file for no reason.

   Confirm by key name only, never by value:

   ```bash
   cut -d= -f1 /etc/branchleft/db.env | sort
   ```

4. **Install the drop-in** exactly as in the three commands above.

Only then:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 \
  'systemctl restart branchleft-compose@db && docker ps --filter label=com.docker.compose.project=db --format "{{.Names}}\t{{.Status}}"'
```

Expect `db-mysql-1` and `db-mysqld-exporter-1`, both `Up ... (healthy)`. The
exporter's `start_period` is 60s, so read this again before concluding
anything from a `starting`.

### Rotating the exporter password

Three places must agree, and the account is reachable only over the socket:

```bash
# 1. generate, and set it in MySQL. MYSQL_PWD keeps the root password out of
#    the host's process list; the new value is typed, never echoed.
NEW=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40)
docker exec -i -e MYSQL_PWD="$(sed -n 's/^MYSQL_ROOT_PASSWORD=//p' /etc/branchleft/db.env)" \
  db-mysql-1 mysql --socket=/var/run/mysqld/mysqld.sock -uroot \
  -e "ALTER USER 'exporter'@'localhost' IDENTIFIED BY '$NEW'; FLUSH PRIVILEGES;"

# 2. put the same value in db.env, replacing any existing line
sed -i '/^EXPORTER_MYSQL_PWD=/d' /etc/branchleft/db.env
printf 'EXPORTER_MYSQL_PWD=%s\n' "$NEW" >> /etc/branchleft/db.env
unset NEW

# 3. re-render and restart -- the drop-in's ExecStartPre does the render
systemctl restart branchleft-compose@db
```

Verify with `docker ps`: `db-mysqld-exporter-1` reaching `(healthy)` is the
proof, because the healthcheck asserts `mysql_up 1` and nothing else does.

## 4. One-time admin bootstrap: the exporter, dump and binlog-ship accounts

Run once, over the same socket, as root:

```bash
mysql --socket=/opt/branchleft/db/run/mysqld/mysqld.sock -uroot -p"$MYSQL_ROOT_PASSWORD"
```

Then, at the `mysql>` prompt -- every account below is scoped to `@'localhost'`
and therefore only ever reachable over this same socket, matching how each
script connects. These three accounts are least-privilege by design -- none
of them can read tenant data, and none of them is the account tenant
provisioning creates:

```sql
-- mysqld-exporter: read-only visibility, nothing else. PROCESS and
-- REPLICATION CLIENT exist only at global scope and cannot be combined with
-- a database-scoped grant in one statement (MySQL rejects it with
-- ERROR 1221) -- SELECT stays scoped to performance_schema in its own grant.
CREATE USER 'exporter'@'localhost' IDENTIFIED BY '<matches EXPORTER_MYSQL_PWD>';
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'exporter'@'localhost';
GRANT SELECT ON performance_schema.* TO 'exporter'@'localhost';

-- dump_nightly.py: enough to run mysqldump --all-databases --single-transaction
-- --source-data=2 (the last of which runs SHOW MASTER STATUS, hence
-- REPLICATION CLIENT below), plus SELECT @@server_uuid (no privilege
-- required, any authenticated user).
CREATE USER 'backup'@'localhost' IDENTIFIED BY '<matches DB_DUMP_MYSQL_PWD>';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, PROCESS, RELOAD, REPLICATION CLIENT ON *.* TO 'backup'@'localhost';

-- ship_binlogs.py: enough for `mysqlbinlog --read-from-remote-server` and
-- `FLUSH BINARY LOGS`, nothing more.
CREATE USER 'replicator'@'localhost' IDENTIFIED BY '<matches DB_BINLOG_MYSQL_PWD>';
GRANT REPLICATION SLAVE, REPLICATION CLIENT, RELOAD ON *.* TO 'replicator'@'localhost';

FLUSH PRIVILEGES;
```

## 5. Enable the backup timers

```bash
cp /opt/branchleft/db/provision/branchleft-db-dump.{service,timer} \
   /opt/branchleft/db/provision/branchleft-db-binlog-ship.{service,timer} \
   /opt/branchleft/db/provision/branchleft-db-prune.{service,timer} \
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now branchleft-db-dump.timer branchleft-db-binlog-ship.timer branchleft-db-prune.timer
systemctl list-timers branchleft-db-dump.timer branchleft-db-binlog-ship.timer branchleft-db-prune.timer
```

Force one of each once, to prove the pipeline end to end before waiting for
the schedule:

```bash
systemctl start branchleft-db-dump.service
systemctl start branchleft-db-binlog-ship.service
journalctl -u branchleft-db-dump.service -u branchleft-db-binlog-ship.service -n 40
```

Expect `wrote dumps/<server-uuid>/db1-...sql.age` and `shipped N log(s)` (or
`(none pending)` on a very first run before any binlog has closed). Note the
`<server-uuid>` segment printed here -- it is `db1`'s current incarnation and
is what every object key for this incarnation is namespaced under; the
restore drill below needs it to find the right objects.

**Do not force `branchleft-db-prune.service` on a first setup** -- there
is nothing to prune yet, and running it against a brand-new bucket is a no-op
at best. See "Backup retention" below for how to bring it onto an
already-running `db1`.

## Backup retention

Nothing before this pruned a *current* object: dumps and shipped binlogs
otherwise accumulate forever, growing storage linearly with the size and age
of the dataset even though object versioning (above) already bounds how long
a *replaced* object survives. `prune_backups.py` is the enforcement point,
run daily by `branchleft-db-prune.timer` (03:45 UTC, after that
night's dump and at least one more binlog-ship run have landed).

**The numbers, and where they come from.** Doc 14 §7.2 states the platform's
service level as "7-day point-in-time recovery for the tenant database" --
`prune_backups.PITR_WINDOW_DAYS = 7` is that promise, verbatim, and is not a
value to change without re-deciding the promise itself.
`prune_backups.MARGIN_DAYS = 3` is slack for the pipeline's own operational
hiccups (a missed nightly dump, a slow investigation) before an object
becomes eligible for deletion at all -- it does not weaken the guarantee
below, it only decides how proactively pruning happens.

**The invariant `plan_prune` holds, regardless of MARGIN_DAYS:** the oldest
*retained* dump for a given `server_uuid`, plus the retained binlogs from its
timestamp forward, must always cover the full 7-day window. The **anchor** --
the newest dump at or before `now - 7 days` -- is never deleted, however old
it ends up being; a run of missed or failed nightly dumps just pushes the
anchor further back, and `plan_prune` keeps it there rather than deleting on
a blind age threshold that cannot see whether a replacement dump exists.
Binlogs are kept back to the anchor's own timestamp (or `RETENTION_DAYS`,
whichever is older), and only ever as a clean prefix by binlog sequence
number -- never a hole partway through what's retained. A `server_uuid`
group that cannot be pruned without the retained set falling short of the
window is refused outright (logged to stderr, nothing in that group
deleted) rather than pruned partway. See `plan_prune`'s own docstring and
`test_prune_backups.py` for the full set of edge cases this covers -- a
missed dump, a dump that failed mid-run (identical to a missed one: a failed
run never uploads anything), a binlog rotation straddling the cutoff second,
a forced refusal when coverage would otherwise be lost, and an unparseable
binlog name refusing only its own incarnation rather than blocking every
other `server_uuid` in the same run.

**Why a bucket lifecycle rule instead of this pipeline step was rejected.**
Doc 14 §16 item 3 already documents `Expiration.Days` (current-object,
day-based expiry) as a real Hetzner Object Storage feature, so the mechanism
exists. It was rejected anyway because a lifecycle rule deletes strictly by
object age, per object, with no way to ask "does a newer dump already cover
what this one would leave uncovered?" -- exactly the question a missed
nightly dump makes load-bearing. A pipeline step that reads the bucket's own
listing before deciding is the only shape that can hold the invariant above.

**Bringing the timer onto an already-live `db1`.** Re-copy `db/provision/`
(step 1) so `prune_backups.py`, the extended `objectstorage.py` and the two
new unit files land, then dry-run before ever deleting anything real:

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/provision root@10.20.1.20:/opt/branchleft/db/
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 '
  systemd-run --pipe --wait --collect --quiet \
    --property=EnvironmentFile=/etc/branchleft/db.env \
    --property=WorkingDirectory=/opt/branchleft/db/provision \
    -- python3 prune_backups.py --dry-run
'
```

As step 2 warns: never `bash`-source `db.env` to run this. `systemd-run`'s
`EnvironmentFile=` loads it the same way the compose units do -- parsed as
`KEY=value` pairs, never evaluated as shell -- so a stray character in a
value cannot make anything echo it back.

Read the output before doing anything else: `would delete N dump(s), M
binlog(s)` lists every key by name, and a `REFUSED <uuid>: <reason>` line on
stderr means don't proceed for that incarnation until the reason is
understood -- proceeding anyway is exactly the silent-gap failure mode this
script exists to prevent. **This first real run is expected to take
noticeably longer than every run after it**: the bucket has never been
pruned before, so the backlog is plausibly an order of magnitude above a
normal day's surplus, and `objectstorage.py` opens one connection per
object with no pooling. `branchleft-db-prune.service`'s `TimeoutStartSec=3600`
is sized for that first run, not steady state -- a run taking most of an
hour on this first invocation is expected and harmless, not a stall to
interrupt. Only once the dry run looks right:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 '
  cp /opt/branchleft/db/provision/branchleft-db-prune.{service,timer} /etc/systemd/system/ &&
  systemctl daemon-reload &&
  systemctl enable --now branchleft-db-prune.timer &&
  systemctl start branchleft-db-prune.service &&
  journalctl -u branchleft-db-prune.service -n 40
'
```

**Proving the window is still covered after a prune.** The dry run's own
absence of a `REFUSED` line is the pruner's own proof, but to check the
retained bucket state directly rather than trust the tool that just acted on
it, run its `--verify-coverage` mode -- it re-lists the bucket, groups by
`server_uuid` (never a bucket-wide mix of a live incarnation's numbers with a
dead one's), and reports each incarnation's oldest retained dump and oldest
retained binlog independently:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 '
  systemd-run --pipe --wait --collect --quiet \
    --property=EnvironmentFile=/etc/branchleft/db.env \
    --property=WorkingDirectory=/opt/branchleft/db/provision \
    -- python3 prune_backups.py --verify-coverage
'
```

Exits `0` with `coverage check passed for every server_uuid` when every
incarnation's `status` is `covered` -- its oldest retained binlog is at or
before its oldest retained dump's own timestamp, so replay from that dump has
something to resume from all the way back to the window's edge. A `gap`
status means the opposite: nothing to resume from partway through the window,
which is the failure mode this whole design exists to make structurally
impossible, and is worth stopping on immediately. `no dump` or `no binlog`
report the two narrower cases separately, since they read differently to an
operator: `no dump` means the incarnation has nothing to restore *from* at
all, while `no binlog` on an incarnation less than ~15 minutes old is
expected and harmless (its first binlog hasn't shipped yet).

## 6. Provision a tenant database

```bash
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" python3 /opt/branchleft/db/provision/provision_tenant_db.py --admin-user root <tenant-name>
```

Connects over the same socket by default (`--socket` overrides it, though
there is normally no reason to). Prints the generated password exactly
once, to stdout, on first creation. Re-running against an existing tenant
reapplies grants and `MAX_USER_CONNECTIONS` without changing the password --
see the script's own docstring.

---

## Restore drill

Both scenarios below are a **parity gate**, not a hope: doc 14 §7.2 states
that a shared-instance restore is instance-level (every tenant's database
comes back together), and that stays true here. Run both after any change
to the dump or binlog-shipping pipeline, and log the outcome in this repo's
PR or issue history rather than only in a terminal.

Object keys carry `db1`'s current `@@server_uuid` (printed by every
`dump_nightly`/`ship_binlogs` run, and readable any time with
`SELECT @@server_uuid;` over the socket) -- both drills below need it to
find the right objects. **In Drill B this value cannot be read from a live
`db1`, because the scenario's premise is that it is gone**; the account
holding the escrowed age key is expected to also have a record of the
current `server_uuid` for exactly this reason. Note it down whenever it
changes (a first deploy, or a real rebuild), alongside the escrow entry.

### Drill A -- in-window PITR (db1's disk survives)

1. Pick a target timestamp between the last nightly dump and now.
2. Download the latest dump and every binlog shipped since it:
   ```bash
   # object keys: dumps/<server-uuid>/db1-<timestamp>.sql.age,
   #              binlogs/<server-uuid>/db1-<logname>.age
   ```
3. Decrypt each with the escrowed **private** age key (never copied to
   `db1` itself -- restore onto a scratch host or container):
   ```bash
   age -d -i age-private-key.txt -o dump.sql "dumps/<server-uuid>/db1-<timestamp>.sql.age"
   age -d -i age-private-key.txt -o mysql-bin.NNNNNN "binlogs/<server-uuid>/db1-mysql-bin.NNNNNN.age"
   ```
4. Load the dump, then replay binlog events up to the target timestamp. The
   dump's header (from `--source-data=2`) names the exact `MASTER_LOG_FILE`/
   `MASTER_LOG_POS` to resume from:
   ```bash
   mysql --host <scratch-host> -uroot -p < dump.sql
   mysqlbinlog --start-position=<pos-from-dump-header> --stop-datetime="<target timestamp>" mysql-bin.NNNNNN | mysql --host <scratch-host> -uroot -p
   ```
5. Confirm a row known to have changed after the dump and before the target
   timestamp is present, and that nothing after the target timestamp is.

### Drill B -- host loss (dump-only recovery, no binlogs available)

Proves the amendment's second criterion: recovery still works when db1's
disk -- and every un-shipped binlog on it -- is gone.

1. Provision a **fresh** scratch host (never `db1` itself) with MySQL 8 and
   nothing else.
2. Retrieve the escrowed age **private** key, and the last-recorded
   `server_uuid`, from their escrow location (the password manager entry,
   per step 7 below) -- not from any copy on a branchLeft host, since the
   drill's premise is that db1 is gone.
3. Download only the latest dump from Object Storage (no binlogs -- this is
   the scenario where none were shipped in time, or the bucket's binlog
   objects are also treated as unavailable).
4. Decrypt with the retrieved key and load it:
   ```bash
   age -d -i age-private-key.txt -o dump.sql "dumps/<server-uuid>/db1-<latest-timestamp>.sql.age"
   mysql --host <scratch-host> -uroot -p < dump.sql
   ```
5. Confirm every tenant database and its data as of the dump's timestamp is
   present. State the achieved RPO plainly in the drill log: the gap between
   the dump timestamp and the moment of loss, which is what this scenario
   actually delivers -- not the PITR-to-any-moment property Drill A proves.

**Step 2 is the part that must not be skipped or faked.** A drill that
decrypts using a key copied from `db1` or from a developer's own agent
session proves nothing about whether the *escrowed* copy is the one that
actually decrypts a real artifact -- which is exactly the failure mode
[branchLeft/workspace#172](https://github.com/branchLeft/workspace/issues/172)
exists to close. Retrieve it the way an operator recovering from a real
loss would: from the password-manager entry, cold.

## 7. Escrowing the age keypair

Minted once, by the platform owner, before the pipelines are enabled (§5
above needs `AGE_RECIPIENT_PUBLIC_KEY` to already exist):

```bash
age-keygen -o age-key.txt
grep 'public key:' age-key.txt   # -> AGE_RECIPIENT_PUBLIC_KEY for db.env
```

Store `age-key.txt` (the private half) as its own entry in the password
manager -- the same discipline the stack passphrases already get. Then
delete the local file. Never place the private key on `db1`, or on any
branchLeft host: every pipeline here only ever needs the **public** half.
