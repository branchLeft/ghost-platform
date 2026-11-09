# gtid_server_model.py

## Module overview

Test support, never shipped to a host. An in-process model of one
MySQL-family server's commit pipeline, scheduled by the test, plus fakes for
what the backup and restore code runs: `Server.popen` (the launcher
`ClientFactory` takes, answering for `mysqldump` and refusing any other
program), and `Server.run` (answering for `mysqlbinlog` and `mysql`, the shape
`extract_tenant_binlog` calls).

## What it models

- A transaction is **logged** first (it gets its sequence number and its
  place in the binary log) and **committed** later (visible in the engine,
  and in the executed set). Between the two it is a straggler. Commits happen
  in log order.
- A snapshot sees only committed transactions, and the server's file and
  position at that instant are the end of the log, stragglers included.
- The dump header carries the set the snapshot saw (`header_set_source =
  "snapshot"`, the contract), or the set read after the snapshot opened
  (`"live_after"`, a sabotage), or nothing (`"none"`).
- `mysqlbinlog` honours `--start-position` (first file only),
  `--exclude-gtids`, `--skip-gtids`, `--database`, `--stop-datetime` (events
  at or after it are left out) and `--stop-position` (the header events of a
  file, with its `Previous-GTIDs`).
- Operations are an `insert` (a duplicate is an error) or an `incr` (a missing
  row is an error), so a transaction applied twice or not at all is visible.
- A locked schema stalls submissions and counts them; `lock_requests`,
  `global_lock_attempts` and `stalled_submits` are what the no-pause tests
  assert on. A `stock` flavour (the Oracle client, or Oracle MySQL) fails
  `--set-gtid-purged=ON` the way Oracle's `mysqldump` does without `RELOAD`.

## What it does not model

**The wrong client.** The `stock` flavour is only an Oracle 8.0.32+ client,
which takes a global read lock and fails closed for lack of `RELOAD`. An
Oracle client older than 8.0.32 reads the set after its snapshot with no lock
and writes a header that can hold transactions the dump lacks; the restore
then silently misses them. The model cannot show that case and no test here
does. What guards it is `gtid_snapshot.assert_percona_client`, which refuses
any `mysqldump` whose `--version` does not name Percona, before a dump starts;
the model's tests only show that the refusal happens, not that the
distinction is the right one.


An engine, locks other than the table lock above, parallel appliers, real
mysqlbinlog output (the fake prints the few lines the extract code reads),
crash recovery. It cannot show that a real server reads its set atomically
with a snapshot: that is the contract it encodes, and a container run against
the real server is the proof of it.

`FakeDump.pid` is `None` so `kill_process` can never signal a real process
group.
