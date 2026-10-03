import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TenantDb, bindTenant, type Tx } from '../src/tenant/index.js';

const TENANT_DIR = join(import.meta.dirname, '../src/tenant');

describe('the tenant-facing source', () => {
  const files = readdirSync(TENANT_DIR).filter((name) => name.endsWith('.ts'));

  it('exists', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s never imports the owner path or the migrator', (file) => {
    const source = readFileSync(join(TENANT_DIR, file), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/owner|migrate/);
    }
  });
});

describe('the compile-time guarantee', () => {
  // These lines are checked by `tsc --noEmit`, not by vitest: each directive
  // fails the type check if the call it covers ever starts to compile.
  it('cannot express a tenant-facing run without a scope', () => {
    const db = new TenantDb(null as never);
    const work = async (_tx: Tx) => 1;
    // @ts-expect-error a scope is a required argument
    void db.run(work).catch(() => undefined);
    // @ts-expect-error a bare string is not a scope
    void db.run('11111111-1111-4111-8111-111111111111', work).catch(() => undefined);
    // @ts-expect-error an object shaped like a scope is not a scope
    void db.run({ tenantId: '11111111-1111-4111-8111-111111111111' }, work).catch(() => undefined);
    expect(bindTenant('11111111-1111-4111-8111-111111111111')).toBeDefined();
  });
});
