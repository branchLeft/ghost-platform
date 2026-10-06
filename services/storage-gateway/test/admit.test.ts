import { describe, expect, it } from 'vitest';
import type {
  CredentialRecord,
  CredentialStore,
  GatewayRequest,
  SignatureVerifier,
} from '../src/contracts.js';
import { admit, type RefusalLogEntry } from '../src/admit.js';
import { refusal } from '../src/refusal.js';

const BUCKET = 'shard-one-bucket';
const FOLDER = 'k7f3q9x2m1';
const KEY_ID = 'tenant-key-1';

const request = (method: string, rawTarget: string): GatewayRequest => ({
  method,
  rawTarget,
  headers: {},
});

const goodRequest = request('PUT', `/${BUCKET}/${FOLDER}/a.png`);

function setup(options: {
  verifier?: SignatureVerifier;
  record?: CredentialRecord | undefined | Error;
}) {
  const logged: RefusalLogEntry[] = [];
  const record =
    'record' in options
      ? options.record
      : ({ folder: FOLDER, bucket: BUCKET, state: 'active' } as const);
  const credentials: CredentialStore = {
    lookup: async (keyId) => {
      if (record instanceof Error) throw record;
      return keyId === KEY_ID ? record : undefined;
    },
  };
  const verifier: SignatureVerifier = options.verifier ?? {
    verify: async () => ({ ok: true, keyId: KEY_ID }),
  };
  return {
    logged,
    deps: { verifier, credentials, logger: { refusal: (e: RefusalLogEntry) => logged.push(e) } },
  };
}

describe('admit', () => {
  it('admits a signed request inside the tenant folder and names the tenant', async () => {
    const { deps, logged } = setup({});
    const result = await admit(goodRequest, deps);
    expect(result).toMatchObject({
      ok: true,
      route: { operation: 'PutObject', key: `${FOLDER}/a.png` },
      tenant: { keyId: KEY_ID, folder: FOLDER, bucket: BUCKET },
    });
    expect(logged).toEqual([]);
  });

  it('refuses and logs a request the verifier refuses, with no tenant', async () => {
    const { deps, logged } = setup({
      verifier: { verify: async () => ({ ok: false, refusal: refusal('signature-refused') }) },
    });
    const result = await admit(goodRequest, deps);
    expect(result).toEqual({ ok: false, refusal: refusal('signature-refused') });
    expect(logged).toEqual([
      { event: 'request-refused', code: 'signature-refused', status: 403, method: 'PUT' },
    ]);
  });

  it('fails closed when the verifier throws', async () => {
    const { deps, logged } = setup({
      verifier: {
        verify: async () => {
          throw new Error('boom');
        },
      },
    });
    const result = await admit(goodRequest, deps);
    expect(result).toEqual({ ok: false, refusal: refusal('internal-error') });
    expect(logged[0]).toMatchObject({ code: 'internal-error', status: 503 });
  });

  it('fails closed when the credential store throws, logging the tenant key', async () => {
    const { deps, logged } = setup({ record: new Error('store down') });
    const result = await admit(goodRequest, deps);
    expect(result).toEqual({ ok: false, refusal: refusal('internal-error') });
    expect(logged[0]).toMatchObject({ code: 'internal-error', keyId: KEY_ID });
  });

  it('answers an unknown key id exactly as a bad signature', async () => {
    const { deps, logged } = setup({ record: undefined });
    const result = await admit(goodRequest, deps);
    expect(result).toEqual({ ok: false, refusal: refusal('signature-refused') });
    expect(logged[0]).toMatchObject({ code: 'signature-refused', keyId: KEY_ID });
  });

  it.each(['disabled', 'revoked'] as const)(
    'refuses a %s credential and logs the tenant',
    async (state) => {
      const { deps, logged } = setup({ record: { folder: FOLDER, bucket: BUCKET, state } });
      const result = await admit(goodRequest, deps);
      expect(result).toEqual({ ok: false, refusal: refusal('credential-not-active') });
      expect(logged[0]).toMatchObject({
        code: 'credential-not-active',
        keyId: KEY_ID,
        folder: FOLDER,
      });
    }
  );

  it('refuses and logs a request outside the allowed shapes, with the tenant', async () => {
    const { deps, logged } = setup({});
    const result = await admit(request('DELETE', `/${BUCKET}/${FOLDER}/a.png`), deps);
    expect(result).toEqual({ ok: false, refusal: refusal('operation-not-allowed') });
    expect(logged).toEqual([
      {
        event: 'request-refused',
        code: 'operation-not-allowed',
        status: 403,
        method: 'DELETE',
        keyId: KEY_ID,
        folder: FOLDER,
      },
    ]);
  });

  it('refuses and logs a malformed target, with the tenant', async () => {
    const { deps, logged } = setup({});
    const result = await admit(request('GET', `/${BUCKET}/${FOLDER}/../other/a.png`), deps);
    expect(result).toEqual({ ok: false, refusal: refusal('target-malformed') });
    expect(logged[0]).toMatchObject({ code: 'target-malformed', status: 400, keyId: KEY_ID });
  });

  it('refuses another tenant’s folder and logs the operation attempted', async () => {
    const { deps, logged } = setup({});
    const result = await admit(request('GET', `/${BUCKET}/other-folder/a.png`), deps);
    expect(result).toEqual({ ok: false, refusal: refusal('key-outside-folder') });
    expect(logged[0]).toMatchObject({
      code: 'key-outside-folder',
      keyId: KEY_ID,
      folder: FOLDER,
      operation: 'GetObject',
    });
  });

  it('refuses another bucket', async () => {
    const { deps } = setup({});
    const result = await admit(request('GET', `/some-other-bucket/${FOLDER}/a.png`), deps);
    expect(result).toEqual({ ok: false, refusal: refusal('bucket-not-allowed') });
  });

  it('never writes the object key, bucket or target into the log', async () => {
    const { deps, logged } = setup({});
    await admit(request('GET', `/${BUCKET}/other-folder/secret-name.png`), deps);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('secret-name');
    expect(text).not.toContain(BUCKET);
  });

  it('refuses a credential record that is malformed', async () => {
    const { deps, logged } = setup({ record: { folder: 'a/b', bucket: BUCKET, state: 'active' } });
    const result = await admit(goodRequest, deps);
    expect(result).toEqual({ ok: false, refusal: refusal('credential-invalid') });
    expect(logged[0]).toMatchObject({ code: 'credential-invalid', keyId: KEY_ID });
  });
});
