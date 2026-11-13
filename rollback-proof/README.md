# rollback-proof

For a release candidate, shows whether the image the tenants run now (the old
image) still works on a database the candidate (the new image) has already
migrated. A rollback that is first tried during an incident is untested; this
tries it in CI, on every candidate, on the database engine the tenants use.

Upgrades are forward-only. A candidate may change the database in a way the old
image cannot use; the way back is then to restore the pre-upgrade backup
(`restore-from-backup`), which loses every write since that backup and takes the
site down while it restores. So a way back that is red is a warning that names
that route, not a refusal. A candidate that is itself broken (the new image does
not boot, or cannot take a first write) is still refused: a candidate is never
deployed to leave tenants with broken behaviour.

It runs on a throwaway MySQL (the digest `db/RUNBOOK-db.md` pins) with throwaway
Ghost containers. It touches no host and uses no secret.

## What a run does

1. Boot the old image on an empty database. It migrates to its own schema. Set
   up an owner, sign in, publish a seed post. Stop it. The database stays.
2. Boot the new image on that database. It migrates the schema forward. Sign in
   and publish a post of its own. Stop it.
3. Read the old image's own schema module out of the old image, and compare it
   with the migrated database, using the column catalogue read before the new
   image ran as the baseline (see Schema contract).
4. Boot the old image again, on the migrated database, and run the smoke set.

The old image is started fresh, not left running: a rollback re-provisions the
old image against migrated data, which is the operation nobody had run.

## The checks

Every one of these is recorded once. `new-boots` and `data-intact` are the gate: red
refuses the candidate. The other six are the rollback test: red is a warning.

| Check                   | Class    | Red when                                                            |
| ----------------------- | -------- | ------------------------------------------------------------------- |
| `new-boots`             | gate     | the new image does not serve, or cannot take a first write          |
| `schema-contract`       | rollback | the migrated database breaks the old image's schema (below)         |
| `old-boots-on-migrated` | rollback | the old image does not answer 200 on the migrated database          |
| `session-survives`      | rollback | an owner session opened before the upgrade no longer authenticates  |
| `sign-in`               | rollback | a fresh owner sign-in fails                                         |
| `data-intact`           | gate     | the seed post or the new image's post is missing or does not render |
| `publish`               | rollback | a post published on the old image does not render                   |
| `member-create`         | rollback | a member cannot be created                                          |

`data-intact` is a gate because lost data after an upgrade is broken behaviour,
not a missing way back. It carries its own control: a page that was never
published must not answer 200, or "renders" would prove nothing. A check that
did not run is
recorded red with the detail `not run`. That is a warning only when the old
image did not boot on the migrated data (the checks after it cannot run). Any
other `not run`, a missing, repeated or unknown check, a record for another
pair, and a run that ended in an error are refusals: they mean the record is
half-finished, and a half-finished record is never read as an acceptance.

## Schema contract

The smoke set only reaches what it exercises. A release can rename a column the
old image writes on a path no smoke step takes (a bulk send is the measured
case: the old image writes `email_batches.provider_id`, a later release renames
it). So the old image's own schema module is read out of the old image and
compared with the migrated database's information schema, with the catalogue
read after the old image seeded as the baseline for "required". Tables the
image lists in `IN_DEVELOPMENT_TABLES` (Ghost 6.76.0 and later, in
`in-development.js`) are left out: production never creates them, so their
absence is not a break. An older image has no such file and nothing is left
out. Findings:

- `missing-table`, `missing-column`: the old image uses what is gone.
- `column-now-required`: a column the old image could omit became not null with
  no default.
- `unknown-required-column`: a column the old image has never heard of is not
  null with no default and was not already so, so the old image's inserts fail.

"Required" is judged against the baseline, not against the schema file, because
the schema file leaves some columns implicit that the database has always
required.

Not covered: a column whose type or length changed, an index or constraint the
old image relies on, and a migration that changes data in place. Those are for
the release classifier and for a person.

## Running it

    node rollback-proof/cli.mjs run --old <image> --new <image> --mysql <image> [--profile platform|stock] --out report.json
    node rollback-proof/cli.mjs verify --report report.json --old <image> --new <image>

`--profile platform` (the default) gives Ghost the storage settings the tenant
image requires. `--profile stock` gives it none, for upstream Ghost images,
which do not have the scanning storage adapter. The profile is recorded.

Exit 0 accepts the candidate, clean (`accepted`) or with warnings (`warned`).
Exit 2 refuses it. Exit 1 is an error (bad arguments, an unreadable record, a
run that did not finish). A caller must treat every non-zero exit as a refusal.
`run` needs Docker and writes the record; `verify` is what a gate calls on a
stored record. It recomputes the verdict and the warnings from the checks and
never trusts the record's own `ok`. It refuses another pair's record, a red
`new-boots`, a missing, repeated or unknown check, an unfinished or errored
run, schema findings next to a green `schema-contract`, and a record that warns
without naming the rollback route.

A warned record carries `warnings` (each with its check, its detail and the
route `restore-from-backup`) and `rollbackRoute`. `run` prints the warning as
`WARNING:` lines. `verify` prints them too and, under GitHub Actions, adds one
`::warning` log annotation and a job-summary section, so each shows once in a
job that runs and then verifies. Telling the owner (pager, email, the admin
portal) is a separate piece of work that reads this record; nothing here sends
anything.

The record also holds how long the new image took to migrate, how long the old
image took to boot on the migrated data, and the total.

## In CI

`.github/workflows/rollback-proof-ci.yml` has three jobs.

- `proof`: the unit tests and `prove-sabotage.mjs`, no Docker.
- `live`: two real pairs. The image on its own migrated data must be accepted
  clean. The first real bump range (the old image writes a column a later
  release renames) must be accepted with a warning that names that column and
  the restore route. A warning is only evidence next to a clean acceptance.
- `candidate`: a reusable call (`workflow_call` with `old-image` and
  `new-image`) that fails unless the pair is accepted, with or without
  warnings. A workflow that has a release candidate calls it with the two
  digests.

## Tests

    node --test rollback-proof/*.test.mjs
    node rollback-proof/prove-sabotage.mjs

The unit tests run the whole proof against a small in-memory world
(`fake-ops.mjs`): images that migrate a shared schema when they boot, and an
admin surface over shared posts and members. `prove-sabotage.mjs` breaks each
control in a scratch copy (a finding ignored, a failed check recorded green, the
new image swapped for the old one so nothing is migrated, the verdict not
compared with the pair, a warning that does not name the restore route, a
half-finished record read as accepted, a broken new image only warned about,
and so on) and requires the tests to go red; the un-broken copy must be green
first.

## Not proven here

The real Docker run is proven only by the `live` job. The same proof on a slot
of the real demo host is a separate piece of work and is not here. Nothing calls
the `candidate` job yet: a release candidate does not reach it until a workflow
that holds one calls it. The restore itself is not exercised here: the proof
names `restore-from-backup` as the route and does not run a restore. Sending the
warning to the owner is not built here.
