# extract_tenant_binlog.py

## Overview

Scope a restore's binlog replay to one tenant's writes.

Every tenant on `db1` writes into the same physical binlog stream --
`ship_binlogs.py` ships it, and `dump_nightly.py` embeds the resume point a
replay starts from, but neither narrows the stream to one tenant. Replaying
it unfiltered onto a restore host, as the manual steps in
`db/RUNBOOK-db.md`'s Drill A do, brings every tenant's post-dump writes
back together -- an *instance*-level restore, not the per-tenant one a "we
deleted forty posts yesterday" recovery needs without also reintroducing
every other tenant's events since the dump.

## mysqlbinlog's own two filtering rules

`mysqlbinlog --database=<name>` is MySQL's own filter, and it draws the
line differently for the two event kinds this module cares about. A row
event (`Table_map`/`Write_rows`/...) is filtered on the table it actually
targets, never on which database a session had `USE`d: a write to
`tenant_a.posts` made from inside a `USE tenant_b` session is still a
`tenant_a` event and is kept when scoped to `tenant_a`. A DDL statement
(`ALTER`/`CREATE`/`DROP`/...) is logged as a `Query` event and is never a
row event even under ROW format -- mysqlbinlog filters it on the session's
own `USE`d database at the moment it ran, the older, coarser rule. So an
admin session that ran `USE tenant_b; ALTER TABLE tenant_a.posts ...` puts
that statement in *tenant_b*'s extract, not tenant_a's -- the reverse of a
row event's own rule -- and a DDL statement issued with no governing `USE`
at all is dropped from every tenant's extract. Ordinary tenant database
users cannot open a session against a database that is not their own, so
this only matters for an admin session run directly against `db1` --
`db/RUNBOOK-db.md` says so. ROW is MySQL 8.0's own server default, not
something `db/stack/compose.yml` sets -- this module relies on that default
rather than pinning it, which is a separate decision this story does not
make load-bearing.

## Resume point and contiguity

`--start-position` applies only to the *first* file named on the command
line, per mysqlbinlog's own documented behaviour -- the dump's resume point
therefore only makes sense as the position within whichever binlog file was
open at dump time; every subsequent file in the replay set is read from its
own beginning. The given files are sorted by binlog sequence number before
any of this happens (a caller's order is not trusted to be ascending), and
the *whole* sorted list must be a contiguous binlog sequence with no gap --
a gap would under-replay silently, since mysqlbinlog reads exactly the
files it is given and has no way to notice one missing.

## Recovery position: file and position, or GTID set

A dump carries its recovery position in one of two forms, and this module
reads either (`find_recovery_start`, returning a `RecoveryStart`):

- **File and position**: the `-- CHANGE MASTER TO MASTER_LOG_FILE=...,
  MASTER_LOG_POS=...;` comment the bounded snapshot writes. Replay starts at
  that position in that file (above). db1's nightly dump is taken one schema
  at a time and carries one such comment per section, in the form
  `-- BRANCHLEFT-SECTION CHANGE MASTER TO ...` (`dump_nightly.section_comment`).
  The position for a database is that of the latest section comment before
  the line that declares it, so a database dumped in the first section and one
  dumped in the fifth each start from their own. Both forms in one dump, or a
  database declared before any section comment, are refused: the position is
  one thing, read from one place. The section form is not matched by the bare
  pattern, so a reader that predates it finds no comment and refuses.
- **GTID set**: the `SET @@GLOBAL.GTID_PURGED=...` statement of a lock-free
  dump (`gtid_snapshot.md`): exactly the transactions the dump holds. No file
  or position is involved. Replay runs every given file with
  `mysqlbinlog --exclude-gtids=<set> --skip-gtids`, so a transaction in the
  set is skipped and every other one is applied, in log order. `--skip-gtids`
  leaves the restore target's own GTID state alone, so it needs neither
  `gtid_mode` nor the privilege to set `GTID_NEXT`. It is the documented
  exception-only option; the use fits because the target is a scratch server
  loaded from the dump, whose own `GTID_PURGED` the replayed events must not
  collide with.

A dump with both forms, or neither, is refused: the position is one thing,
read from one place. A GTID set cannot say where a file begins, so the
contiguity check stays, and one more is added for the one failure a set
cannot see: **a missing earlier binlog file**. The transactions before the
first file given are exactly that file's `Previous-GTIDs` event; if any is
not in the dump's set, it is in neither the dump nor the files, and the
restore would silently lack it. `assert_binlogs_cover_gtid_set` reads the
event from `mysqlbinlog --stop-position=4096 <first file>` and refuses a
replay it does not fit (`binlog gap`). A first file with no such event was
not written with GTIDs, so the set could not be honoured, and is refused too.
`--skip-gap-check` turns the check off for an operator who has verified the
range some other way; it says so on stderr.

`mysqlbinlog` is not in the official `mysql` image (`db/RUNBOOK-db.md`'s
toolchain note); a pinned recovery image that carries it is tracked
separately and does not exist yet. This module assumes `mysqlbinlog` is
already on `PATH` wherever it runs and does not attempt to locate or
install it.

This module operates on binlog files already decrypted to plaintext, same
as the manual Drill A steps -- it never touches an `age`-encrypted object
or Object Storage directly.

The replay this drives is **not atomic**: a `mysqlbinlog | mysql` pipe can
fail partway through, between two binlog files or mid-transaction, leaving
the target in whatever state the events applied so far produced. Run it
only against a drained or scratch restore target nothing else is reading or
writing -- never against a database serving live traffic.

## Timezone handling

`mysqlbinlog`'s own `--stop-datetime` is evaluated against the *process's*
local time unless told otherwise: with no `TZ` in its environment, glibc
falls back to the recovery host's own `/etc/localtime`, not UTC and not
whatever timezone an operator's invoking shell happens to be in -- `env=`
in `extract_tenant_stream` replaces the child's environment wholesale, so
the invoking shell's own `TZ` (if any) never reaches the child either way.
This module always runs `mysqlbinlog` with `TZ=UTC` explicitly set, so a
recovery host provisioned with any local timezone still interprets
`--stop-datetime` identically. Every timestamp this module's CLI takes is
UTC.

The minimal environment (`_child_env`) carries no `HOME`, so `mysql`'s
default `~/.my.cnf` lookup finds nothing -- deliberately: a personal or
host default file could otherwise silently add options (a different
socket, a different default database) to a replay applied against
decrypted tenant data. Nothing in this module reads `~/.my.cnf`.

## Always-applied extract and coverage horizon

The extract is always applied, whether or not it carries any event for the
tenant -- a stream of nothing but session setup is harmless to apply, and
there is no second code path to keep in sync with what gets counted (see
`count_tenant_events`). Every run also reports the given binlog range's own
coverage horizon: the last binlog file's closing `Rotate` event carries a
timestamp, read by `binlogs_coverage_end` from a separate unfiltered
`mysqlbinlog` pass over that one file (the replay's own extract stops before
that Rotate whenever `--stop-datetime` falls inside the file, so it cannot
supply the horizon). `main()` compares the two instants as parsed datetimes
(`parse_utc_datetime`, unpadded hours accepted, never as strings) and warns
on stderr when `--stop-datetime` asks for an instant later than the horizon
-- the given file list may be short a binlog. This is the only case a coverage gap can be told
apart from a tenant that genuinely wrote nothing: it has no bearing on the
row/statement counts themselves, which stay legitimately zero either way.

## mysqlbinlog_argv

Exactly one of `start_position` and `exclude_gtids` is given. With
`exclude_gtids` the command is `mysqlbinlog --exclude-gtids=<set>
--skip-gtids [--database=...]`, with no `--start-position`.

`database=None` builds the *unscoped* command -- every tenant's events,
exactly Drill A's existing manual step -- kept as a first-class option here
(not a separate code path) so a sabotage of the filter and a restoration of
it are the same one-line change to a caller, not two different functions to
keep in sync. `stop_datetime`, like every timestamp this module takes, is
UTC -- see "Timezone handling" above for the `TZ=UTC` environment that
makes that true of mysqlbinlog's own interpretation of it, not just this
module's documentation of it.

## count_tenant_events

Returns `(row_events, statements)` attributed to `tenant_database` within
an extract already scoped to it by `--database=<tenant_database>`.

`row_events` counts `Table_map` annotations naming the tenant --
mysqlbinlog's own per-row-event marker, not a guess.

`statements` counts Query events other than a bare BEGIN, COMMIT or
ROLLBACK: DDL (`ALTER`/`CREATE`/`DROP`/...) is logged as a Query event even
under ROW format and never appears as a Table_map/row event, so a
row-event-only check misses a tenant whose only post-dump events were
schema changes entirely -- exactly the shape of a restore that silently
restored less while reporting success.

Neither count being nonzero does not mean the tenant is a typo; that is
`find_resume_point`'s job (the dump-declaration check). This function only
reports what the extract contains, and never raises.
