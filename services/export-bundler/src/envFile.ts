import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * `docker run --env-file` reads one `KEY=VALUE` per line, verbatim: no
 * quoting and no continuation, so a value holding a newline cannot be
 * carried and is refused rather than split into a second variable.
 */
export function renderEnvFile(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key))
      throw new EnvFileError(`env key ${JSON.stringify(key)} is not a plain name`);
    if (/[\r\n\0]/.test(value)) {
      // The value is never repeated: it may be a secret.
      throw new EnvFileError(`env value for ${key} holds a line break`);
    }
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Hands the tenant's environment to `docker` as a file instead of argv, so
 * no secret is visible in `ps`. The file is written 0600 inside a fresh
 * 0700 directory and removed when `fn` settles, and also on SIGINT/SIGTERM.
 */
export async function withEnvFile<T>(
  env: Readonly<Record<string, string>>,
  fn: (envFilePath: string) => Promise<T>
): Promise<T> {
  const content = renderEnvFile(env);
  const dir = await mkdtemp(join(tmpdir(), 'export-bundler-env-'));
  const removeNow = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    removeNow();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const path = join(dir, 'tenant.env');
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
    return await fn(path);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await rm(dir, { recursive: true, force: true });
  }
}
