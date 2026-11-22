import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExportShapeError, rewriteExport, type UploadMap } from '../../src/promotionRewrite.js';

const FIXTURE = new URL('../fixtures/promotionRewrite/', import.meta.url);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURE), 'utf8')) as unknown;
}

const demo = readJson('demo-export.json');
const uploads: UploadMap = new Map(
  Object.entries(readJson('uploads.json') as Record<string, string>)
);
const OWNER = 'u-tenant-owner';

type Rows = Record<string, Record<string, unknown>[]>;

function data(exported: unknown): Rows {
  const root = exported as { db: { data: Rows }[] };
  return root.db[0]!.data;
}

function rewrite(leaveOut?: readonly string[]) {
  return rewriteExport(demo, { uploads, ownerId: OWNER, leaveOut });
}

/** Each differing `table.column` (and row id) between two exports, for a golden check to name. */
function differingFields(actual: unknown, expected: unknown): string[] {
  const a = data(actual);
  const e = data(expected);
  const tables = new Set([...Object.keys(a), ...Object.keys(e)]);
  const out: string[] = [];
  for (const table of tables) {
    const left = a[table] ?? [];
    const right = e[table] ?? [];
    left.forEach((row, i) => {
      for (const column of new Set([...Object.keys(row), ...Object.keys(right[i] ?? {})])) {
        if (JSON.stringify(row[column]) !== JSON.stringify(right[i]?.[column])) {
          out.push(`${table}.${column}`);
        }
      }
    });
  }
  return [...new Set(out)].sort();
}

describe('rewriteExport', () => {
  it('matches the golden export for the fixture', () => {
    const expected = readJson('expected.json');
    expect(differingFields(rewrite().export, expected)).toEqual([]);
    expect(rewrite().export).toEqual(expected);
  });

  it('lists the one content path the upload did not answer, by reference, and leaves it as it is', () => {
    const { export: out, unanswered } = rewrite();
    expect(unanswered).toEqual(['__GHOST_URL__/content/images/2026/11/missing.png']);
    expect(JSON.stringify(out)).toContain('__GHOST_URL__/content/images/2026/11/missing.png');
  });

  it('leaves no demo origin or answered content path in any rewritten field', () => {
    const text = JSON.stringify(rewrite().export);
    expect(text).not.toContain('demo.ghost.test');
    expect(text).not.toContain('my%20photo');
    expect(text).not.toContain('images/2026/11/hero.jpg');
    expect(text.match(/__GHOST_URL__\/content\//g)).toHaveLength(1);
  });

  it('replaces a file name with regular-expression characters by exact text', () => {
    const lexical = data(rewrite().export).posts![0]!.lexical as string;
    expect(lexical).toContain('https://media.example.test/t-fixture/my-photo-1.jpg');
    expect(lexical).not.toContain('my photo (1).JPG');
  });

  it('replaces a percent-encoded spelling of a file name', () => {
    const html = data(rewrite().export).posts![0]!.html as string;
    expect(html).toContain('https://media.example.test/t-fixture/my-photo-1.jpg');
    expect(html).not.toContain('%20');
  });

  it('removes every demo user and their role rows, so no staff rides along', () => {
    const out = data(rewrite().export);
    expect(out).not.toHaveProperty('users');
    const users = (out.roles_users ?? []).map((r) => r.user_id);
    expect(users).toEqual([]);
    expect(out.permissions_users).toEqual([]);
    expect(out.roles).toHaveLength(3);
  });

  it('points every post creator and author at the tenant owner, one author per post', () => {
    const out = data(rewrite().export);
    expect(out.posts![0]).toMatchObject({ created_by: OWNER, updated_by: OWNER });
    expect(out.posts_authors).toEqual([
      { id: 'pa-1', post_id: 'post-1', author_id: OWNER, sort_order: 0 },
    ]);
  });

  it('drops the settings the tenant owns and keeps the rest with the origin rewritten', () => {
    const settings = data(rewrite().export).settings!;
    const keys = settings.map((s) => s.key);
    expect(keys).toEqual(['title', 'navigation', 'logo', 'og_image']);
    const navigation = settings.find((s) => s.key === 'navigation')!.value as string;
    expect(navigation).toContain('__GHOST_URL__/about/');
  });

  it('does not change its input', () => {
    const before = JSON.stringify(demo);
    rewrite();
    expect(JSON.stringify(demo)).toBe(before);
  });

  it('refuses an export without db[0].data, and an empty tenant owner', () => {
    expect(() => rewriteExport({}, { uploads, ownerId: OWNER })).toThrow(ExportShapeError);
    expect(() => rewriteExport(null, { uploads, ownerId: OWNER })).toThrow(ExportShapeError);
    expect(() => rewriteExport({ db: [{}] }, { uploads, ownerId: OWNER })).toThrow(
      ExportShapeError
    );
    expect(() => rewriteExport(demo, { uploads, ownerId: '  ' })).toThrow(TypeError);
  });

  describe('control case: a field left out of the rewrite fails the golden check', () => {
    it('names og_image on posts_meta when og_image is left out', () => {
      const golden = readJson('expected.json');
      const sabotaged = rewrite(['posts_meta.og_image']).export;
      expect(differingFields(sabotaged, golden)).toEqual(['posts_meta.og_image']);
    });

    it('still finds no og_image mismatch when it is not left out', () => {
      const golden = readJson('expected.json');
      expect(differingFields(rewrite().export, golden)).not.toContain('posts_meta.og_image');
    });
  });
});
