/**
 * Fixtures for the promotion chain log tests. The keys are made in memory for
 * the test and never touch a disk. `forgeLine` restates the line format in the
 * test on purpose: a test that reused the module's own serialiser would pass
 * whatever format the module wrote.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { rm } from 'node:fs/promises';

export interface TestKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function makeKeys(): TestKeys {
  return generateKeyPairSync('ed25519');
}

export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const GENESIS = '0'.repeat(64);

export const FIXED_NOW = new Date('2026-11-12T03:00:00.000Z');

export interface ForgeFields {
  seq: number;
  prev: string;
  promotion?: string;
  slot?: string;
  digest?: string;
  at?: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A correctly signed, correctly formatted line, for building logs the module did not write. */
export function forgeLine(keys: TestKeys, fields: ForgeFields): string {
  const body = {
    version: 1,
    seq: fields.seq,
    at: fields.at ?? '2026-11-12T03:00:00.000Z',
    promotion: fields.promotion ?? 'promo-1',
    slot: fields.slot ?? 'slot-0',
    digest: fields.digest ?? DIGEST_A,
    prev: fields.prev,
  };
  const message = Buffer.from(
    'branchleft.promotion-chain.v1\n' +
      JSON.stringify([
        body.version,
        body.seq,
        body.at,
        body.promotion,
        body.slot,
        body.digest,
        body.prev,
      ]),
    'utf8'
  );
  const signature = sign(null, message, keys.privateKey).toString('base64');
  return JSON.stringify({ ...body, signature });
}

export async function removeAll(paths: string[]): Promise<void> {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}
