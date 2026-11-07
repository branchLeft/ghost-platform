import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/** The module sabotaged when a caller names none. */
const DEFAULT_SOURCE = 'tenant/supportSmtpMailer.ts';

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
 * something else, throws instead of passing quietly. `source` is the module's
 * path under `src/` (the SMTP mailer when omitted). The copy's relative
 * imports are pointed back at the module's own directory under `src/` before
 * the target is looked for, so a target or a replacement may name one of
 * them: `../../src/<directory>/<file>` for a real module, or `./<name>.js` for
 * another mutant written by an earlier call.
 */
export async function importSabotaged<T>(
  name: string,
  target: string,
  replacement: string,
  source: string = DEFAULT_SOURCE
): Promise<T> {
  const original = readFileSync(`${SOURCE_ROOT}${source}`, 'utf8');
  const pointed = original.replace(
    /from '\.\/([^']+)'/g,
    (_match, file: string) => `from '../../src/${dirname(source)}/${file}'`
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
