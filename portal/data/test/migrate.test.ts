import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnisolatedTableError, migrate } from '../src/migrate.js';
import { createFixture, type Fixture } from './helpers.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await createFixture();
});

afterAll(async () => {
  await fx.close();
});

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'portal-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

describe('migrate', () => {
  it('applies nothing the second time', async () => {
    expect(await migrate(fx.admin)).toEqual([]);
  });

  it('records a migration and applies it once', async () => {
    const dir = await dirWith({
      '0002_x.sql': 'CREATE TABLE portal.plain (id int)',
      'readme.txt': 'ignored',
    });
    expect(await migrate(fx.admin, dir)).toEqual(['0002_x.sql']);
    expect(await migrate(fx.admin, dir)).toEqual([]);
  });

  it('rolls a failing migration back whole and records nothing', async () => {
    const dir = await dirWith({
      '0003_bad.sql': 'CREATE TABLE portal.half (id int); SELECT 1/0;',
    });
    await expect(migrate(fx.admin, dir)).rejects.toThrow(/division by zero/);
    const { rows } = await fx.admin.query("SELECT to_regclass('portal.half') AS t");
    expect(rows[0].t).toBeNull();
  });

  it('refuses a tenant table with no isolation', async () => {
    const dir = await dirWith({ '0004_open.sql': 'CREATE TABLE portal.open_t (tenant_id uuid)' });
    const error = await migrate(fx.admin, dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnisolatedTableError);
    expect((error as UnisolatedTableError).tables).toEqual(['open_t']);
    await fx.admin.query('DROP TABLE portal.open_t');
  });

  it('refuses row security enabled without the tenant policy', async () => {
    const dir = await dirWith({
      '0005_half.sql':
        'CREATE TABLE portal.half_t (tenant_id uuid); ALTER TABLE portal.half_t ENABLE ROW LEVEL SECURITY;',
    });
    await expect(migrate(fx.admin, dir)).rejects.toBeInstanceOf(UnisolatedTableError);
    await fx.admin.query('DROP TABLE portal.half_t');
  });
});
