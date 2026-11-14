/**
 * Key files for the loader and recorder tests. The keys are generated at test
 * time, in a throwaway directory, and exist nowhere else.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeKeys, type TestKeys } from './chainFixtures.js';

export interface KeyFiles {
  dir: string;
  keys: TestKeys;
  privatePath: string;
  publicPath: string;
}

/** Writes a PKCS8 private key at `mode` and its SPKI public half beside it. */
export async function makeKeyFiles(
  dir: string,
  mode = 0o400,
  keys: TestKeys = makeKeys()
): Promise<KeyFiles> {
  const privatePath = join(dir, 'record-signing.pem');
  const publicPath = join(dir, 'record-signing.pub');
  await writeFile(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  await chmod(privatePath, mode);
  await writeFile(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  return { dir, keys, privatePath, publicPath };
}

/** The base64 body of the private key: the part that must never be printed. */
export function keyBody(made: KeyFiles): string {
  const pem = made.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return pem.split('\n')[1] as string;
}
