import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import type { ImageProvenanceDeps } from '../../src/controlPlaneImagePush.js';
import {
  pushDemoSlotImage,
  SlotImagePushConfigError,
  slotImagePushEnv,
} from '../../src/controlPlaneSlotImagePush.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const MANIFEST = `sha256:${'d'.repeat(64)}`;

function fakeDeps(bytes: Buffer): { deps: ImageProvenanceDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ImageProvenanceDeps = {
    verifyAttestation: async (ref, signer) => {
      calls.push(`verify ${ref} ${signer}`);
      return true;
    },
    pull: async (ref) => {
      calls.push(`pull ${ref}`);
    },
    repoDigests: async (ref) => [ref],
    save: async (_ref, tarPath) => {
      await writeFile(tarPath, bytes);
    },
  };
  return { deps, calls };
}

describe('slotImagePushEnv', () => {
  const full = {
    SLOT_IMAGE_MANIFEST_DIGEST: MANIFEST,
    PUSH_BASE_URL: 'http://host.invalid:1',
    PUSH_KEY_PATH: '/k',
    PUSH_TAR_PATH: '/t',
  };

  it('reads the four settings', () => {
    expect(slotImagePushEnv(full)).toEqual({
      manifestDigest: MANIFEST,
      baseUrl: 'http://host.invalid:1',
      keyPath: '/k',
      tarPath: '/t',
    });
  });

  it.each(Object.keys(full))('refuses when %s is missing or empty', (name) => {
    expect(() => slotImagePushEnv({ ...full, [name]: undefined })).toThrow(
      SlotImagePushConfigError
    );
    expect(() => slotImagePushEnv({ ...full, [name]: '' })).toThrow(`${name} is not set`);
  });
});

describe('pushDemoSlotImage', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function setup(): Promise<{ keyPath: string; tarPath: string }> {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-slot-image-push-');
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, broker.keyPair.privateKeyRaw);
    return { keyPath, tarPath: join(dir, 'image.tar') };
  }

  it('verifies the registry-push attestation, pushes, and returns the slot image ref the descriptor must pin', async () => {
    const bytes = Buffer.from('ghost docker save bytes');
    const { keyPath, tarPath } = await setup();
    const { deps, calls } = fakeDeps(bytes);

    const out = await pushDemoSlotImage(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath },
      deps,
      Math.floor(broker!.nowMs() / 1000)
    );

    expect(calls[0]).toBe(
      `verify ghcr.io/branchleft/ghost-tenant@${MANIFEST} branchLeft/ghost-platform/.github/workflows/registry-push.yml`
    );
    expect(calls[1]).toBe(`pull ghcr.io/branchleft/ghost-tenant@${MANIFEST}`);
    expect(out.push.ok).toBe(true);
    expect(out.tarDigest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(out.imageRef).toBe(`ghcr.io/branchleft/ghost-tenant@${MANIFEST}`);
    expect(broker!.imageLoader.calls).toHaveLength(1);
  });

  it('returns no image ref when the host refuses the push', async () => {
    const bytes = Buffer.from('ghost docker save bytes');
    const { keyPath, tarPath } = await setup();
    const { deps } = fakeDeps(bytes);

    const out = await pushDemoSlotImage(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath },
      deps,
      // A request signed far outside the replay window is refused by the host.
      Math.floor(broker!.nowMs() / 1000) - 100000
    );

    expect(out.push.ok).toBe(false);
    expect(out.imageRef).toBeUndefined();
  });

  it('refuses an unattested slot image before any pull', async () => {
    const { keyPath, tarPath } = await setup();
    const { deps, calls } = fakeDeps(Buffer.from('x'));
    const unattested: ImageProvenanceDeps = { ...deps, verifyAttestation: async () => false };

    await expect(
      pushDemoSlotImage(
        { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath },
        unattested
      )
    ).rejects.toThrow(/unattested/);
    expect(calls).toHaveLength(0);
    expect(broker!.imageLoader.calls).toHaveLength(0);
  });
});
