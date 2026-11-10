import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import type { ImageProvenanceDeps } from '../../src/controlPlaneImagePush.js';
import {
  pushDemoSidecar,
  SidecarPushConfigError,
  sidecarPushEnv,
} from '../../src/controlPlaneSidecarPush.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const MANIFEST = `sha256:${'c'.repeat(64)}`;

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

describe('sidecarPushEnv', () => {
  const full = {
    SIDECAR_MANIFEST_DIGEST: MANIFEST,
    PUSH_BASE_URL: 'http://host.invalid:1',
    PUSH_KEY_PATH: '/k',
    PUSH_TAR_PATH: '/t',
  };

  it('reads the four settings', () => {
    expect(sidecarPushEnv(full)).toEqual({
      manifestDigest: MANIFEST,
      baseUrl: 'http://host.invalid:1',
      keyPath: '/k',
      tarPath: '/t',
    });
  });

  it.each(Object.keys(full))('refuses when %s is missing or empty', (name) => {
    expect(() => sidecarPushEnv({ ...full, [name]: undefined })).toThrow(SidecarPushConfigError);
    expect(() => sidecarPushEnv({ ...full, [name]: '' })).toThrow(`${name} is not set`);
  });
});

describe('pushDemoSidecar', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function setup(): Promise<{ keyPath: string; tarPath: string }> {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-sidecar-push-');
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, broker.keyPair.privateKeyRaw);
    return { keyPath, tarPath: join(dir, 'image.tar') };
  }

  it('verifies the sidecar workflow attestation, pushes, and returns the one env line the host needs', async () => {
    const bytes = Buffer.from('sidecar docker save bytes');
    const { keyPath, tarPath } = await setup();
    const { deps, calls } = fakeDeps(bytes);

    const out = await pushDemoSidecar(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath },
      deps,
      Math.floor(broker!.nowMs() / 1000)
    );

    expect(calls[0]).toBe(`verify ghcr.io/branchleft/drain-sidecar@${MANIFEST} branchLeft/ghost-platform/.github/workflows/drain-sidecar-image.yml`);
    expect(out.push.ok).toBe(true);
    expect(out.tarDigest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(out.envLine).toBe(`DEMO_SIDECAR_IMAGE=ghcr.io/branchleft/drain-sidecar@${MANIFEST}`);
    expect(broker!.imageLoader.calls).toHaveLength(1);
  });

  it('returns no env line when the host refuses the push', async () => {
    const bytes = Buffer.from('sidecar docker save bytes');
    const { keyPath, tarPath } = await setup();
    const { deps } = fakeDeps(bytes);

    const out = await pushDemoSidecar(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath },
      deps,
      // A request signed far outside the replay window is refused by the host.
      Math.floor(broker!.nowMs() / 1000) - 100000
    );

    expect(out.push.ok).toBe(false);
    expect(out.envLine).toBeUndefined();
  });

  it('refuses an unattested sidecar before any pull', async () => {
    const bytes = Buffer.from('x');
    const { keyPath, tarPath } = await setup();
    const { deps, calls } = fakeDeps(bytes);
    const unattested: ImageProvenanceDeps = { ...deps, verifyAttestation: async () => false };

    await expect(
      pushDemoSidecar({ manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath, tarPath }, unattested)
    ).rejects.toThrow(/unattested/);
    expect(calls).toHaveLength(0);
    expect(broker!.imageLoader.calls).toHaveLength(0);
  });
});
