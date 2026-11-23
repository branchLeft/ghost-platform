/**
 * One-shot entry: renders and validates slot 0's descriptor and writes it to
 * DESCRIPTOR_OUT (created exclusively, owner-only). The gate passphrase is
 * read from stdin, never argv. Environment wiring only, so it is excluded
 * from coverage like server.ts; the logic is in slot0Descriptor.ts.
 *
 * Reads: SLOT0_IMAGE_DIGEST, SLOT0_APP_HOST_IP, SLOT0_OWNER_EMAIL, SLOT0_EXPIRES_AT,
 * DESCRIPTOR_OUT, and the four zone variables zonesFromEnv reads.
 */
import { writeFile } from 'node:fs/promises';
import { zonesFromEnv } from './config.js';
import { mintGateHash, renderSlot0Descriptor } from './slot0Descriptor.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const passphrase = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '');

const outPath = required('DESCRIPTOR_OUT');
const descriptor = renderSlot0Descriptor({
  imageDigest: required('SLOT0_IMAGE_DIGEST'),
  appHostIp: required('SLOT0_APP_HOST_IP'),
  ownerEmail: required('SLOT0_OWNER_EMAIL'),
  expiresAt: required('SLOT0_EXPIRES_AT'),
  gateArgon2idHash: await mintGateHash(passphrase),
  zones: zonesFromEnv(process.env),
});
await writeFile(outPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(
  `${JSON.stringify({ wrote: outPath, slot: '0', kind: descriptor.kind, image: descriptor.image })}\n`
);
