import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { receiveBody, resolveBodyCeiling } from '../src/body.js';
import {
  createAdminInterface,
  type AdminRequest,
  type AdminResponse,
} from '../src/credentials/admin.js';
import {
  ADMIN_HEADERS,
  adminSigningPayload,
  createInMemoryNonceStore,
  type AdminAuthDeps,
} from '../src/credentials/adminAuth.js';
import { MasterSecret } from '../src/credentials/masterSecret.js';
import { credentials } from '../src/credentials/schema.js';
import { SqliteCredentialStore } from '../src/credentials/store.js';

// Each tenant gets its own ceiling from its credential; the body stage must
// enforce each one, and neither tenant's limit may leak into the other's.

const MIB = 1024 * 1024;
const CALLER = 'provisioning-controller';
const START_MS = 1_800_000_000_000;
const NOW_MS = START_MS + 60_000;
const MASTER = MasterSecret.fromBytes(Buffer.alloc(32, 0x42));
const FOLDER_A = 'tenantfolderaaaa0001';
const FOLDER_B = 'tenantfolderbbbb0002';
const BUCKET = 'shard-one';
const CONTROLLER = generateKeyPairSync('ed25519');
const ERASURE = generateKeyPairSync('ed25519');

let nonceCounter = 0;
let keyCounter = 0;

/** A mint request for a raw JSON body, signed by the controller. */
function signedMint(rawBody: string): AdminRequest {
  const body = Buffer.from(rawBody, 'utf8');
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const nonce = `nonce-${String(++nonceCounter).padStart(12, '0')}`;
  const payload = adminSigningPayload(CALLER, 'POST', '/credentials', timestamp, nonce, body);
  return {
    method: 'POST',
    path: '/credentials',
    rawBody: body,
    headers: {
      [ADMIN_HEADERS.caller]: CALLER,
      [ADMIN_HEADERS.timestamp]: timestamp,
      [ADMIN_HEADERS.nonce]: nonce,
      [ADMIN_HEADERS.signature]: sign(null, payload, CONTROLLER.privateKey).toString('base64'),
    },
  };
}

/** The mint body as text, so a value JSON cannot express (1e999 is Infinity) can be sent. */
function mintBody(folder: string, ceiling: string | undefined): string {
  const field = ceiling === undefined ? '' : `,"uploadCeilingMib":${ceiling}`;
  return `{"folder":"${folder}","bucket":"${BUCKET}"${field}}`;
}

describe('a per-tenant upload ceiling, enforced by the body stage', () => {
  let dir: string;
  let spoolDir: string;
  let path: string;
  let store: SqliteCredentialStore;
  let admin: ReturnType<typeof createAdminInterface>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gw-upload-ceiling-'));
    spoolDir = await mkdtemp(join(tmpdir(), 'gw-upload-ceiling-spool-'));
    path = join(dir, 'credentials.sqlite');
    store = SqliteCredentialStore.open(path);
    const auth: AdminAuthDeps = {
      callerKeys: {
        'provisioning-controller': CONTROLLER.publicKey,
        'erasure-job': ERASURE.publicKey,
      },
      replayWindowSeconds: 60,
      nonces: createInMemoryNonceStore(),
      processStartSeconds: Math.floor(START_MS / 1000),
      nowMs: () => NOW_MS,
    };
    admin = createAdminInterface({
      auth,
      store,
      master: MASTER,
      logger: { admin: () => undefined },
      newKeyId: () => `GWTENANT${String(++keyCounter).padStart(16, '0')}`,
    });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await rm(spoolDir, { recursive: true, force: true });
  });

  function mint(folder: string, ceiling: string | undefined): AdminResponse {
    return admin.handle(signedMint(mintBody(folder, ceiling)));
  }

  function keyIdOf(response: AdminResponse): string {
    return (JSON.parse(response.body) as { keyId: string }).keyId;
  }

  /** The body stage's decision for one upload of `bytes`, using the tenant's stored ceiling. */
  async function admitUpload(keyId: string, bytes: number): Promise<string> {
    const record = await store.lookup(keyId);
    if (record === undefined) throw new Error('the key id was not minted');
    const ceiling = resolveBodyCeiling(record);
    if (!ceiling.ok) return ceiling.refusal.code;
    const result = await receiveBody(Readable.from([Buffer.alloc(bytes)]), {
      ceilingBytes: ceiling.bytes,
      spoolDir,
      log: { method: 'PUT' },
    });
    if (!result.ok) return result.refusal.code;
    await result.body.dispose();
    return 'accepted';
  }

  it('refuses one tenant one byte over its own ceiling while another tenant is not refused', async () => {
    const tenantA = keyIdOf(mint(FOLDER_A, '1'));
    const tenantB = keyIdOf(mint(FOLDER_B, '2'));

    expect(await admitUpload(tenantA, MIB + 1)).toBe('body-too-large');
    expect(await admitUpload(tenantB, MIB + 1)).toBe('accepted');
  });

  it('accepts a body of exactly the tenant ceiling, and refuses the byte after it', async () => {
    const tenantA = keyIdOf(mint(FOLDER_A, '1'));

    expect(await admitUpload(tenantA, MIB)).toBe('accepted');
    expect(await admitUpload(tenantA, MIB + 1)).toBe('body-too-large');
  });

  it('refuses an upload from a credential stored with no ceiling, never reading it as a default', async () => {
    const inserted = store.insert({
      keyId: 'GWNOCEILING0000000000000001',
      folder: FOLDER_A,
      bucket: BUCKET,
      createdAt: new Date(NOW_MS).toISOString(),
    });
    expect(inserted.ok).toBe(true);

    expect(await admitUpload('GWNOCEILING0000000000000001', 1)).toBe('internal-error');
  });

  it('refuses an upload once a minted credential has its ceiling cleared to NULL', async () => {
    const tenant = keyIdOf(mint(FOLDER_A, '1'));
    const raw = new Database(path);
    try {
      drizzle(raw)
        .update(credentials)
        .set({ uploadCeilingMib: null })
        .where(eq(credentials.keyId, tenant))
        .run();
    } finally {
      raw.close();
    }

    expect(await admitUpload(tenant, 1)).toBe('internal-error');
  });

  it('refuses a mint that names no ceiling, and stores nothing', () => {
    const response = mint(FOLDER_A, undefined);

    expect(response.status).toBe(400);
    expect(response.body).not.toContain('secret');
    expect(store.listByFolder(FOLDER_A)).toEqual([]);
  });

  it('refuses a mint whose ceiling is above the maximum, and stores nothing', () => {
    const above = mint(FOLDER_A, String(5 * 1024 + 1));

    expect(above.status).toBe(400);
    expect(above.body).not.toContain('secret');
    expect(store.listByFolder(FOLDER_A)).toEqual([]);
  });

  it('mints a ceiling of exactly the maximum', () => {
    const at = mint(FOLDER_A, String(5 * 1024));

    expect(at.status).toBe(201);
    expect(store.listByFolder(FOLDER_A)[0]?.uploadCeilingMib).toBe(5 * 1024);
  });

  it('refuses a mint whose ceiling is not a positive whole number of MiB, and stores nothing', () => {
    for (const bad of ['"5"', '0', '-1', '1.5', '1e999', '2e15', 'null', 'true']) {
      const response = mint(FOLDER_A, bad);
      expect(response.status, `ceiling ${bad}`).toBe(400);
      expect(response.body, `ceiling ${bad}`).not.toContain('secret');
    }
    expect(store.listByFolder(FOLDER_A)).toEqual([]);
  });

  it('refuses a stored ceiling the body stage cannot read, as credential-invalid', async () => {
    const tenant = keyIdOf(mint(FOLDER_A, '1'));
    // The database refuses a bad value on write, so the stored value is planted
    // with the check bypassed, as a damaged or hand-edited row would be.
    const raw = new Database(path);
    try {
      raw.pragma('ignore_check_constraints = ON');
      const db = drizzle(raw);
      // 'five' is text the integer column keeps as text; numeric text such as '5'
      // is converted to the integer 5 by the column's affinity, so it is not a bad value.
      for (const planted of [Infinity, 0, -1, 1.5, 'five']) {
        db.update(credentials)
          .set({ uploadCeilingMib: planted as number })
          .where(eq(credentials.keyId, tenant))
          .run();
        expect(await admitUpload(tenant, 1), `planted ${String(planted)}`).toBe(
          'credential-invalid'
        );
      }
    } finally {
      raw.close();
    }
  });

  it('the database itself refuses a non-positive or non-integer ceiling written directly', () => {
    const tenant = keyIdOf(mint(FOLDER_A, '1'));
    const raw = new Database(path);
    try {
      const db = drizzle(raw);
      const write = (planted: number) =>
        db
          .update(credentials)
          .set({ uploadCeilingMib: planted })
          .where(eq(credentials.keyId, tenant))
          .run();
      expect(() => write(0)).toThrow(/CHECK/);
      expect(() => write(1.5)).toThrow(/CHECK/);
    } finally {
      raw.close();
    }
  });
});
