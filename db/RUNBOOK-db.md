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
versioning and a lifecycle rule set — see "The backup bucket" below.

## The backup bucket

Console-only (no `hcloud` API for Object Storage), one time, before `db.env`
is written. This repo's PR body carries the exact bucket name, location and
S3 credential step with a priced estimate; once it exists, run this
repo's own setup for the versioning/lifecycle layer, from a workstation with
the bucket's S3 credential in the environment (never from `db1`):

```bash
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  python3 db/provision/configure_backup_bucket.py \
  --bucket branchleft-db-backups --endpoint hel1.your-objectstorage.com --region hel1
```

Why this exists alongside the `@@server_uuid`-namespaced object keys
(`dump_nightly.py`, `ship_binlogs.py`): the namespace is the primary defence
against a rebuilt `db1` overwriting a pre-rebuild archive under a reused
name, but versioning is doc 14 §8's independent second layer for every write
this pipeline did not anticipate — a bug in the namespacing, or a manually
re-run dump under a hand-typed key, still lands as a new version rather than
destroying what it replaces. See the script's own docstring for the
35-day noncurrent-version lifetime and why that number.

## 1. Create the socket directory, copy the stack

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 'mkdir -p /opt/branchleft/db/run/mysqld && chmod 777 /opt/branchleft/db/run/mysqld'
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r db/stack/. root@10.20.1.20:/opt/branchleft/db
```

`chmod 777` is deliberate, not sloppy: the directory holds nothing but an
ephemeral socket file, and it is opened by three distinct, unrelated UIDs
(the container's internal `mysql` user, the `mysqld-exporter` container's
user, and root running the host-side scripts below) that share no other
relationship to coordinate a tighter mode around.

## 2. Write `/etc/branchleft/db.env`

Hand-written on the host, as root, and never machine-managed -- the same
convention every other `branchleft-compose@` stack follows. Variable names,
never values:

| Variable                     | Consumed by                              |
| ----------------------------- | ------------------------------------------ |
| `MYSQL_ROOT_PASSWORD`         | `mysql` container, at first start only    |
| `EXPORTER_DATA_SOURCE_NAME`   | `mysqld-exporter` container -- `exporter:PASSWORD@unix(/var/run/mysqld/mysqld.sock)/` form |
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

## 3. Pin the image and start the stack

The first pin is also the first deploy -- there is no separate bootstrap
path, because `branchleft-compose@.service`'s `EnvironmentFile` for the pin
is mandatory:

```bash
branchleft-deploy db mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
systemctl enable --now branchleft-compose@db.service
systemctl status branchleft-compose@db.service
```

Verify the socket and TLS posture from `db1` itself, over the bind-mounted
socket (never `-h 10.20.1.20` -- root has no account reachable that way):

```bash
mysql --socket=/opt/branchleft/db/run/mysqld/mysqld.sock -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "SHOW VARIABLES LIKE 'require_secure_transport'; SHOW VARIABLES LIKE 'have_ssl';"
```

Expect `require_secure_transport = ON` and `have_ssl = YES`. The healthcheck
in `docker compose ps` reaching `healthy` is the same proof from inside the
container -- if it never does, `mysqld-exporter`'s `service_healthy`
dependency will never start it either, and this command is the first thing
to run to see why.

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
-- mysqld-exporter: read-only visibility, nothing else.
CREATE USER 'exporter'@'localhost' IDENTIFIED BY '<matches EXPORTER_DATA_SOURCE_NAME>';
GRANT PROCESS, REPLICATION CLIENT, SELECT ON performance_schema.* TO 'exporter'@'localhost';

-- dump_nightly.py: enough to run mysqldump --all-databases --single-transaction,
-- plus SELECT @@server_uuid (no privilege required, any authenticated user).
CREATE USER 'backup'@'localhost' IDENTIFIED BY '<matches DB_DUMP_MYSQL_PWD>';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, PROCESS, RELOAD ON *.* TO 'backup'@'localhost';

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
   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now branchleft-db-dump.timer branchleft-db-binlog-ship.timer
systemctl list-timers branchleft-db-dump.timer branchleft-db-binlog-ship.timer
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
