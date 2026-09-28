# test-batch-claim-lock.sh

## What this proves

This is the "batch claim under two colours" harness gate: two colours over
one database cannot both claim the same email batch. Ghost's own
mechanism (`batch-sending-service.js`'s `updateStatusLock`) is a
conditional status change inside a locked transaction -- a claim is one
SQL statement, not a read-then-write -- which is exactly what this proves
on a throwaway table shaped like Ghost's real `email_batches`, on SQLite
(a local scratch file, this script's own `mktemp`) and on MySQL (a
scratch container this script creates and destroys). Never against slot
0's SQLite or against the live blog: nothing here is a real demo host or
a real tenant database.

The real assertion, both engines: two colours racing the same atomic
claim -- exactly one wins.

The control case (load-bearing): a test double with the lock removed --
read-then-write instead of one conditional UPDATE -- and both colours
claim it. That is the exposure Ghost's own mechanism exists to prevent: a
reader receiving the newsletter twice.
