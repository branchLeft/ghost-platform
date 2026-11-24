import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Two migrations sharing one number would both sort first under the same
// prefix, and the journal would apply them in an order no one chose. Every
// shipped migration file must have its own number, and the journal must list
// exactly those files, in order.
const DRIZZLE = fileURLToPath(new URL('../drizzle', import.meta.url));

const sqlFiles = readdirSync(DRIZZLE).filter((name) => name.endsWith('.sql'));
const numberOf = (name: string): string => name.slice(0, 4);

describe('migration numbers', () => {
  it('give each migration file its own number', () => {
    const numbers = sqlFiles.map(numberOf);
    const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });

  it('are the journal’s entries, in order, with no gap or repeat', () => {
    const journal = JSON.parse(readFileSync(`${DRIZZLE}/meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(tags.map((_, i) => i));
    expect(tags.map((tag) => `${tag}.sql`).sort()).toEqual([...sqlFiles].sort());
  });
});
