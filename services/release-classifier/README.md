# release-classifier

Static reversibility check for a Ghost upgrade range. It reads the migration
source shipped at the target release tag and decides whether the range may
take the automatic fast path or must go to the tenant-consent path. Nothing
is executed, and no image is pulled.

Scope: this classifies. It does not open PRs, move tenants, or change state.

## Range

Migrations are read from `ghost/core/core/server/data/migrations/versions/<MAJOR.MINOR>/`
at the target tag. A folder is in range when it lies between the pinned and
target minor lines, both inclusive. See Open questions for why the lower bound is
inclusive.

## Routes

A file is fast-path only if no class below matches it. The route is `consent` when
any class matches anywhere in the range, and `fast-path` otherwise.

1. **Major bump.** The target major is above the pinned major. Always consent.
2. **Irreversible** (always consent). Ghost's own flag, or a helper that sets it:
   - `flag`: `irreversible: true`, bare or quoted as `'irreversible': true`.
   - `helper`: a call to `createIrreversibleMigration(`.
   - `wrapper`: a call to `dropTables(`. It sets the flag, so dropping a table is irreversible.
3. **Destructive** (always consent). Data or structure removed with no way back from
   the migration: `deleteTable(`, `recreateTable(`, `dropDevelopmentCopy(`,
   `removeSetting(`, raw `DROP TABLE`, raw `DELETE FROM`, `truncate`, `.delete(`, and
   `.del(` with an argument. Also `noop-rollback`: a `down()` that does nothing, in a
   file that also calls something destructive-looking. Comment lines are stripped first.
4. **Contracting** (routed by `CONTRACTING_ROUTE`, pinned to `consent`). Lossy:
   `dropColumn`, `dropColumns`, `createDropColumnMigration`, `.del()` with no argument,
   and permission removal (`removePermission`, `removePermissionFromRole`,
   `createRemovePermissionMigration`). A rollback re-adds a dropped column empty,
   and a delete loses rows. `removePermission`'s rollback re-adds only the configured
   permission. Its `up` deleted every permission row with the same action and object
   type, and those sibling rows are not restored.
5. **Constraint** (routed by `CONSTRAINT_ROUTE`, pinned to `consent`). Schema-only
   constraint drops: `dropIndex`, `dropUnique`, `dropForeign`. Kept apart from data loss.
6. **Unclassified** (always consent). Fail-closed. Local aliases are resolved first:
   `const x = a.b;` and `const { x } = a;` make calls through `x` count as calls to
   `b` or `x`. A name bound to a computed member, reassigned, or taken from a parameter
   cannot be resolved and routes consent. Every remaining call is checked against the
   `KNOWN_CALLS` allowlist. A call neither on it nor declared in the same file routes
   consent with reason `unclassified:<name>`. A file declares a helper with `function`,
   or with a `const`, `let` or `var` bound once to an arrow or function expression; its
   body is then checked like the rest of the file. Each allowlist entry states what its
   rollback does. The allowlist was derived from the real files that matched no rule
   at the previous head. `update` and `raw` are deliberately not on it.

## Rollback residuals (owner decision)

The allowlist is a judgement. Four entries, and one more, give a rollback that runs
even when the `up` step was skipped, so it can delete an object that existed before
the migration. The entries say so. The residual is:

> A fast-path migration's rollback is safe only if its up step created the object
> (it ran once). A re-run after a skipped up deletes what existed.

- `addTable`: the rollback drops the table whether or not `up` created it. The
  `replaceDevelopmentCopy` option is for development and test only, and the classifier
  cannot see it.
- `addSetting`: the rollback deletes the setting by key, whether or not `up` inserted it.
- `addPermissionToRole`: the rollback deletes the permission-role link, whether or not
  `up` created it.
- `addPermissionWithRoles`: the rollback deletes every permission row with the same
  action and object, not only this one. It runs even if `up` was skipped.
- `createAddColumnMigration`: the rollback drops the column whenever it exists. Rows
  written to it since the upgrade are lost, and so is any pre-existing column data when
  `up` was skipped.

The migration runner executes each migration once per database. That is the basis for
keeping these entries fast-path. The owner rules on it. See the decision card in the
pull request.

Pinned routes are the owner's open rulings. Changing a constant is a ruling, not a
refactor. The test suite pins the current values.

Text matching is a heuristic. The irreversible class matches comments as well as
code, which over-matches on purpose. The other classes match code with comments
stripped, and the unclassified check reads call names with string contents removed.

## Premise correction

The issue body says no 6.x migration uses the irreversible helper yet. That is
wrong. `6.0/2025-06-30-13-59-10-remove-mail-events-table.js` calls `dropTables`,
so it is irreversible through the wrapper.

With the inclusive range, that migration is in range for any upgrade whose pinned
minor is 6.0. So `v6.0.0` to `v6.1.0` routes consent on it. Ranges that start at 6.1
or later do not include it.

## Usage

    node src/cli.mjs --from v6.55.0 --to v6.69.0 --versions <path>/migrations/versions

Exit 0 is fast-path, 2 is consent, 1 is a usage or read error. The JSON output lists
every matched file with its rule, per class.

## Tests

    npm test

Run on the Node version in `.nvmrc`. The fixtures under `test/fixtures/versions/` are
copies of upstream Ghost source (see Licence). Full-line and block comments were
removed from the copies so they pass the repo's comment-block gate. The code is
otherwise unchanged, apart from the formatter's trailing-comma change. Synthetic
sources cover the rules no real fixture exercises. The raw SQL in the tests is
assembled from parts, so no SQL literal sits in the source.

The control case: an irreversible migration in a non-newest folder of the range
routes consent. A mutant that checks only the target folder for irreversible rules
fails that test.

## Licence

The fixtures are copies of Ghost source, MIT-licensed by Ghost Foundation. The licence
text is in `test/fixtures/LICENSE-ghost`, copied verbatim from the upstream `LICENSE`
at v6.69.0.

## Open questions

- **Lower bound.** An exclusive bound would fail open. A tenant on v6.57.0 that upgrades
  to v6.57.1 after that patch adds a destructive migration to folder 6.57 would see an
  empty range. So the bound stays inclusive. The cost is measured: the upstream
  `versions` tree is identical at v6.57.0 and v6.57.1, and the classifier still routes
  `v6.57.0` to `v6.57.1` consent on the two 6.57 files (the leaf-rows and
  reset-automation migrations). A possible fix is to compare the pinned and target
  trees and classify only files that are new since the pinned tag. That needs a second
  input and is not built here.
- **Contracting, constraint and unclassified.** The owner's rulings are open for the
  first two. The unclassified allowlist needs a ruling on each addition.
- **Rollback residuals.** See the section above. The owner rules on whether
  these entries stay fast-path.

## Not claimed

This does not establish that a range is safe. It checks migration source text against
a fixed list of forms, and forms not on the list route consent as unclassified. Helpers
on the allowlist are trusted on the basis of the reasons beside them. The rules read
text, so a data change written in a form the allowlist accepts, but whose effect the
reason does not cover, passes unseen. The range v6.55.0 to v6.69.0 routes to consent,
and the issue's Done-when is not claimed.
