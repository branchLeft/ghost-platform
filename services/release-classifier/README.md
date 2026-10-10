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

## How a file is read

Each file is lexed once, by `src/lex.mjs`: a single pass that understands line and
block comments, single- and double-quoted strings, template literals with nested
`${}`, regex literals, numbers, identifiers and punctuators (`?.`, `&&=`, `||=`,
`??=`, `...` among them). Every rule below reads the tokens, never the raw text.
So a comment marker inside a string, a quote inside a regex, or a call inside a
template substitution cannot hide code.

The lexer fails closed. A file routes consent as `unclassified:unlexable` when it has:

- an unterminated string, comment, template or regex;
- a character outside the token set, a hashbang, or a backslash outside a string;
- a `/` it cannot read as division or as a regex (after `}`, `++` or `--`);
- no tokens at all (an empty file, or one that is only comments or whitespace);
- a size over one million characters.

An identifier with any character outside ASCII routes consent as
`unclassified:non-ascii-identifier`, as does a unicode-escaped identifier. A file
that does not compile as a CommonJS module routes consent as `unclassified:syntax`
(`vm.compileFunction` parses it; nothing runs).

## Routes

A file is fast-path only if no class below matches it. The route is `consent` when
any class matches anywhere in the range, and `fast-path` otherwise.

A name in classes 2 to 5 is a hit wherever it occurs as an identifier token: called,
passed by reference (`keys.map(removeSetting)`), aliased, destructured, optionally
chained (`removeSetting?.(`) or used as a property name. A string that spells one is
data, not a hit, except as the argument of `require`.

1. **Major bump.** The target major is above the pinned major. Always consent.
2. **Irreversible** (always consent). Ghost's own flag, or a helper that sets it:
   - `flag`: the key `irreversible`, bare or quoted, set to `true`.
   - `helper`: `createIrreversibleMigration`.
   - `wrapper`: `dropTables`. It sets the flag, so dropping a table is irreversible.
3. **Destructive** (always consent). Data or structure removed with no way back from
   the migration: `deleteTable`, `recreateTable`, `dropDevelopmentCopy`,
   `removeSetting`, raw `DROP TABLE` or `DELETE FROM` spelled in a string or
   template (escapes are decoded first), `truncate`, `delete`, and `del` other than
   a `.del()` with no argument. Also `noop-rollback`: a `down()` that does nothing, or
   only logs, in a file that also calls something destructive-looking.
4. **Contracting** (routed by `CONTRACTING_ROUTE`, pinned to `consent`). Lossy:
   `dropColumn`, `dropColumns`, `createDropColumnMigration`, `.del()` with no argument,
   and permission removal (`removePermission`, `removePermissionFromRole`,
   `createRemovePermissionMigration`). A rollback re-adds a dropped column empty,
   and a delete loses rows. `removePermission`'s rollback re-adds only the configured
   permission. Its `up` deleted every permission row with the same action and object
   type, and those sibling rows are not restored.
5. **Constraint** (routed by `CONSTRAINT_ROUTE`, pinned to `consent`). Schema-only
   constraint drops: `dropIndex`, `dropUnique`, `dropForeign`. Kept apart from data loss.
6. **Unclassified** (always consent). The fast-path grammar below refused the file.
   The reason is `unclassified:<token>`, the first token the grammar did not accept.
   Only the first is reported; the classes above are all reported.

## Fast-path grammar

A file is fast-path only if it is made entirely of these forms, checked by
`src/grammar.mjs`. Anything else is refused.

- Statements: `const` and `let` declarations that initialise a name once;
  `module.exports = <expression>`; `return`; expression statements; function
  declarations.
- Expressions: literals (a template literal with no substitution), array and object
  literals, spread, function and arrow expressions, `await` in an async function,
  unary `-`, `+`, `!`, and the arithmetic, comparison and logical binary operators.
- Names: a name bound by `require('<known module>')`, or destructured from one with
  keys on the allowlist; a local declared once; a parameter. Every name must be
  declared before it is used, and no name is declared twice in nested scopes.
- Calls, and only these:
  - a bare name bound from a known module, or a property of such a module, whose
    name is in `MODULE_EXPORTS`;
  - `knex(` or `connection(` where that name is a parameter of a migration function,
    meaning a function passed directly to `createTransactionalMigration` or
    `createNonTransactionalMigration`, named `up` or `down`, or held under such a key;
  - a method whose name is in `METHODS` (`where`, `whereNull`, `map`, `toString`) on
    a value that is not a module.
- Refused, whatever the name: any assignment other than the declaration and
  `module.exports` forms (`=`, `+=`, `&&=`, `||=`, `??=`, destructuring assignment,
  `++`), every control-flow word, `?.`, computed access, tagged templates, `new`,
  `class`, getters and methods in object literals, generators, regex literals, a
  property that is not allowlisted, and a call whose callee is a local name or a
  parameter. A local helper is therefore fast-path when handed to `map` or a wrapper
  by reference, and consent when called by name.

Member calls and bare calls are told apart by the token before the identifier
(`.`), never by name. `KNOWN_CALLS` holds each allowed name with its reason; the
lists `MODULE_EXPORTS`, `METHODS` and `HANDLES` in `src/allowlist.mjs` say in which
form a name may be called, and a test pins that each is a `KNOWN_CALLS` key.
`KNOWN_MODULES` lists the modules a file may require. `update` and `raw` are
deliberately not on the allowlist.

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

Run on the Node version in `.nvmrc`. The fixtures under `test/fixtures/versions/` and
`test/fixtures/fast-path/` are copies of upstream Ghost source (see Licence).
Full-line comments were removed from the copies so they pass the repo's
comment-block gate. The code is otherwise unchanged, apart from the formatter's
trailing-comma change. The `fast-path` copies are the 22 files of the real range that
the previous design routed fast-path; the test pins which stay fast-path under the
grammar and which do not, and why. Synthetic sources cover the rules and evasions no
real fixture exercises. The raw SQL in the tests is assembled from parts, so no SQL
literal sits in the source.

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
- **Local helpers called by name.** A file that declares `const add = (n) => ...` and
  calls `add('x')` routes consent, although the helper's body is checked. Allowing it
  needs a rule that a local bound once to a function is callable. It is not built:
  the default is consent.

## Not claimed

This does not establish that a range is safe. It checks migration source against
a fixed grammar and a fixed list of names, and forms outside them route consent as
unclassified. Helpers on the allowlist are trusted on the basis of the reasons beside
them, so a data change written in a form the allowlist accepts, but whose effect the
reason does not cover, passes unseen. The range v6.55.0 to v6.69.0 routes to consent,
and the issue's Done-when is not claimed.
