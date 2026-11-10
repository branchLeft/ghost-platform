import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  type ImageProvenanceDeps,
  pushOciImage,
} from '../../src/controlPlaneImagePush.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const SIGNER = 'branchLeft/ghost-platform/.github/workflows/drain-sidecar-image.yml';
const IMAGE = 'ghcr.io/branchleft/drain-sidecar';
const MANIFEST = `sha256:${'a'.repeat(64)}`;

/**
 * A recording double for the docker and attestation side. `save` writes
 * real bytes to the tar path, so the caller's hash and the receiver's hash
 * are computed over the same file.
 */
function fakeDeps(
  bytes: Buffer,
  overrides: Partial<ImageProvenanceDeps> = {}
): { deps: ImageProvenanceDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ImageProvenanceDeps = {
    verifyAttestation: async (ref, signer) => {
      calls.push(`verify ${ref} ${signer}`);
      return true;
    },
    pull: async (ref) => {
      calls.push(`pull ${ref}`);
    },
    repoDigests: async (ref) => {
      calls.push(`inspect ${ref}`);
      return [ref];
    },
    save: async (ref, tarPath) => {
      calls.push(`save ${ref}`);
      await writeFile(tarPath, bytes);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('pushOciImage (control-plane caller, generic over image ref)', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('refuses an unattested image before any pull, save or push', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-image-push-');
    const bytes = Buffer.from('tar bytes');
    const { deps, calls } = fakeDeps(bytes, {
      verifyAttestation: async (ref) => {
        calls.push(`verify ${ref}`);
        return false;
      },
    });

    await expect(
      pushOciImage({
        imageRef: IMAGE,
        manifestDigest: MANIFEST,
        signerWorkflow: SIGNER,
        baseUrl: broker.baseUrl,
        privateKeyRaw: broker.keyPair.privateKeyRaw,
        tarPath: join(dir, 'image.tar'),
        deps,
        nowSeconds: Math.floor(broker.nowMs() / 1000),
      })
    ).rejects.toThrow(/unattested/);

    expect(calls).toEqual([`verify ${IMAGE}@${MANIFEST}`]);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('refuses when the pulled image is not the declared manifest digest', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-image-push-');
    const bytes = Buffer.from('tar bytes');
    const other = `${IMAGE}@sha256:${'b'.repeat(64)}`;
    const { deps, calls } = fakeDeps(bytes, {
      repoDigests: async (ref) => {
        calls.push(`inspect ${ref}`);
        return [other];
      },
    });

    await expect(
      pushOciImage({
        imageRef: IMAGE,
        manifestDigest: MANIFEST,
        signerWorkflow: SIGNER,
        baseUrl: broker.baseUrl,
        privateKeyRaw: broker.keyPair.privateKeyRaw,
        tarPath: join(dir, 'image.tar'),
        deps,
        nowSeconds: Math.floor(broker.nowMs() / 1000),
      })
    ).rejects.toThrow(/not the declared manifest digest/);

    expect(calls.some((c) => c.startsWith('save'))).toBe(false);
    expect(broker.imageLoader.calls).toHaveLength(0);
  });

  it('declares the tar own sha256 to the receiver, never the manifest digest, and the receiver loads it', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-image-push-');
    const tarPath = join(dir, 'image.tar');
    const bytes = Buffer.from('stand-in docker save bytes, read back from disk');
    const { deps } = fakeDeps(bytes);
    const tarDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const out = await pushOciImage({
      imageRef: IMAGE,
      manifestDigest: MANIFEST,
      signerWorkflow: SIGNER,
      baseUrl: broker.baseUrl,
      privateKeyRaw: broker.keyPair.privateKeyRaw,
      tarPath,
      deps,
      nowSeconds: Math.floor(broker.nowMs() / 1000),
    });

    expect(out.tarDigest).toBe(tarDigest);
    expect(out.tarDigest).not.toBe(MANIFEST);
    expect(out.push.ok).toBe(true);
    expect(out.push.body).toMatchObject({ digest: tarDigest });
    expect(broker.imageLoader.calls).toHaveLength(1);
  });

  it('refuses a malformed image ref or manifest digest before calling anything', async () => {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-image-push-');
    const bytes = Buffer.from('tar bytes');
    const base = {
      signerWorkflow: SIGNER,
      baseUrl: broker.baseUrl,
      privateKeyRaw: broker.keyPair.privateKeyRaw,
      tarPath: join(dir, 'image.tar'),
    };

    const badRef = fakeDeps(bytes);
    await expect(
      pushOciImage({
        ...base,
        imageRef: 'docker.io/library/nginx',
        manifestDigest: MANIFEST,
        deps: badRef.deps,
      })
    ).rejects.toThrow(/image ref/);
    expect(badRef.calls).toHaveLength(0);

    const badDigest = fakeDeps(bytes);
    await expect(
      pushOciImage({
        ...base,
        imageRef: IMAGE,
        manifestDigest: 'sha256:abc',
        deps: badDigest.deps,
      })
    ).rejects.toThrow(/manifest digest/);
    expect(badDigest.calls).toHaveLength(0);
  });
});
