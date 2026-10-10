# release-classifier

Static reversibility check for a Ghost upgrade range. It reads the migration
source shipped at the target release tag and decides whether the range may
take the automatic fast path or must go to the tenant-consent path. Nothing
is executed, and no image is pulled.

Scope: this classifies. It does not open PRs, move tenants, or change state.

## Rules

Migrations are read from `ghost/core/core/server/data/migrations/versions/<MAJOR.MINOR>/`
at the target tag. A folder is in range when it lies between the pinned and
target minor lines, both inclusive. The pinned line is included on purpose:
a patch release can add a migration to its own minor folder, and over-including
only makes the answer more cautious.

Route is `consent` when any of these holds, and `fast-path` otherwise:

1. **Major bump.** The target major is higher than the pinned major.
2. **Irreversible migration.** A file in range matches one of:
   - `flag`: `irreversible: true` (Ghost's own config flag).
   - `helper`: a call to `createIrreversibleMigration(`.
   - `wrapper`: a call to `dropTables(`. The wrapper in `utils/tables.js`
     sets the flag, so a release that drops a table is irreversible.
3. **Contracting migration**, when `CONTRACTING_ROUTE` is `consent`. A file in
   range matches `drop-column` (`dropColumn`, `createDropColumnMigration`)
   or `data-delete` (`.del()`). Ghost's flag does not mark these irreversible,
   but they discard data or re-add a column empty on rollback.

`CONTRACTING_ROUTE` is set to `consent` pending an owner ruling. Changing it
is a ruling, not a refactor; the test suite pins the current value.

The text matching is a heuristic. It over-matches on purpose, so a comment that
names a helper also counts. That only makes a route more cautious.

## Premise correction

The claim that no 6.x migration uses the irreversible helper is wrong. The 6.0
folder ships `remove-mail-events-table.js`, which calls `dropTables`, so it is
irreversible through the wrapper. Ranges that start at 6.0.0 or later are
unaffected by it, which is why rule 2 includes the `wrapper` rule.

## Usage

    node src/cli.mjs --from v6.55.0 --to v6.69.0 --versions <path>/migrations/versions

Exit 0 is fast-path, 2 is consent, 1 is a usage or read error. The JSON output
lists every matched file with its rule.

## Tests

    npm test

Tests use fixtures copied from the public upstream TryGhost/Ghost
source at v6.69.0, then formatted by the repo's prettier (trailing commas only): `remove-mail-events-table.js` (6.0), `add-to-hash-to-redirects.js`
(6.55), and two migrations from 6.57. Synthetic sources cover the `flag` and `helper` rules. The 6.57 leaf-rows fixture
has its narrative comment block removed (the CMT-3 gate fails on it); no code is changed.

## Not claimed

This does not establish that a range is safe. It checks one signal, the
migration source. Column changes that Ghost does not flag are caught only by
the contracting rule, and a data-changing migration written in another style
can pass unseen. The 6.55.0 to 6.69.0 range routes to consent today because of
the 6.57 migrations, so the range is not a green case until the owner rules.
