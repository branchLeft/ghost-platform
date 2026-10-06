import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admit } from '../../src/admit.js';
import { createSigningSecretSource } from '../../src/credentials/secretSource.js';
import { ADMIN_PERMISSIONS, createAdminInterface, newKeyId } from '../../src/credentials/admin.js';
import {
  ADMIN_HEADERS,
  CALLER_KEY_ENV,
  adminSigningPayload,
  authenticateAdmin,
  createInMemoryNonceStore,
  replayWindow,
  loadCallerKeys,
  publicKeyFromRaw,
  type AdminAuthDeps,
} from '../../src/credentials/adminAuth.js';
import { deriveTenantSecret } from '../../src/credentials/derive.js';
import { MasterSecret } from '../../src/credentials/masterSecret.js';
import { SqliteCredentialStore } from '../../src/credentials/store.js';

const MASTER = MasterSecret.fromBytes(Buffer.alloc(32, 0x42));
const START_MS = 1_800_000_000_000;
const NOW_MS = START_MS + 60_000;
const BODY = { folder: 'opaquefolder00000001', bucket: 'shard-one' };

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey, privateKey, raw: Buffer.from(raw) };
}

const controller = keyPair();
const erasure = keyPair();
const stranger = keyPair();

let nonceCounter = 0;
function signed(
  caller: string,
  privateKey: KeyObject,
  method: string,
  path: string,
  body: object | undefined = undefined,
  opts: { timestamp?: string; nonce?: string; signAs?: string } = {}
) {
  const rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const timestamp = opts.timestamp ?? String(Math.floor(NOW_MS / 1000));
  const nonce = opts.nonce ?? `nonce-${String(++nonceCounter).padStart(12, '0')}`;
  const payload = adminSigningPayload(
    opts.signAs ?? caller,
    method,
    path,
    timestamp,
    nonce,
    rawBody
  );
  return {
    method,
    path,
    rawBody,
    headers: {
      [ADMIN_HEADERS.caller]: caller,
      [ADMIN_HEADERS.timestamp]: timestamp,
      [ADMIN_HEADERS.nonce]: nonce,
      [ADMIN_HEADERS.signature]: sign(null, payload, privateKey).toString('base64'),
    },
  };
}

function authDeps(clock: () => number = () => NOW_MS): AdminAuthDeps {
  return {
    callerKeys: {
      'provisioning-controller': controller.publicKey,
      'erasure-job': erasure.publicKey,
    },
    replayWindowSeconds: 60,
    nonces: createInMemoryNonceStore(),
    processStartSeconds: Math.floor(START_MS / 1000),
    nowMs: clock,
  };
}

const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

describe('the admin interface', () => {
  let dir: string;
  let store: SqliteCredentialStore;
  let admin: ReturnType<typeof createAdminInterface>;
  let ids: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-admin-'));
    store = SqliteCredentialStore.open(join(dir, 'credentials.sqlite'));
    ids = ['GWFIRST0000000000000000000', 'GWSECOND000000000000000000'];
    admin = createAdminInterface({
      auth: authDeps(),
      store,
      master: MASTER,
      newKeyId: () => ids.shift() ?? 'GWEXHAUSTED000000000000000',
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mint = () =>
    admin.handle(
      signed('provisioning-controller', controller.privateKey, 'POST', '/credentials', BODY)
    );

  describe('minting', () => {
    it('mints an active credential and returns its derived secret once', () => {
      const response = mint();
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(json(response)).toEqual({
        keyId: 'GWFIRST0000000000000000000',
        folder: BODY.folder,
        bucket: BODY.bucket,
        state: 'active',
        createdAt: new Date(NOW_MS).toISOString(),
        secret: deriveTenantSecret(MASTER, 'GWFIRST0000000000000000000'),
      });
    });

    it('never returns a secret twice: no state or disable answer carries it', () => {
      const minted = json(mint());
      const secret = minted.secret as string;
      const path = `/credentials/${String(minted.keyId)}`;
      const answers = [
        admin.handle(signed('provisioning-controller', controller.privateKey, 'GET', path)),
        admin.handle(signed('erasure-job', erasure.privateKey, 'GET', path)),
        admin.handle(signed('erasure-job', erasure.privateKey, 'POST', `${path}/disable`)),
        admin.handle(signed('provisioning-controller', controller.privateKey, 'GET', path)),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        expect(answer.body).not.toContain(secret);
        expect(json(answer)).not.toHaveProperty('secret');
      }
    });

    it('refuses to mint a key id that was ever issued, and returns no secret', () => {
      ids = ['GWSAME00000000000000000000', 'GWSAME00000000000000000000'];
      expect(mint().status).toBe(201);
      const again = mint();
      expect(again.status).toBe(409);
      expect(again.body).not.toContain(deriveTenantSecret(MASTER, 'GWSAME00000000000000000000'));
      expect(json(again)).not.toHaveProperty('secret');
    });

    it('refuses to reissue a disabled key id, leaving it disabled', () => {
      ids = ['GWSAME00000000000000000000', 'GWSAME00000000000000000000'];
      mint();
      store.disable('GWSAME00000000000000000000');
      expect(mint().status).toBe(409);
      expect(store.get('GWSAME00000000000000000000')?.state).toBe('disabled');
    });

    it.each([
      ['not JSON', 'nope'],
      ['null', null],
      ['a short folder', { folder: 'short', bucket: 'shard-one' }],
      ['a folder with a slash', { folder: 'opaquefolder0000/001', bucket: 'shard-one' }],
      ['a bad bucket', { folder: BODY.folder, bucket: 'Shard_One' }],
      ['no bucket', { folder: BODY.folder }],
    ])('refuses a body with %s', (_label, body) => {
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        {}
      );
      const rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const resigned = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials'
      );
      const payload = adminSigningPayload(
        'provisioning-controller',
        'POST',
        '/credentials',
        resigned.headers[ADMIN_HEADERS.timestamp],
        resigned.headers[ADMIN_HEADERS.nonce],
        rawBody
      );
      const response = admin.handle({
        ...request,
        rawBody,
        headers: {
          ...resigned.headers,
          [ADMIN_HEADERS.signature]: sign(null, payload, controller.privateKey).toString('base64'),
        },
      });
      expect(response.status).toBe(400);
      expect(store.get('GWFIRST0000000000000000000')).toBeUndefined();
    });

    it('answers 503 and no secret when the store fails', () => {
      const failing = createAdminInterface({
        auth: authDeps(),
        store: {
          insert: () => {
            throw new Error('disk full');
          },
          disable: () => 'unknown',
          disableFolder: () => 0,
          listByFolder: () => [],
          get: () => undefined,
        },
        master: MASTER,
      });
      const response = failing.handle(
        signed('provisioning-controller', controller.privateKey, 'POST', '/credentials', BODY)
      );
      expect(response.status).toBe(503);
      expect(json(response)).not.toHaveProperty('secret');
    });
  });

  describe('disabling and state', () => {
    it('disables a credential, and the store the router reads then refuses it', async () => {
      const keyId = String(json(mint()).keyId);
      const response = admin.handle(
        signed('erasure-job', erasure.privateKey, 'POST', `/credentials/${keyId}/disable`)
      );
      expect(response.status).toBe(200);
      expect(json(response)).toMatchObject({ keyId, state: 'disabled' });
      await expect(store.lookup(keyId)).resolves.toMatchObject({ state: 'disabled' });
    });

    it('reports a repeated disable as the current state', () => {
      const keyId = String(json(mint()).keyId);
      const path = `/credentials/${keyId}/disable`;
      admin.handle(signed('provisioning-controller', controller.privateKey, 'POST', path));
      const again = admin.handle(
        signed('provisioning-controller', controller.privateKey, 'POST', path)
      );
      expect(again.status).toBe(200);
      expect(json(again).state).toBe('disabled');
    });

    it('answers 404 for a key id never issued', () => {
      const unknown = '/credentials/GWNEVERISSUED0000000000000';
      expect(admin.handle(signed('erasure-job', erasure.privateKey, 'GET', unknown)).status).toBe(
        404
      );
      expect(
        admin.handle(signed('erasure-job', erasure.privateKey, 'POST', `${unknown}/disable`)).status
      ).toBe(404);
    });

    it('answers 404 for a path or method it does not serve', () => {
      for (const [method, path] of [
        ['GET', '/credentials'],
        ['DELETE', '/credentials/GWFIRST0000000000000000000'],
        ['GET', '/credentials/gw-lower'],
        ['POST', '/credentials/GWFIRST0000000000000000000/secret'],
      ] as const) {
        expect(admin.handle(signed('erasure-job', erasure.privateKey, method, path)).status).toBe(
          404
        );
      }
    });
  });

  describe('the next request after a disable', () => {
    it('is admitted while active and refused once the admin interface disables it', async () => {
      const minted = json(mint());
      const keyId = String(minted.keyId);
      const secrets = createSigningSecretSource(store, MASTER);
      const deps = {
        verifier: { verify: async () => ({ ok: true as const, keyId }) },
        credentials: store,
        logger: { refusal: () => undefined },
      };
      const request = {
        method: 'GET',
        rawTarget: `/${BODY.bucket}/${BODY.folder}/image.png`,
        headers: {},
      };
      await expect(admit(request, deps)).resolves.toMatchObject({ ok: true });
      await expect(secrets.signingSecret(keyId)).resolves.toBe(minted.secret);

      admin.handle(
        signed('erasure-job', erasure.privateKey, 'POST', `/credentials/${keyId}/disable`)
      );

      await expect(admit(request, deps)).resolves.toMatchObject({
        ok: false,
        refusal: { code: 'credential-not-active' },
      });
      await expect(secrets.signingSecret(keyId)).resolves.toBeUndefined();
    });
  });

  describe('a byte-identical mint replayed at the edge of the window', () => {
    let clockMs: number;
    let edgeAdmin: ReturnType<typeof createAdminInterface>;
    beforeEach(() => {
      clockMs = NOW_MS;
      edgeAdmin = createAdminInterface({
        auth: authDeps(() => clockMs),
        store,
        master: MASTER,
        newKeyId: () => ids.shift() ?? 'GWEXHAUSTED000000000000000',
      });
    });

    it('is refused 60.5 seconds after a same-second request', () => {
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY
      );
      expect(edgeAdmin.handle(request).status).toBe(201);
      store.disableFolder(BODY.folder);
      clockMs = NOW_MS + 60_500;
      const replay = edgeAdmin.handle(request);
      expect(replay.status).toBe(401);
      expect(json(replay)).not.toHaveProperty('secret');
      expect(store.get('GWSECOND000000000000000000')).toBeUndefined();
    });

    it('is refused 62 seconds after a request stamped 5 seconds ahead', () => {
      const ahead = String(Math.floor(NOW_MS / 1000) + 5);
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY,
        {
          timestamp: ahead,
        }
      );
      expect(edgeAdmin.handle(request).status).toBe(201);
      store.disableFolder(BODY.folder);
      clockMs = NOW_MS + 62_000;
      const replay = edgeAdmin.handle(request);
      expect(replay.status).toBe(401);
      expect(json(replay)).not.toHaveProperty('secret');
      expect(store.get('GWSECOND000000000000000000')).toBeUndefined();
    });

    it('is refused at every half second until the window has closed', () => {
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY
      );
      expect(edgeAdmin.handle(request).status).toBe(201);
      store.disableFolder(BODY.folder);
      for (let offset = 500; offset <= 70_000; offset += 500) {
        clockMs = NOW_MS + offset;
        expect(edgeAdmin.handle(request).status).toBe(401);
      }
      expect(store.listByFolder(BODY.folder)).toHaveLength(1);
    });
  });

  describe('a mint replayed across a restart', () => {
    const T = Math.floor(NOW_MS / 1000);
    const restartedAt = (restartSeconds: number, clockMs: number) =>
      createAdminInterface({
        auth: {
          ...authDeps(() => clockMs),
          processStartSeconds: restartSeconds,
        },
        store,
        master: MASTER,
        newKeyId: () => ids.shift() ?? 'GWEXHAUSTED000000000000000',
      });

    it('is refused when it was stamped 5 seconds ahead and the gateway restarted 2 seconds later', () => {
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY,
        {
          timestamp: String(T + 5),
        }
      );
      expect(admin.handle(request).status).toBe(201);
      store.disableFolder(BODY.folder);
      for (const restart of [T, T + 1, T + 2, T + 4]) {
        const replay = restartedAt(restart, (restart + 0.5) * 1000).handle(request);
        expect(replay.status).toBe(401);
        expect(json(replay)).not.toHaveProperty('secret');
      }
      expect(store.listByFolder(BODY.folder)).toHaveLength(1);
    });

    it('still admits a fresh request stamped after the restart floor', () => {
      const restart = T + 2;
      const fresh = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY,
        {
          timestamp: String(restart + 6),
        }
      );
      expect(restartedAt(restart, (restart + 6) * 1000).handle(fresh).status).toBe(201);
    });
  });

  describe('one active credential per folder', () => {
    const disableFolder = (
      caller: 'provisioning-controller' | 'erasure-job',
      folder = BODY.folder
    ) =>
      admin.handle(
        signed(
          caller,
          caller === 'erasure-job' ? erasure.privateKey : controller.privateKey,
          'POST',
          `/folders/${folder}/disable`
        )
      );

    it('refuses a second mint for a folder that has an active credential, with no secret', () => {
      const first = json(mint());
      const retry = mint();
      expect(retry.status).toBe(409);
      expect(json(retry).error).toMatch(/folder has an active credential/);
      expect(retry.body).not.toContain(String(first.secret));
      expect(json(retry)).not.toHaveProperty('secret');
      expect(store.listByFolder(BODY.folder).map((c) => c.state)).toEqual(['active']);
    });

    it('lets the controller recover a lost mint: disable by folder, then mint again', () => {
      const lost = json(mint());
      const disabled = disableFolder('provisioning-controller');
      expect(disabled.status).toBe(200);
      expect(json(disabled)).toEqual({
        folder: BODY.folder,
        disabled: 1,
        credentials: [expect.objectContaining({ keyId: lost.keyId, state: 'disabled' })],
      });
      expect(disabled.body).not.toContain(String(lost.secret));
      const fresh = mint();
      expect(fresh.status).toBe(201);
      expect(json(fresh).keyId).not.toBe(lost.keyId);
      expect(json(fresh).secret).not.toBe(lost.secret);
    });

    it('lets the erasure job find and disable every key id a folder ever had, with no secret', () => {
      const one = json(mint());
      disableFolder('provisioning-controller');
      const two = json(mint());
      const response = disableFolder('erasure-job');
      expect(response.status).toBe(200);
      const body = json(response);
      expect(body.disabled).toBe(1);
      expect(body.credentials).toEqual([
        expect.objectContaining({ keyId: one.keyId, state: 'disabled' }),
        expect.objectContaining({ keyId: two.keyId, state: 'disabled' }),
      ]);
      for (const secret of [one.secret, two.secret])
        expect(response.body).not.toContain(String(secret));
      for (const credential of body.credentials as object[])
        expect(credential).not.toHaveProperty('secret');
    });

    it('answers a repeat with nothing newly disabled, and 404 for a folder never used', () => {
      mint();
      disableFolder('erasure-job');
      expect(json(disableFolder('erasure-job')).disabled).toBe(0);
      expect(disableFolder('erasure-job', 'unusedfolder00000001').status).toBe(404);
    });

    it('refuses a malformed folder, and a caller that is not named', () => {
      expect(disableFolder('erasure-job', 'short').status).toBe(404);
      const stray = signed(
        'portal',
        stranger.privateKey,
        'POST',
        `/folders/${BODY.folder}/disable`
      );
      expect(admin.handle(stray).status).toBe(401);
    });
  });

  describe('who may call', () => {
    it('refuses a caller that is not one of the two named ones, even with a valid signature', () => {
      for (const name of ['portal', 'broker', 'Provisioning-Controller', '']) {
        const response = admin.handle(
          signed(name, stranger.privateKey, 'POST', '/credentials', BODY)
        );
        expect(response.status).toBe(401);
      }
      const noCaller = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY
      );
      const headers: Record<string, string | undefined> = { ...noCaller.headers };
      delete headers[ADMIN_HEADERS.caller];
      expect(admin.handle({ ...noCaller, headers }).status).toBe(401);
      expect(store.get('GWFIRST0000000000000000000')).toBeUndefined();
    });

    it('refuses a named caller signing with any key but its own', () => {
      for (const key of [stranger.privateKey, erasure.privateKey]) {
        const response = admin.handle(
          signed('provisioning-controller', key, 'POST', '/credentials', BODY)
        );
        expect(response.status).toBe(401);
        expect(json(response)).not.toHaveProperty('secret');
      }
    });

    it('refuses a signature made for the other caller name', () => {
      const request = signed(
        'erasure-job',
        controller.privateKey,
        'GET',
        '/credentials/GWFIRST0000000000000000000',
        undefined,
        {
          signAs: 'provisioning-controller',
        }
      );
      expect(admin.handle(request).status).toBe(401);
    });

    it('refuses the erasure job a mint', () => {
      const response = admin.handle(
        signed('erasure-job', erasure.privateKey, 'POST', '/credentials', BODY)
      );
      expect(response.status).toBe(403);
      expect(store.get('GWFIRST0000000000000000000')).toBeUndefined();
    });

    it('grants exactly the listed operations', () => {
      expect(ADMIN_PERMISSIONS).toEqual({
        'provisioning-controller': ['mint', 'disable', 'disable-folder', 'state'],
        'erasure-job': ['disable', 'disable-folder', 'state'],
      });
    });

    it('refuses a replayed request', () => {
      const request = signed(
        'provisioning-controller',
        controller.privateKey,
        'POST',
        '/credentials',
        BODY
      );
      expect(admin.handle(request).status).toBe(201);
      expect(admin.handle(request).status).toBe(401);
    });
  });
});

describe('authenticateAdmin', () => {
  const path = '/credentials/GWFIRST0000000000000000000';
  type Unsigned = Omit<ReturnType<typeof signed>, 'headers'> & {
    headers: Record<string, string | undefined>;
  };
  const check = (request: Unsigned, deps = authDeps()) =>
    authenticateAdmin(deps, request.method, request.path, request.headers, request.rawBody);

  it('accepts each named caller with its own key', () => {
    expect(check(signed('provisioning-controller', controller.privateKey, 'GET', path))).toEqual({
      ok: true,
      caller: 'provisioning-controller',
    });
    expect(check(signed('erasure-job', erasure.privateKey, 'GET', path))).toEqual({
      ok: true,
      caller: 'erasure-job',
    });
  });

  it.each([
    ['a malformed timestamp', { timestamp: '12a' }, 'malformed timestamp'],
    ['a malformed nonce', { nonce: 'short' }, 'malformed nonce'],
    ['a stale timestamp', { timestamp: String(Math.floor(NOW_MS / 1000) - 61) }, 'replay window'],
    ['a future timestamp', { timestamp: String(Math.floor(NOW_MS / 1000) + 6) }, 'replay window'],
    [
      'a timestamp from before start-up',
      { timestamp: String(Math.floor(START_MS / 1000)) },
      'predates',
    ],
  ])('refuses %s', (_label, opts, reason) => {
    const deps = { ...authDeps(), replayWindowSeconds: 3600 };
    if (reason === 'replay window') deps.replayWindowSeconds = 60;
    const result = check(
      signed('erasure-job', erasure.privateKey, 'GET', path, undefined, opts),
      deps
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(reason);
  });

  it('refuses a missing or truncated signature', () => {
    const request = signed('erasure-job', erasure.privateKey, 'GET', path);
    const missing = {
      ...request,
      headers: { ...request.headers, [ADMIN_HEADERS.signature]: undefined },
    };
    expect(check(missing)).toEqual({ ok: false, reason: 'missing signature' });
    const truncated = {
      ...request,
      headers: { ...request.headers, [ADMIN_HEADERS.signature]: 'AAAA' },
    };
    expect(check(truncated)).toEqual({ ok: false, reason: 'signature does not verify' });
  });

  it('refuses a signed request moved to another path', () => {
    const request = signed('erasure-job', erasure.privateKey, 'GET', path);
    expect(check({ ...request, path: `${path}/disable` })).toEqual({
      ok: false,
      reason: 'signature does not verify',
    });
  });

  it('does not let an unsigned request burn a nonce', () => {
    const deps = authDeps();
    const good = signed('erasure-job', erasure.privateKey, 'GET', path, undefined, {
      nonce: 'shared-nonce-000001',
    });
    const forged = {
      ...good,
      headers: {
        ...good.headers,
        [ADMIN_HEADERS.signature]: sign(null, Buffer.from('x'), stranger.privateKey).toString(
          'base64'
        ),
      },
    };
    expect(check(forged, deps).ok).toBe(false);
    expect(check(good, deps)).toEqual({ ok: true, caller: 'erasure-job' });
  });
});

describe('createInMemoryNonceStore', () => {
  it('accepts a nonce once, again after its own expiry, and refuses when full', () => {
    const nonces = createInMemoryNonceStore(2);
    expect(nonces.claim('a', 0, 1000)).toBe(true);
    expect(nonces.claim('a', 500, 1500)).toBe(false);
    expect(nonces.claim('b', 600, 5000)).toBe(true);
    expect(nonces.claim('c', 700, 5000)).toBe(false);
    expect(nonces.claim('a', 1000, 2000)).toBe(true);
  });

  it('expires entries out of insertion order', () => {
    const nonces = createInMemoryNonceStore(2);
    nonces.claim('late', 0, 10_000);
    nonces.claim('early', 0, 1000);
    expect(nonces.claim('third', 1000, 2000)).toBe(true);
    expect(nonces.claim('late', 1000, 2000)).toBe(false);
  });
});

describe('replayWindow', () => {
  it('remembers a nonce past the last instant its request is admitted', () => {
    for (const windowSeconds of [1, 60, 3600]) {
      const w = replayWindow(1000, windowSeconds);
      expect(w.opensAtMs).toBe(995_000);
      expect(w.closesAtMs).toBe((1000 + windowSeconds + 1) * 1000);
      expect(w.nonceExpiresAtMs).toBeGreaterThan(w.closesAtMs);
    }
  });
});

describe('loadCallerKeys', () => {
  const env = {
    [CALLER_KEY_ENV['provisioning-controller']]: controller.raw.toString('base64'),
    [CALLER_KEY_ENV['erasure-job']]: erasure.raw.toString('base64'),
  };

  it('loads both callers keys', () => {
    const keys = loadCallerKeys(env);
    expect(
      keys['provisioning-controller'].export({ format: 'der', type: 'spki' }).subarray(-32)
    ).toEqual(controller.raw);
    expect(keys['erasure-job'].export({ format: 'der', type: 'spki' }).subarray(-32)).toEqual(
      erasure.raw
    );
  });

  it('refuses to start when a key is missing', () => {
    expect(() => loadCallerKeys({ ...env, [CALLER_KEY_ENV['erasure-job']]: undefined })).toThrow(
      /is not set/
    );
  });

  it('refuses a key that is not 32 bytes of base64', () => {
    expect(() => loadCallerKeys({ ...env, [CALLER_KEY_ENV['erasure-job']]: 'AAAA' })).toThrow(
      /not a base64/
    );
    expect(() =>
      loadCallerKeys({
        ...env,
        [CALLER_KEY_ENV['erasure-job']]: `${erasure.raw.toString('base64')}x`,
      })
    ).toThrow(/not a base64/);
  });

  it('refuses the same key for both callers', () => {
    expect(() =>
      loadCallerKeys({ ...env, [CALLER_KEY_ENV['erasure-job']]: controller.raw.toString('base64') })
    ).toThrow(/different keys/);
  });

  it('refuses a raw public key of the wrong length', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow(/32 raw bytes/);
  });
});

describe('newKeyId', () => {
  it('gives well-formed, distinct key ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newKeyId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^GW[A-Z2-7]{24}$/);
  });
});
