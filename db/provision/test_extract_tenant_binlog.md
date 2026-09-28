# test_extract_tenant_binlog.py

## Module overview

Unit tests for `extract_tenant_binlog.py`.

The property worth the most coverage is the one the story exists for: a
scoped replay must carry exactly one tenant's post-resume events and none
of another's -- filtered on the *table* a row event targets, never on
which database a session had `USE`d, which is what makes AX/BX in
`SAMPLE_EVENTS` below load-bearing rather than decorative. Two more matter
just as much: a legitimately empty replay (a quiet tenant, or a
`--stop-datetime` chosen before a tenant's first post-dump write) is a
*success*, not a typo -- only a genuine mismatch against the dump's own
declared databases is; and a tenant whose only post-dump events are schema
changes (DDL, logged as `Query` events, never a `Table_map`/row event) must
still be detected and reported, not read as "wrote nothing".
`FakeMysqlbinlog` plays the part of mysqlbinlog well enough to prove all
three in-process -- including its `Table_map` and `Query`/`Rotate`
event-header shapes -- rather than proving only that this module's argv
construction looks right. The real `mysqlbinlog` binary is exercised
separately, against a real MySQL instance in Docker, per
`db/RUNBOOK-db.md`'s restore drill; that is not a unit test and does not
belong in this file's fast, hermetic run.

## FakeMysqlbinlog

A fake event stream, filtered the way a real `mysqlbinlog
--database=<name> --start-position=<n> [--stop-datetime=<t>]` filters a
real row-format binlog. Each `events` entry is `(file, position,
table_database, marker)`, where `marker` is one of:

- `"ROW:<label>"` -- a row event (Table_map + label), filtered on
  `table_database` the way a real row event is: the table it targets,
  never a session's `USE`.
- `"DDL:<statement>"` / `"BEGIN"` -- a Query event, filtered on
  `table_database` the way a real Query event is: the session's `USE`d
  database, mysqlbinlog's older, coarser rule (see the module docstring)
  -- modelled here by the same `table_database` field, since the
  fixture's "session" is exactly the `table_database` given.
- `"ROTATE:<yymmdd>:<hh:mm:ss>"` -- a Rotate event, never filtered by
  `--database` or `--start-position`, same as the real thing.

Every emitted event line begins with a `#`-prefixed header comment,
matching real mysqlbinlog output closely enough that
`extract_tenant_binlog`'s own header-scanning regexes
(`QUERY_EVENT_HEADER_PATTERN`, `ROTATE_EVENT_PATTERN`) work against it
unmodified. A label/statement starting `STOP-EXCLUDED` is dropped whenever
*any* stop_datetime is given -- this fake does not model specific
instants, only "before" vs "after" a stop.

## SAMPLE_EVENTS

Three files across the resume file and two rotations (000003 -> 000004 ->
000005), mirroring the design spike's own multi-file replay. AX/BX are
cross-session writes: AX's row event targets tenant_a even though its
(fake) session had USEd tenant_b, and BX is the mirror image -- proving
the filter follows the table, not the session. tenant_early's only event
is STOP-EXCLUDED: with any --stop-datetime, it vanishes, modelling a
restore instant chosen before that tenant's first post-dump write.
tenant_quiet has no event at all, anywhere. tenant_ddl's only events are
DDL (Query events) plus the BEGIN/COMMIT bookkeeping around ordinary row
writes elsewhere in the same file -- proving DDL is counted and BEGIN is
not.
