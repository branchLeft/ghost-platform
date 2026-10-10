# ship_binlogs.py

## Module overview

Ships every closed binary log db1 is holding to Object Storage.

Run frequently (every 15 minutes, via `branchleft-db-binlog-ship.timer`) so
the RPO on host loss stays close to that interval rather than the 24h a
dump-only design would otherwise leave. `FLUSH BINARY LOGS` rotates to a
fresh file on every run, so the log that was open a moment ago becomes
closed and shippable on the very next run; nothing here ever reads from the
file MySQL is currently writing.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in `db/stack/compose.yml`) as the dedicated
`replicator`@`localhost` account -- never TCP.

A local marker file (`--marker-path`, default under
`/var/lib/branchleft-db-binlog-ship/`) records the server incarnation
(`@@server_uuid`) and name of the last binlog shipped, so a run resumes
exactly where the previous one stopped rather than re-shipping or skipping.
The incarnation is part of the marker, not just the name, because MySQL
mints a fresh `server_uuid` whenever its data directory is created from
scratch, and binlog numbering restarts from `mysql-bin.000001` at the same
time -- a marker naming a log from a *previous* incarnation could otherwise
coincidentally match a same-named log the new incarnation reaches later,
silently skipping everything shipped in between. Object keys carry the same
incarnation prefix for the mirror-image reason: two incarnations' same-named
logs must never resolve to the same object.

`mysqlbinlog --raw --read-from-remote-server` reads the byte-identical file
over the replication protocol, which is what makes this possible with no
filesystem access to the `mysql-data` volume at all -- this script never
runs inside the MySQL container and never needs to.

## Run status

Every run ends by writing `ship_binlogs_status.prom` to `DB_BINLOG_METRICS_DIR`
(default `/var/lib/branchleft/backup-worker-exporter`, the directory db1's
node_exporter reads and `dump_nightly.py` also publishes to), through
`record_run_status`:

- `db_binlog_ship_last_run_success`: `1` if the run shipped every closed log
  (a run with nothing pending counts), `0` if it failed for any reason.
- `db_binlog_ship_last_success_timestamp_seconds`: Unix time of the last run
  that succeeded. A failed run carries the previous value forward; it is absent
  until a first success.

The marker file records what was shipped but not when, so nothing could tell
"the timer stopped" from "nothing to ship" before this. Because every run
flushes first, a healthy run always has at least one log to ship, and the
timestamp advances every 15 minutes.

The write is atomic (temporary file in the same directory, then rename) and
best-effort: an error is printed and swallowed and never changes the exit
status or delays the next run. An empty `DB_BINLOG_METRICS_DIR` turns it off.
The alert rules that read these series (`DbBinlogShipStale` and
`DbBinlogShipMetricAbsent`) are in shared-infra's
`hetzner/monitoring/render.ts`.
