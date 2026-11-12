# dump_tenant.py

## Overview

One tenant's logical dump, streamed to stdout, taken with no credential that
could reach where a dump ends up.

Invoked for a single named tenant -- by hand, or by the backup worker
dialling into the database host and reading this process's stdout -- rather
than run on a schedule against every database in turn. That is what makes
it usable both as the nightly per-tenant loop's one step and as the
on-demand dump the upgrade ring needs before a bump: the same operation,
invoked at a different moment, never a second code path.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in `db/stack/compose.yml`) as the dedicated
`backup`@`localhost` account -- never TCP, so this never depends on
`bind-address` covering a loopback or private address for this account.
`DB_DUMP_MYSQL_PWD` is read from this process's own environment; nothing
yet specifies how that variable reaches a pull-model invocation of this
script, since a worker dialling in rather than a local systemd timer is
what runs it now, and the old push model's answer (an on-host
`EnvironmentFile`) was built for the timer it is replacing.

There is no object-storage credential, no encryption key and no bucket,
endpoint or region to read here. A start-up check refuses to run at all if
any such variable is present in this process's own environment regardless
of whether anything would have used it: the tenant database host is not the
place any of that is meant to exist, encryption and the write to storage
both happen where the worker pulls to. The mysql/mysqldump children this
script spawns get an allowlisted environment of their own -- `PATH`, so the
binary can be resolved by name, and `MYSQL_PWD` -- never a forwarded copy of
this process's own, so a variable the start-up check somehow missed still
could not reach them.

The dump's own stdout carries nothing but the dump: every status line this
script prints goes to stderr, because a caller reading stdout as the backup
payload cannot tell a trailing line of prose from the last bytes of a
`mysqldump` footer. A nonzero exit can follow partial bytes already written
to stdout -- whatever streamed before the failure is the caller's to
discard whole, never kept as a partial dump.

`posts` is deliberately not a floor table: Ghost's own "delete all content"
endpoint destroys every post through the ordinary admin API
(`deleteAllContent` in `ghost/core/core/server/api/endpoints/db.js`), so an
empty `posts` table is a legitimate tenant state, not evidence of a broken
dump. `settings` is not reachable by that path and carries on the order of
a hundred rows seeded by every install's default-settings fixture, with no
migration in the tree that truncates it wholesale.

`db1`'s own `dump_nightly.py` is untouched by this file and keeps running
exactly as it does today.

## floor-check

The floor check runs twice, against different evidence, because they prove
different things. A cheap pre-check (`check_floor`) queries exact row
counts on the live source before `mysqldump` is invoked at all, and refuses
early if the source is already empty. The check that actually matters
(`run_mysqldump`) runs afterwards, watching for at least one `INSERT INTO
`table`` line for each floor table as mysqldump's own output streams past:
a pre-check alone only proves the *source* was not empty a moment earlier,
and a mysqldump invocation that silently narrows what it writes (a stray
`--no-data`, a filtered `--ignore-table`) can still pass a source-side
pre-check while the dump itself captures nothing.

This proves presence, not a count: mysqldump's default packed
(`--extended-insert`) form can put an unknown number of rows in one matched
line, and presence is all the floor needs -- unpacking it to count exactly
(`--skip-extended-insert`) was tried and dropped once measured against a
real restore: 50k rows went from 0.45s to restore packed to 42.7s
unpacked, for a count nothing downstream reads. `--databases <name>`, not
`--all-databases`: one tenant's database per invocation is what makes a
tenant's failure local to that tenant rather than aborting whatever else
the caller was in the middle of dumping.

`stderr` is a real temp file rather than a pipe, so a chatty mysqldump
cannot deadlock this process against its own unread stderr while stdout is
being streamed.
