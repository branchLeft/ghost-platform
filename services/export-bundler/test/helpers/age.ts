import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const CHILD_ENV = { PATH: process.env.PATH ?? '' };

export interface AgeIdentity {
  readonly identityPath: string;
  readonly recipient: string;
}

/** A throwaway X25519 identity from the real `age-keygen`, written into `dir`. */
export function generateAgeIdentity(dir: string): AgeIdentity {
  const identityPath = join(dir, 'identity.txt');
  execFileSync('age-keygen', ['-o', identityPath], { env: CHILD_ENV, stdio: 'pipe' });
  const recipient = execFileSync('age-keygen', ['-y', identityPath], { env: CHILD_ENV })
    .toString('utf8')
    .trim();
  return { identityPath, recipient };
}

export function decryptAge(ciphertextPath: string, identityPath: string): Buffer {
  return execFileSync('age', ['-d', '-i', identityPath, ciphertextPath], { env: CHILD_ENV });
}

export function encryptAgeTo(plaintext: Buffer, recipients: readonly string[]): Buffer {
  const args = recipients.flatMap((r) => ['-r', r]);
  return execFileSync('age', args, { env: CHILD_ENV, input: plaintext });
}

/** One member of a tar archive held in memory, read by the system `tar`. */
export function tarMember(archive: Buffer, member: string): Buffer {
  const result = spawnSync('tar', ['-xOf', '-', member], { env: CHILD_ENV, input: archive });
  if (result.status !== 0) {
    throw new Error(`tar -x ${member} exited ${result.status}: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

export function tarListing(archive: Buffer): string[] {
  const result = spawnSync('tar', ['-tf', '-'], { env: CHILD_ENV, input: archive });
  if (result.status !== 0) {
    throw new Error(`tar -t exited ${result.status}: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout.toString('utf8').trim().split('\n');
}

/** Every regular file under `dir`, recursively. */
export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await filesUnder(path)));
    else if (info.isFile()) out.push(path);
  }
  return out;
}

/** The files under `dir` whose bytes contain `marker`. */
export async function filesContaining(dir: string, marker: string): Promise<string[]> {
  const hits: string[] = [];
  for (const path of await filesUnder(dir)) {
    if ((await readFile(path)).includes(Buffer.from(marker, 'utf8'))) hits.push(path);
  }
  return hits;
}
