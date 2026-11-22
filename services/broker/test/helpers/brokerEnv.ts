import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../src/atomicFile.js';
import { generateTestKeyPair } from './signer.js';
import { TEST_ZONES } from './fixtures.js';

/**
 * A complete environment for `dist/server.js` to start with, minus `PORT`:
 * the caller (or `spawnBroker`, which picks a free port and retries on
 * EADDRINUSE) decides the port. Every directory is a fresh temp dir.
 */
export async function baseBrokerEnv(): Promise<{
  env: Record<string, string>;
  keyPair: ReturnType<typeof generateTestKeyPair>;
  stateDir: string;
  leaseDir: string;
  drainFlagDir: string;
  slotsPath: string;
}> {
  const root = await makeTempDir('broker-spawn-');
  const keyPair = generateTestKeyPair();
  const keyPath = join(root, 'verify.key');
  await writeFile(keyPath, keyPair.publicKeyRaw);
  const stateDir = join(root, 'state');
  const leaseDir = join(root, 'lease');
  const drainFlagDir = join(root, 'drain');
  const slotDirBase = join(root, 'slots');
  const slotsPath = join(root, 'slots.json');
  const imageTmpDir = join(root, 'image-tmp');
  await mkdir(stateDir, { recursive: true });
  await mkdir(leaseDir, { recursive: true });
  await mkdir(drainFlagDir, { recursive: true });
  await mkdir(slotDirBase, { recursive: true });
  await mkdir(imageTmpDir, { recursive: true });
  return {
    keyPair,
    stateDir,
    leaseDir,
    drainFlagDir,
    slotsPath,
    env: {
      LISTEN_HOST: '127.0.0.1',
      BROKER_VERIFY_KEY_FILE: keyPath,
      BROKER_SLOTS_FILE: slotsPath,
      BROKER_LEASE_DIR: leaseDir,
      BROKER_STATE_DIR: stateDir,
      BROKER_DRAIN_FLAG_DIR: drainFlagDir,
      BROKER_SLOT_DIR_BASE: slotDirBase,
      BROKER_IMAGE_TMP_DIR: imageTmpDir,
      BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
      BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
      BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
      BROKER_DEMO_MAIL_DOMAIN: TEST_ZONES.demoMailDomain,
      BROKER_WRAPPER_COMMAND: join(process.cwd(), 'test/helpers/fakeWrapper.mjs'),
      BROKER_WRAPPER_PREFIX: process.execPath,
      BROKER_SLOT_LITERALS: '0,1,2,3,4,5,6',
    },
  };
}
