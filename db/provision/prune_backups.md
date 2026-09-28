# prune_backups.py

## Module overview

Run by `branchleft-db-prune.timer` via `branchleft-db-prune.service`, as root
on db1. Reads `DB_BACKUP_BUCKET`, `DB_BACKUP_ENDPOINT`, `DB_BACKUP_REGION`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment --
`/etc/branchleft/db.env` via the unit's `EnvironmentFile`, the same variables
`dump_nightly.py` and `ship_binlogs.py` already use. Never touches MySQL:
this script only lists and deletes Object Storage objects.

Object versioning and the 35-day noncurrent lifecycle (`configure_backup_bucket.py`)
are a separate, already-decided layer against overwrites -- a delete here
still lands as a *version* the bucket keeps for 35 days, this script's own
mistakes included. This script governs only how long an object stays
*current*, which nothing else in the pipeline bounds.

A bucket lifecycle `Expiration` rule was considered and rejected for this
job, even though the object storage provider's own lifecycle example
documents `Expiration.Days` as a real feature. The rejection is not that the
mechanism is unavailable -- it is that `Expiration` is blind, per-object,
age-only deletion with no way to ask "does a newer dump already cover what
this one would leave uncovered?" A missed or failed nightly dump
(`dump_nightly.py` raises before ever uploading, so a failure simply
produces no object -- there is never a partial one to also account for)
needs the retained set to extend further back until a covering dump exists
again; a static day count cannot express that condition, so it cannot hold
this module's invariant. See [`plan_prune`](#plan_prune) for what replaces
it.

## plan_prune

The retention decision over a listing -- no I/O, so every case below is a
unit test rather than a live-bucket experiment.

The invariant: at every instant, the oldest *retained* dump plus the
retained binlogs from its timestamp forward must together cover the full
`pitr_window_days`-day PITR window, with margin. Evaluated independently per
`server_uuid` -- a rebuilt db1's previous incarnation's objects age out
under the exact same rule and need no special-casing, since recoverability
is only ever promised for the current incarnation's data.

The **anchor** is the newest dump at or before `now - pitr_window_days`: the
oldest dump the window actually needs, because it plus continuous binlogs
from its own timestamp forward already covers every point back to the
window's edge. Everything older than the anchor is surplus. **The anchor is
never deleted, however old it is** -- a run of missed or failed nightly
dumps just pushes the anchor further back than `RETENTION_DAYS`, and this
function keeps it there rather than deleting on a blind age threshold that
cannot see whether a replacement exists.

Binlogs are kept back to `min(now - RETENTION_DAYS, anchor.timestamp)`, so a
stretched anchor extends binlog retention exactly as far as it extended
dump retention -- the anchor dump is never left with nothing to replay
forward from. Deletions are only ever the oldest contiguous run by binlog
**sequence number** (parsed from the log's own filename), not by timestamp
alone: a binlog file's rotation can straddle the cutoff (it was opened
before the cutoff and only closed, and so only timestamped, after it), so
sequence order is the one thing here that cannot be skewed by when shipping
happened to run.

A `server_uuid` group that cannot be pruned without the retained set
falling short of the window is refused outright -- nothing in that group is
deleted, dumps or binlogs, rather than pruned partway.

## coverage_report

Per-`server_uuid` (oldest retained dump, oldest retained binlog, status),
re-derived from a fresh listing rather than trusted from `plan_prune`'s own
guarantee -- this is the independent check an operator runs after a prune
to see the bucket's actual state.

A **bucket-wide** `min()` across every incarnation's objects (an earlier
version of this check did exactly that) is meaningless: it mixes a live
incarnation's numbers with a dead, rebuilt one's forever-kept anchor, so a
live gap can hide behind an old incarnation's reassuringly ancient
timestamp. Grouping by `server_uuid` is what makes the check mean anything.

`"gap"` (oldest binlog newer than the oldest dump) is the one status that
means recoverability is actually at risk -- there is no shipped binlog old
enough to replay from the anchor dump's own timestamp forward. `"no dump"`
and `"no binlog"` are reported as distinct conditions rather than folded
into `"gap"` because they read differently to an operator: an incarnation
with binlogs but no dump has nothing to restore *from* at all, and one
still inside its first ~15 minutes legitimately has a dump and no binlog
yet.
