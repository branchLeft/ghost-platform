import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const SLOT_REF = `ghcr.io/branchleft/ghost-tenant@${MANIFEST}`;

interface Fake {
  readonly deps: ImageProvenanceDeps;
  readonly calls: string[];
  readonly tarPaths: string[];
  /** What was on disk at the tar path the moment `save` was called. */
  readonly beforeSave: { size: number; mode: number }[];
}

function fakeDeps(bytes: Buffer): Fake {
  const calls: string[] = [];
  const tarPaths: string[] = [];
  const beforeSave: { size: number; mode: number }[] = [];
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
      tarPaths.push(tarPath);
      const info = await stat(tarPath);
      beforeSave.push({ size: info.size, mode: info.mode & 0o777 });
      await writeFile(tarPath, bytes);
    },
  };
  return { deps, calls, tarPaths, beforeSave };
}

describe('slotImagePushEnv', () => {
  const full = {
    SLOT_IMAGE_MANIFEST_DIGEST: MANIFEST,
    PUSH_BASE_URL: 'http://host.invalid:1',
    PUSH_KEY_PATH: '/k',
  };

  it('reads the three settings', () => {
    expect(slotImagePushEnv(full)).toEqual({
      manifestDigest: MANIFEST,
      baseUrl: 'http://host.invalid:1',
      keyPath: '/k',
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
  let stub: Server | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
    if (stub) {
      const server = stub;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    stub = undefined;
  });

  async function setup(): Promise<{ keyPath: string }> {
    broker = await startTestBroker();
    const dir = await makeTempDir('control-plane-slot-image-push-');
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, broker.keyPair.privateKeyRaw);
    return { keyPath };
  }

  /** A host double that answers every request with one fixed status, headers and body. */
  async function stubHost(
    status: number,
    body: string,
    headers: Record<string, string> = {}
  ): Promise<{ baseUrl: string; hits: string[] }> {
    const hits: string[] = [];
    stub = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      req.resume();
      if (req.url !== '/image') {
        // Wherever a redirect points: a page that answers 200.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    });
    await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, hits };
  }

  async function keyOnly(): Promise<string> {
    const dir = await makeTempDir('control-plane-slot-image-push-');
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, Buffer.alloc(32, 7));
    return keyPath;
  }

  it('verifies the registry-push attestation, pushes, and returns the slot image ref the descriptor must pin', async () => {
    const bytes = Buffer.from('ghost docker save bytes');
    const { keyPath } = await setup();
    const { deps, calls } = fakeDeps(bytes);

    const out = await pushDemoSlotImage(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath },
      deps,
      Math.floor(broker!.nowMs() / 1000)
    );

    expect(calls[0]).toBe(
      `verify ghcr.io/branchleft/ghost-tenant@${MANIFEST} branchLeft/ghost-platform/.github/workflows/registry-push.yml`
    );
    expect(calls[1]).toBe(`pull ghcr.io/branchleft/ghost-tenant@${MANIFEST}`);
    expect(out.push.ok).toBe(true);
    expect(out.tarDigest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(out.imageRef).toBe(SLOT_REF);
    expect(broker!.imageLoader.calls).toHaveLength(1);
  });

  it('returns no image ref when the host refuses the push', async () => {
    const { keyPath } = await setup();
    const { deps } = fakeDeps(Buffer.from('ghost docker save bytes'));

    const out = await pushDemoSlotImage(
      { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath },
      deps,
      // A request signed far outside the replay window is refused by the host.
      Math.floor(broker!.nowMs() / 1000) - 100000
    );

    expect(out.push.ok).toBe(false);
    expect(out.imageRef).toBeUndefined();
  });

  it('refuses an unattested slot image before any pull', async () => {
    const { keyPath } = await setup();
    const { deps, calls } = fakeDeps(Buffer.from('x'));
    const unattested: ImageProvenanceDeps = { ...deps, verifyAttestation: async () => false };

    await expect(
      pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath }, unattested)
    ).rejects.toThrow(/unattested/);
    expect(calls).toHaveLength(0);
    expect(broker!.imageLoader.calls).toHaveLength(0);
  });

  describe('the pin needs the host to confirm the digest it was sent', () => {
    it('returns no ref when a 200 reply names a different digest', async () => {
      const keyPath = await keyOnly();
      const { baseUrl } = await stubHost(
        200,
        JSON.stringify({ digest: `sha256:${'0'.repeat(64)}`, imageId: 'sha256:abc' })
      );
      const { deps } = fakeDeps(Buffer.from('ghost docker save bytes'));

      const out = await pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl, keyPath }, deps);

      expect(out.push.ok).toBe(true);
      expect(out.push.status).toBe(200);
      expect(out.imageRef).toBeUndefined();
    });

    it('returns no ref when a 200 reply carries no digest at all', async () => {
      const keyPath = await keyOnly();
      const { baseUrl } = await stubHost(200, '{}');
      const { deps } = fakeDeps(Buffer.from('ghost docker save bytes'));

      const out = await pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl, keyPath }, deps);

      expect(out.push.ok).toBe(true);
      expect(out.imageRef).toBeUndefined();
    });

    it('pins when the 200 reply repeats the digest of the tar that was sent', async () => {
      const bytes = Buffer.from('ghost docker save bytes');
      const tarDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const keyPath = await keyOnly();
      const { baseUrl } = await stubHost(200, JSON.stringify({ digest: tarDigest }));
      const { deps } = fakeDeps(bytes);

      const out = await pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl, keyPath }, deps);

      expect(out.imageRef).toBe(SLOT_REF);
    });

    it('does not follow a redirect: a 303 to a page that answers 200 is not a delivery', async () => {
      const keyPath = await keyOnly();
      const { baseUrl, hits } = await stubHost(303, '{}', { location: '/somewhere-else' });
      // A followed redirect would be a second request, a body-less GET.
      const { deps } = fakeDeps(Buffer.from('ghost docker save bytes'));

      const out = await pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl, keyPath }, deps);

      expect(out.push.ok).toBe(false);
      expect(out.push.status).toBe(303);
      expect(out.imageRef).toBeUndefined();
      expect(hits).toEqual(['POST /image']);
    });
  });

  describe('the tar is written to a fresh, exclusively created file', () => {
    it('gives each push its own empty owner-only file under the temp dir, and removes it after', async () => {
      const { keyPath } = await setup();
      const { deps, tarPaths, beforeSave } = fakeDeps(Buffer.from('ghost docker save bytes'));
      const now = Math.floor(broker!.nowMs() / 1000);
      const config = { manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath };

      await pushDemoSlotImage(config, deps, now);
      await pushDemoSlotImage(config, deps, now);

      expect(tarPaths).toHaveLength(2);
      expect(tarPaths[0]).not.toBe(tarPaths[1]);
      for (const path of tarPaths) {
        expect(dirname(dirname(path))).toBe(tmpdir().replace(/\/$/, ''));
        expect(existsSync(dirname(path))).toBe(false);
      }
      expect(beforeSave).toEqual([
        { size: 0, mode: 0o600 },
        { size: 0, mode: 0o600 },
      ]);
    });

    it('removes the tar even when the push throws', async () => {
      const { keyPath } = await setup();
      const { deps, tarPaths } = fakeDeps(Buffer.from('x'));
      const failing: ImageProvenanceDeps = {
        ...deps,
        save: async (ref, tarPath) => {
          await deps.save(ref, tarPath);
          throw new Error('docker save failed');
        },
      };

      await expect(
        pushDemoSlotImage({ manifestDigest: MANIFEST, baseUrl: broker!.baseUrl, keyPath }, failing)
      ).rejects.toThrow('docker save failed');
      expect(existsSync(dirname(tarPaths[0]!))).toBe(false);
    });
  });
});
