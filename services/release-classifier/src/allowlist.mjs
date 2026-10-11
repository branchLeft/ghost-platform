// What a fast-path migration may call, and where it may import from. Anything
// not named here routes consent. Each entry states what it does to data; the
// reasons are the only support for trusting an entry, so keep them honest.

// Fail-closed allowlist of callable names. Each entry gives its reason.
export const KNOWN_CALLS = Object.freeze({
  createTransactionalMigration: 'migration wrapper; its inner calls are checked',
  createNonTransactionalMigration: 'migration wrapper; its inner calls are checked',
  combineTransactionalMigrations: 'migration wrapper; its inner calls are checked',
  combineNonTransactionalMigrations: 'migration wrapper; its inner calls are checked',
  knex: 'query-builder entry point; chained methods are checked by name',
  connection: 'the knex handle a migration receives; chained methods are checked by name',
  info: 'logging only',
  warn: 'logging only, as info',
  createAddColumnMigration:
    'adds the column if absent; the rollback drops the column whenever it exists, so if up was skipped the pre-existing column and its data are dropped',
  createAddIndexMigration: 'adds an index; the rollback drops it',
  createRenameColumnMigration: 'renames a column; data is kept',
  createSetNullableMigration: 'changes nullability; no row is removed',
  addTable:
    'creates the table if absent; the rollback drops it whether or not up created it, so if up was skipped the pre-existing table and its rows are dropped. The replaceDevelopmentCopy option is dev and test only and is invisible here',
  addSetting:
    'inserts the setting if absent; the rollback deletes it by key whether or not up inserted it, so if up was skipped the pre-existing setting is deleted',
  addPermissionToRole:
    'links a permission to a role if not linked; the rollback deletes the link whether or not up created it, so if up was skipped the pre-existing link is deleted',
  addPermissionWithRoles:
    'adds a permission and its role links; the rollback deletes every permission row with the same action and object, not only this one, and runs even if up was skipped',
  where: 'query filter; reads or narrows, writes nothing',
  whereNull: 'query filter; reads or narrows, writes nothing',
  map: 'array method; no database effect',
  isSQLite: 'dialect check; no database effect',
  randomBytes: 'generates an id; no database effect',
  toString: 'string conversion; no database effect',
});

// Not on the allowlist, on purpose: update (writes arbitrary values, and a rollback
// cannot restore the old ones) and raw (free-form SQL the rules cannot read).

// The form each call may take. A name is callable only in the form listed, and
// every name here must also be a KNOWN_CALLS key with its reason.

// Called as a bare name that the file imported from a known module, or as a
// property of such a module: `addSetting(...)`, `utils.addSetting(...)`.
export const MODULE_EXPORTS = Object.freeze([
  'createTransactionalMigration',
  'createNonTransactionalMigration',
  'combineTransactionalMigrations',
  'combineNonTransactionalMigrations',
  'createAddColumnMigration',
  'createAddIndexMigration',
  'createRenameColumnMigration',
  'createSetNullableMigration',
  'addTable',
  'addSetting',
  'addPermissionToRole',
  'addPermissionWithRoles',
  'isSQLite',
  'randomBytes',
  'info',
  'warn',
]);

// Called as a method on a value that is not a module: `knex('t').where(...)`.
export const METHODS = Object.freeze(['where', 'whereNull', 'map', 'toString']);

// Called as a bare name only where it is a parameter of a migration function.
export const HANDLES = Object.freeze(['knex', 'connection']);

// A function passed directly to one of these is a migration function, so its
// parameters may be the handles above.
export const MIGRATION_WRAPPERS = Object.freeze([
  'createTransactionalMigration',
  'createNonTransactionalMigration',
]);

// A function named so, or held under a key so named, is a migration function too.
export const MIGRATION_ENTRY_NAMES = Object.freeze(['up', 'down']);

// Modules a fast-path file may require. Any other path routes consent.
export const KNOWN_MODULES = Object.freeze({
  '../../utils': 'Ghost migration helpers; each helper used is checked by name',
  '@tryghost/logging': 'logging only',
  crypto: 'id generation; randomBytes is the only helper checked',
  '@tryghost/database-info': 'dialect check; isSQLite is the only helper checked',
});
