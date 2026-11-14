# scratch_migrate.py

The third part of the pre-swap scratch-copy gate. Part 1
(`scratch_preflight.md`) restores a tenant's newest verified backup into a
throwaway MySQL server; part 2 (`scratch_boot_smoke.md`) boots the green colour
on it. Ghost runs its own migrations as it boots, so by the time the colour
answers, the new colour's migrations have run on the copy. This part reads what
they did from the copy's migration tables, records it, and refuses the swap
unless they finished.

It is deterministic software. No agent takes part in it. It is a library that
`scratch_boot_smoke.py` calls as its `migrations` check; it has no command line
of its own, and its refusal is the gate's refusal (exit 1, `REFUSED` as the last
line, no `PASS`).

## What it reads

Only the throwaway server, through the recovery image's `mysql` client on the
scratch network, with the password as an environment value. It holds no address
for the tenant's database host.

| Table | Read |
|---|---|
| `migrations` | the name and version of every applied migration, in order |
| `migrations_lock` | whether Ghost's migration tool still holds its lock |

## One run

1. **Before.** The tables are read once the restore has passed and before the
   colour exists. A restore with no migration record, or tables that cannot be
   read, ends the run there: nothing about the colour's migrations could be
   proven from it.
2. **The colour boots**, and migrates the copy as it does.
3. **After.** Once the colour answers 200 (a Ghost that is still migrating does
   not), the tables are read again. A held lock is waited on until the lock is
   released or the gate's sidecar timeout passes; an unreadable table is not
   waited on.
4. **Judged.** The run is refused unless both hold:
   - the lock is released: a migration that died, or is still running, leaves
     it held;
   - the applied migrations after the run extend those before it, in order: no
     applied migration is missing or rewritten.

The outcome is recorded on `BootReport.migrations` and printed as one line,
`migrations: before=N after=M applied=K from=VERSION to=VERSION`: the count of
applied migrations before and after, how many were applied, and the version of
the newest migration before and after. A pass with nothing to migrate records
`applied=0`. A refused run records no outcome; its reason is the last line on
stderr.

## What the tests prove, and what they do not

`test_scratch_migrate.py` reads through a fake `mysql` runner and holds each rule
alone. `test_scratch_boot_smoke.py` reads a real throwaway server, which the
test's fake colour migrates by running SQL on it when it "starts". Each control
is a colour that must not pass:

| Control | Refused as |
|---|---|
| The colour serves and shows the tenant's content, but its migration left the lock held | `migrations` check failed |
| An applied migration is gone after the run | `migrations` check failed |
| The migration tables cannot be read after the run | `migrations` check failed |
| The backup records no migration | before the colour starts |

The first has a twin with the lock check removed, which passes. The tests do
not prove that the pinned Ghost image really leaves the lock held when a
migration dies: that is one run of the gate on the control host, against a real
backup and a real candidate image.
