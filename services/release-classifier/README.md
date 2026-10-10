# release-classifier

Static reversibility check for a Ghost upgrade range. It reads the migration
source shipped at the target release tag and decides whether the range may
take the automatic fast path or must go to the tenant-consent path. Nothing
is executed, and no image is pulled.

Scope: this classifies. It does not open PRs, move tenants, or change state.

## Range

Migrations are read from `ghost/core/core/server/data/migrations/versions/<MAJOR.MINOR>/`
at the target tag. A folder is in range when it lies between the pinned and
target minor lines, both inclusive. The pinned minor folder is included on
purpose: a patch can add a migration to its own minor folder, and over-including
only makes the answer more cautious. The cost is that a cross-minor upgrade
also re-reads migrations the tenant has already applied (see Open questions).

## Classes and routes

Route is `consent` when any class below matches, and `fast-path` otherwise.

1. **Major bump.** The target major is above the pinned major. Always consent.
2. **Irreversible** (always consent). Ghost's own flag, or a helper that sets it:
   - `flag`: `irreversible: true`, bare or quoted as `'irreversible': true`.
   - `helper`: a call to `createIrreversibleMigration(`.
   - `wrapper`: a call to `dropTables(`. The wrapper in `utils/tables.js` sets
     the flag, so dropping a table is irreversible.
3. **Destructive** (always consent). Data or structure removed with no way back
   from the migration itself: `deleteTable(`, `recreateTable(`, raw `DROP TABLE`,
   raw `DELETE FROM`, `truncate` / `TRUNCATE`, `.delete(`, and `.del(` with an
   argument. Also `noop-rollback`: the file's `down()` does nothing while the file
   contains a destructive-looking call. Comment lines are stripped before these match.
4. **Contracting** (routed by `CONTRACTING_ROUTE`, pinned to `consent`). Lossy:
   `dropColumn`, `dropColumns`, `createDropColumnMigration`, and `.del()` with no
   argument. A rollback re-adds a dropped column empty, and a delete loses rows.
5. **Constraint** (routed by `CONSTRAINT_ROUTE`, pinned to `consent`). Schema-only
   constraint drops: `dropIndex`, `dropUnique`, `dropForeign`. Kept separate so the
   owner can rule on them without rulings on data loss.

Pinned routes are the owner's open rulings. Changing a constant is a ruling, not a
refactor; the test suite pins the current values.

Text matching is a heuristic. The irreversible class matches comments as well as
code, which over-matches on purpose. Destructive, contracting and constraint
classes match code only, with comments stripped.

## Premise correction

The issue body says no 6.x migration uses the irreversible helper yet. That is
wrong. `6.0/2025-06-30-13-59-10-remove-mail-events-table.js` calls `dropTables`,
so it is irreversible through the wrapper. The wrapper rule is needed for that file.

With the inclusive range, that migration is in range for any upgrade whose pinned
minor is 6.0: `v6.0.0` to `v6.1.0` routes consent on it. It is out of range for
any upgrade that starts at 6.1 or later.

## Usage

    node src/cli.mjs --from v6.55.0 --to v6.69.0 --versions <path>/migrations/versions

Exit 0 is fast-path, 2 is consent, 1 is a usage or read error. The JSON output
lists every matched file with its rule, per class.

## Tests

    npm test

Run on the Node version in `.nvmrc`. The fixtures under `test/fixtures/versions/`
are copies of upstream Ghost source (see Licence). Synthetic sources cover the
rules that no real fixture exercises. Full-line and block comments were removed
from the copies so they pass the repo's comment-block gate; code is otherwise
unchanged, apart from the formatter's trailing-comma change.

The control case: an irreversible migration in a non-newest folder of the range
must route consent. A mutant that checks only the target folder for irreversible
rules fails that test.

## Licence

The fixtures are copies of Ghost source, MIT-licensed by Ghost Foundation. The
licence text is in `test/fixtures/LICENSE-ghost`, copied verbatim from the
upstream `LICENSE` at v6.69.0.

## Open questions

- **Lower bound.** Should the pinned minor folder be excluded? A migration already
  applied at the pinned version cannot apply again, so an exclusive bound would be
  correct for those. But a patch can add a migration to its own minor folder, and
  the source alone cannot show whether a tenant has applied it. An exclusive bound
  could then route a patch upgrade fast when it should not. The current choice is
  inclusive. Its cost: v6.57.0 to v6.58.0 routes consent because of two 6.57 files
  already applied at 6.57.0 (the leaf-rows and reset-automation migrations), and
  v6.0.0 to v6.1.0 routes consent on the 6.0 wrapper migration.
- **Contracting and constraint classes**, the owner's rulings. See the constants.

## Not claimed

This does not establish that a range is safe. It checks migration source text
against a fixed list of forms. Forms not on the list are not detected, including
other destructive helpers such as `removeSetting` and `removePermissionFromRole`,
and data changes written in a form the rules do not name. The range
v6.55.0 to v6.69.0 routes to consent, and the Done-when of the issue is not claimed.
