import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A local typecheck must work from a clean checkout the way CI's does: every
// `link:` dependency is installed and built before `tsc` reads its dist.
// Without this guard the script drifts back to bare `tsc` and only CI passes.

interface PackageJson {
  scripts: Record<string, string | undefined>;
  dependencies: Record<string, string | undefined>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as PackageJson;

const typecheck = pkg.scripts['typecheck'] ?? '';
const steps = typecheck.split(' && ');

const linkedDirs = Object.values(pkg.dependencies)
  .filter((spec): spec is string => spec?.startsWith('link:') === true)
  .map((spec) => spec.slice('link:'.length));

describe('demo-gate typecheck script', () => {
  it('links at least one sibling package', () => {
    expect(linkedDirs.length).toBeGreaterThan(0);
  });

  for (const dir of linkedDirs) {
    it(`installs and builds ${dir} before tsc reads it`, () => {
      const install = steps.indexOf(`pnpm --dir ${dir} install --frozen-lockfile`);
      const build = steps.indexOf(`pnpm --dir ${dir} run build`);
      const tsc = steps.indexOf('tsc --noEmit');
      expect(install).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(install);
      expect(tsc).toBeGreaterThan(build);
    });
  }

  it('ends with tsc --noEmit', () => {
    expect(steps.at(-1)).toBe('tsc --noEmit');
  });
});
