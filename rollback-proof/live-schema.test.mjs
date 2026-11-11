import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseColumns } from './live-schema.mjs';

describe('parseColumns', () => {
  it('reads the five tab-separated fields of each row', () => {
    const rows = parseColumns(
      'posts\tid\tNO\t0\t0\nposts\tstatus\tNO\t1\t0\nposts\tuuid\tYES\t0\t1\n'
    );
    assert.deepEqual(rows, [
      { table: 'posts', column: 'id', nullable: false, hasDefault: false, generated: false },
      { table: 'posts', column: 'status', nullable: false, hasDefault: true, generated: false },
      { table: 'posts', column: 'uuid', nullable: true, hasDefault: false, generated: true },
    ]);
  });

  it('ignores blank lines and returns nothing for no output', () => {
    assert.deepEqual(parseColumns(''), []);
    assert.deepEqual(parseColumns('\n\n'), []);
  });

  it('refuses a row it does not understand rather than guessing', () => {
    assert.throws(() => parseColumns('posts\tid\tNO\t0\n'), /unexpected catalogue row/);
    assert.throws(() => parseColumns('posts\tid\tMAYBE\t0\t0\n'), /unexpected nullable/);
  });
});
