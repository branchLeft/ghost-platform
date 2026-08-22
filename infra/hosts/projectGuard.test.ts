import { describe, expect, it } from 'vitest';

import { assertEstateProject, checkServersResult, mailProjectServersIn } from './projectGuard';

describe('mailProjectServersIn', () => {
  it('finds the sentinel among other servers', () => {
    expect(mailProjectServersIn(['edge1', 'mx1', 'db1'])).toEqual(['mx1']);
  });

  it('returns nothing for an estate-shaped inventory', () => {
    expect(mailProjectServersIn(['edge1', 'app1', 'db1'])).toEqual([]);
  });
});

describe('assertEstateProject', () => {
  it('passes an empty project — the estate before its first apply', () => {
    expect(() => assertEstateProject([])).not.toThrow();
  });

  it('passes a project holding only estate hosts', () => {
    expect(() => assertEstateProject(['edge1', 'app1', 'db1'])).not.toThrow();
  });

  it('throws when the mail sentinel is visible', () => {
    expect(() => assertEstateProject(['mx1'])).toThrowError(/mail project/);
  });

  it('names only the sentinel it matched, never the rest of the inventory', () => {
    try {
      assertEstateProject(['mx1', 'some-secret-host']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('mx1');
      expect((error as Error).message).not.toContain('some-secret-host');
    }
  });
});

describe('checkServersResult', () => {
  // The shape-reading is the part only exercised against a live account
  // otherwise; a wrong field name here reads as a guard that passes
  // everything.
  it('reads names from the data-source shape and applies the assertion', () => {
    expect(checkServersResult({ servers: [{ name: 'edge1' }] })).toBe(true);
    expect(() => checkServersResult({ servers: [{ name: 'mx1' }] })).toThrowError(/mail project/);
  });
});
