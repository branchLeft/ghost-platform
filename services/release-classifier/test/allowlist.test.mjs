import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_CALLS } from '../src/classify.mjs';
import {
  HANDLES,
  KNOWN_MODULES,
  METHODS,
  MIGRATION_ENTRY_NAMES,
  MIGRATION_WRAPPERS,
  MODULE_EXPORTS,
} from '../src/allowlist.mjs';

test('every callable form names a KNOWN_CALLS entry that states its reason', () => {
  for (const name of [...MODULE_EXPORTS, ...METHODS, ...HANDLES, ...MIGRATION_WRAPPERS]) {
    assert.ok(Object.hasOwn(KNOWN_CALLS, name), `${name} has no KNOWN_CALLS entry`);
    assert.ok(KNOWN_CALLS[name].length > 10, `${name} has no reason`);
  }
  for (const name of Object.keys(KNOWN_CALLS)) {
    const forms = [...MODULE_EXPORTS, ...METHODS, ...HANDLES];
    assert.ok(forms.includes(name), `${name} is allowlisted but callable in no form`);
  }
});

test('every known module states its reason', () => {
  assert.ok(Object.keys(KNOWN_MODULES).length > 0);
  for (const [path, reason] of Object.entries(KNOWN_MODULES)) {
    assert.ok(reason.length > 10, `${path} has no reason`);
  }
});

test('the writing and free-form query methods are not on the allowlist', () => {
  for (const name of ['update', 'raw', 'insert', 'del', 'delete', 'truncate', 'schema']) {
    assert.equal(Object.hasOwn(KNOWN_CALLS, name), false, name);
  }
});

test('the rollback residual is stated on each helper that has one', () => {
  for (const name of [
    'addTable',
    'addSetting',
    'addPermissionToRole',
    'addPermissionWithRoles',
    'createAddColumnMigration',
  ]) {
    assert.match(KNOWN_CALLS[name], /rollback/, name);
    assert.match(KNOWN_CALLS[name], /up was skipped/, name);
  }
});

test('the migration entry names and wrappers are the ones Ghost defines', () => {
  assert.deepEqual([...MIGRATION_ENTRY_NAMES], ['up', 'down']);
  assert.deepEqual(
    [...MIGRATION_WRAPPERS],
    ['createTransactionalMigration', 'createNonTransactionalMigration']
  );
});
