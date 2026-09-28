# test_dump_tenant.py

## Module overview

Unit tests for `dump_tenant.py`.

Every external command is faked -- no real mysqldump, mysql or network call
-- so these cover the pipeline's ordering, its per-tenant failure
isolation, and both floor checks: the early source-side refusal (an exact
count, a real `COUNT(*)`), and the one that actually matters, which
watches what mysqldump's own stream wrote for *presence* rather than
counting it -- mysqldump's default packed form can put any number of rows
on one matched line, so presence is the only claim the streamed check
makes. A separate section proves, statically and behaviourally, that no
storage or encryption credential can reach this script or the children it
spawns -- that property has to survive both a forwarded environment and a
dropped refusal, so each has its own sabotage. A further section proves
byte-for-byte fidelity through `main`'s own default stdout wiring,
including the exact bug a `sys.stdout.buffer` typo would reintroduce.
