# test_branchleft_cnf_contract.py

## Module overview

What `db/stack/conf.d/branchleft.cnf` must keep true, and nothing else
checks.

Per-tenant point-in-time recovery replays a tenant's writes out of the
shared binlog by filtering row events on the table's database name.
STATEMENT format carries no such per-row marker -- a statement event
replays against whatever database the replaying session's most recent
`USE` left active, which loses writes issued outside that `USE` and can
replay a statement against the wrong tenant's database entirely.

ROW happens to be MySQL 8.0's compiled-in default, so undoing this pin
would not change today's behaviour and mysqld itself would not flag the
regression -- only a future default change, or an operator override,
would, and by then a restore is already broken. This test is what would
have failed instead.

Line-based rather than an INI parse, matching this directory's other
compose/cnf contract tests: the property asserted here is a single-line
fact.
