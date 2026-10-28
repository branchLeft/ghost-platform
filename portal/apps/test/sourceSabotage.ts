import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/tenant/supportSmtpMailer.ts', import.meta.url));

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
 * Loads a copy of the real mailer module with one exact piece of text
 * replaced. The target must occur exactly once, so a mutation that changes
 * nothing, or something else, throws instead of passing quietly. The copy's
 * relative imports are pointed back at `src/tenant`.
 */
export async function importSabotaged<T>(
  name: string,
  target: string,
  replacement: string
): Promise<T> {
  const original = readFileSync(SOURCE, 'utf8');
  const occurrences = original.split(target).length - 1;
  if (occurrences !== 1) {
    throw new Error(`sabotage target must occur exactly once, found ${occurrences}`);
  }
  const mutated = original
    .replace(target, replacement)
    .replace(/from '\.\/([^']+)'/g, "from '../../src/tenant/$1'");
  mkdirSync(MUTANT_DIR, { recursive: true });
  const file = `${MUTANT_DIR}${name}.ts`;
  writeFileSync(file, mutated);
  return (await import(/* @vite-ignore */ file)) as T;
}
