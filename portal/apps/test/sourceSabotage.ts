import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/** A module a test breaks on purpose: its file, and the `src` folder its relative imports point back into. */
export interface Target {
  readonly file: string;
  readonly folder: string;
}

export const MAILER: Target = {
  file: fileURLToPath(new URL('../src/tenant/supportSmtpMailer.ts', import.meta.url)),
  folder: 'tenant',
};

export const POOL: Target = {
  file: fileURLToPath(new URL('../src/shell/pool.ts', import.meta.url)),
  folder: 'shell',
};

/**
 * Where mutants are written: under portal/apps, so a bare `nodemailer` import
 * resolves up to portal/apps/node_modules, and outside `src/**`, so coverage
 * never counts them. Ignored by git and deleted after the run.
 */
export const MUTANT_DIR = fileURLToPath(new URL('./.mutants/', import.meta.url));

export function clearMutants(): void {
  rmSync(MUTANT_DIR, { recursive: true, force: true });
}

/**
 * Loads a copy of a real module with one exact piece of text replaced. The
 * target must occur exactly once, so a mutation that changes nothing, or
 * something else, throws instead of passing quietly. `where` is the module:
 * a `Target`, or its path under `src/` (e.g. `shell/clientLimit.ts`); the SMTP
 * mailer when omitted. The copy's relative imports are pointed back at the
 * module's own directory under `src/` (or at a sibling folder's, for `../x`)
 * before the target is looked for, so a
 * target or a replacement may name one of them: `../../src/<directory>/<file>`
 * for a real module, or `./<name>.js` for another mutant written by an earlier
 * call.
 */
export async function importSabotaged<T>(
  name: string,
  target: string,
  replacement: string,
  where: string | Target = MAILER
): Promise<T> {
  const source: Target =
    typeof where === 'string' ? { file: `${SOURCE_ROOT}${where}`, folder: dirname(where) } : where;
  const original = readFileSync(source.file, 'utf8');
  // One pass, so a path this rewrites is never rewritten again.
  const pointed = original.replace(
    /from '(\.\.?)\/([^']+)'/g,
    (_match, dots: string, file: string) =>
      // A sibling folder's module, as `../shell/html.js` from `src/tenant`.
      dots === '..' ? `from '../../src/${file}'` : `from '../../src/${source.folder}/${file}'`
  );
  const occurrences = pointed.split(target).length - 1;
  if (occurrences !== 1) {
    throw new Error(`sabotage target must occur exactly once, found ${occurrences}`);
  }
  const mutated = pointed.replace(target, () => replacement);
  mkdirSync(MUTANT_DIR, { recursive: true });
  const file = `${MUTANT_DIR}${name}.ts`;
  writeFileSync(file, mutated);
  return (await import(/* @vite-ignore */ file)) as T;
}
