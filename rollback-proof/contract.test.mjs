import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkContract, compareContract, expectedColumns, liveColumns } from './contract.mjs';

const col = (table, column, extra = {}) => ({
  table,
  column,
  nullable: true,
  hasDefault: false,
  generated: false,
  ...extra,
});
const req = { nullable: false };
const withDefault = { nullable: false, hasDefault: true };

// What the measured break looked like: the old image's email_batches table, and
// the same table after the release that renamed provider_id.
const oldSchema = {
  email_batches: {
    id: { type: 'string', nullable: false, primary: true },
    email_id: { type: 'string', nullable: false },
    provider_id: { type: 'string', nullable: true },
    fallback_sending_domain: { type: 'boolean', nullable: false, defaultTo: false },
    status: { type: 'string', nullable: false, defaultTo: 'pending' },
    '@@INDEXES@@': [['email_id']],
  },
};
const unmigratedRows = [
  col('email_batches', 'id', req),
  col('email_batches', 'email_id', req),
  col('email_batches', 'provider_id'),
  col('email_batches', 'fallback_sending_domain', withDefault),
  col('email_batches', 'status', withDefault),
];
const migratedRows = [
  col('email_batches', 'id', req),
  col('email_batches', 'email_id', req),
  col('email_batches', 'mailgun_message_id'),
  col('email_batches', 'fallback_sending_domain', withDefault),
  col('email_batches', 'status', withDefault),
];

describe('the measured break', () => {
  it('is found: the old image writes provider_id and the migrated table has no such column', () => {
    const findings = checkContract(oldSchema, unmigratedRows, migratedRows);
    assert.deepEqual(
      findings.map((f) => [f.kind, f.table, f.column]),
      [['missing-column', 'email_batches', 'provider_id']]
    );
    assert.match(findings[0].text, /email_batches\.provider_id/);
  });

  it('CONTROL: the same schema against a database that was never migrated has no findings', () => {
    assert.deepEqual(checkContract(oldSchema, unmigratedRows, unmigratedRows), []);
  });

  it('does not read the table metadata key as a column', () => {
    const expected = expectedColumns(oldSchema);
    assert.equal(expected.get('email_batches').has('@@INDEXES@@'), false);
  });
});

describe('what else breaks the old code', () => {
  const schema = { posts: { id: {}, title: {} } };
  const base = [col('posts', 'id', req), col('posts', 'title', req)];

  it('a dropped table', () => {
    const findings = checkContract(schema, base, [col('tags', 'id', req)]);
    assert.deepEqual(
      findings.map((f) => f.kind),
      ['missing-table']
    );
  });

  it('a new column that is not null with no default', () => {
    const findings = checkContract(schema, base, [...base, col('posts', 'slug_v2', req)]);
    assert.deepEqual(
      findings.map((f) => [f.kind, f.column]),
      [['unknown-required-column', 'slug_v2']]
    );
  });

  it('a new column with a default, nullable, or generated is harmless', () => {
    const after = [
      ...base,
      col('posts', 'with_default', withDefault),
      col('posts', 'optional'),
      col('posts', 'auto', { nullable: false, generated: true }),
    ];
    assert.deepEqual(checkContract(schema, base, after), []);
  });

  it('a column the old image could omit that the migration made required', () => {
    const lax = { posts: { id: {}, note: {} } };
    const before = [col('posts', 'id', req), col('posts', 'note')];
    const after = [col('posts', 'id', req), col('posts', 'note', req)];
    assert.deepEqual(
      checkContract(lax, before, after).map((f) => f.kind),
      ['column-now-required']
    );
    const afterWithDefault = [col('posts', 'id', req), col('posts', 'note', withDefault)];
    assert.deepEqual(checkContract(lax, before, afterWithDefault), []);
  });

  it('CONTROL: a column the schema file leaves implicit but the database has always required is no change', () => {
    // The shape of Ghost's brute table: the schema file gives no nullable key and
    // the database column is not null from the start. A check that read the
    // schema file alone called every such column a finding on an unchanged image.
    const brute = { brute: { key: {}, count: {} } };
    const rows = [col('brute', 'key', req), col('brute', 'count', req)];
    assert.deepEqual(checkContract(brute, rows, rows), []);
  });

  it('a column the database has always required and the old image does not know is no change', () => {
    const rows = [...base, col('posts', 'legacy', req)];
    assert.deepEqual(checkContract(schema, rows, rows), []);
  });

  it('ignores tables the old image has never heard of', () => {
    assert.deepEqual(checkContract(schema, base, [...base, col('brand_new', 'id', req)]), []);
  });

  it('lists every finding, in a stable order', () => {
    const after = [col('posts', 'zzz', req), col('posts', 'aaa', req)];
    const findings = compareContract(
      expectedColumns(schema),
      liveColumns(base),
      liveColumns(after)
    );
    assert.deepEqual(
      findings.map((f) => `${f.kind}:${f.column}`),
      [
        'missing-column:id',
        'missing-column:title',
        'unknown-required-column:aaa',
        'unknown-required-column:zzz',
      ]
    );
  });
});

describe('input it cannot trust', () => {
  it('refuses a schema that is not an object of tables, or has none', () => {
    for (const bad of [null, [], 'x', 3, {}]) {
      assert.throws(() => expectedColumns(bad), /schema/, `input ${JSON.stringify(bad)}`);
    }
    assert.throws(() => expectedColumns({ posts: 'x' }), /not an object/);
  });

  it('refuses a database that reports no columns, which would make every table "missing" or none', () => {
    assert.throws(() => liveColumns([]), /no columns/);
  });
});
