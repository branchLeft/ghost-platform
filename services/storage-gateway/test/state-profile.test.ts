import { describe, expect, it } from 'vitest';
import type {
  CredentialRecord,
  CredentialStore,
  GatewayRequest,
  RefusalCode,
  SignatureVerifier,
} from '../src/contracts.js';
import { credentialProfile } from '../src/contracts.js';
import { admit, type RefusalLogEntry } from '../src/admit.js';
import {
  STATE_OPERATIONS,
  admitState,
  guardStateTenant,
  routeStateRequest,
} from '../src/state-profile.js';

const BUCKET = 'state-shard-bucket';
const MEDIA_BUCKET = 'media-shard-bucket';
const CREATED = '2026-11-18T00:00:00Z';

/** Two throwaway tenants, A and B, each on its own opaque prefix. `abc` and `abcd` are siblings on purpose. */
const A = { keyId: 'key-a', prefix: 'abc' };
const B = { keyId: 'key-b', prefix: 'xyz9k2' };
const SIBLING = { keyId: 'key-sibling', prefix: 'abcd' };
const MEDIA = { keyId: 'key-media', prefix: 'mediafolder1' };

const records: Record<string, CredentialRecord> = {
  [A.keyId]: {
    profile: 'state',
    folder: A.prefix,
    bucket: BUCKET,
    state: 'active',
    createdAt: CREATED,
  },
  [B.keyId]: {
    profile: 'state',
    folder: B.prefix,
    bucket: BUCKET,
    state: 'active',
    createdAt: CREATED,
  },
  [SIBLING.keyId]: {
    profile: 'state',
    folder: SIBLING.prefix,
    bucket: BUCKET,
    state: 'active',
    createdAt: CREATED,
  },
  // A legacy media record: no profile field at all.
  [MEDIA.keyId]: {
    folder: MEDIA.prefix,
    bucket: MEDIA_BUCKET,
    state: 'active',
    createdAt: CREATED,
  },
};

const req = (
  method: string,
  rawTarget: string,
  headers: GatewayRequest['headers'] = {}
): GatewayRequest => ({ method, rawTarget, headers });

/** Runs a request as `keyId` through the state admission path; returns the refusal code or `ok`, plus the log. */
async function runAs(keyId: string, request: GatewayRequest) {
  const logged: RefusalLogEntry[] = [];
  const verifier: SignatureVerifier = { verify: async () => ({ ok: true, keyId }) };
  const credentials: CredentialStore = { lookup: async (id) => records[id] };
  const result = await admitState(request, {
    verifier,
    credentials,
    logger: { refusal: (e) => logged.push(e) },
  });
  return { code: result.ok ? 'ok' : result.refusal.code, logged, result };
}

const lock = (p: string) => `/${BUCKET}/${p}/.pulumi/locks/organization/proj/stack/0001.json`;
const checkpoint = (p: string) => `/${BUCKET}/${p}/.pulumi/stacks/proj/stack.json`;
const listing = (prefix: string) =>
  `/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=%2F`;
const copyHeader = (bucket: string, key: string) => ({
  'x-amz-copy-source': encodeURIComponent(`${bucket}/${key}`),
});

/** The rows of page 24's check 1, for one caller acting on `own` and then on `other`. */
function table(own: string, other: string) {
  return [
    // [name, request on own prefix, expected on own, request on other prefix, expected on other]
    [
      'GetObject',
      req('GET', checkpoint(own)),
      'ok',
      req('GET', checkpoint(other)),
      'key-outside-folder',
    ],
    [
      'HeadObject',
      req('HEAD', checkpoint(own)),
      'ok',
      req('HEAD', checkpoint(other)),
      'key-outside-folder',
    ],
    [
      'PutObject',
      req('PUT', checkpoint(own)),
      'ok',
      req('PUT', checkpoint(other)),
      'key-outside-folder',
    ],
    [
      'ListObjectsV2 with the prefix',
      req('GET', listing(`${own}/.pulumi/stacks/`)),
      'ok',
      req('GET', listing(`${other}/.pulumi/stacks/`)),
      'key-outside-folder',
    ],
    [
      'DeleteObject of a lock',
      req('DELETE', lock(own)),
      'ok',
      req('DELETE', lock(other)),
      'key-outside-folder',
    ],
    [
      'DeleteObject of a checkpoint',
      req('DELETE', checkpoint(own)),
      'key-outside-folder',
      req('DELETE', checkpoint(other)),
      'key-outside-folder',
    ],
    [
      'CopyObject with the other tenant object as source',
      req('PUT', checkpoint(own), copyHeader(BUCKET, `${other}/.pulumi/stacks/proj/stack.json`)),
      'key-outside-folder',
      req('PUT', checkpoint(own), copyHeader(BUCKET, `${other}/.pulumi/stacks/proj/stack.json`)),
      'key-outside-folder',
    ],
    [
      'CopyObject into the other tenant prefix',
      req('PUT', checkpoint(own), copyHeader(BUCKET, `${own}/.pulumi/stacks/proj/stack.json`)),
      'ok',
      req('PUT', checkpoint(other), copyHeader(BUCKET, `${own}/.pulumi/stacks/proj/stack.json`)),
      'key-outside-folder',
    ],
  ] as const;
}

describe.each([
  ['A against B', A, B],
  ['B against A', B, A],
  ['A against its sibling prefix', A, SIBLING],
  ['the sibling against A', SIBLING, A],
])('two-tenant negative test: %s', (_name, caller, other) => {
  it.each(table(caller.prefix, other.prefix))(
    '%s: allowed on its own prefix, refused with the gateway code on the other',
    async (_op, ownRequest, ownExpected, otherRequest, otherExpected) => {
      // The harness can see: the same operation on the caller's own prefix is
      // admitted (or refused for its own stated reason), so a refusal on the
      // other prefix is not a harness that refuses everything.
      const own = await runAs(caller.keyId, ownRequest);
      expect(own.code).toBe(ownExpected);

      const refused = await runAs(caller.keyId, otherRequest);
      expect(refused.code).toBe(otherExpected);
      // Scored by the gateway's own record, not by a status.
      {
        expect(refused.logged).toHaveLength(1);
        expect(refused.logged[0]).toMatchObject({
          event: 'request-refused',
          code: otherExpected,
          keyId: caller.keyId,
          folder: caller.prefix,
        });
      }
    }
  );
});

describe('the other tenant can read its own object (the harness is not a wall)', () => {
  it('B reads B and A reads A', async () => {
    expect((await runAs(B.keyId, req('GET', checkpoint(B.prefix)))).code).toBe('ok');
    expect((await runAs(A.keyId, req('GET', checkpoint(A.prefix)))).code).toBe('ok');
  });
});

describe('a prefix is compared with its trailing slash', () => {
  it('abc cannot reach abcd/, by object, listing, copy destination or copy source', async () => {
    const sibling = SIBLING.prefix;
    expect((await runAs(A.keyId, req('GET', `/${BUCKET}/${sibling}/x.json`))).code).toBe(
      'key-outside-folder'
    );
    expect((await runAs(A.keyId, req('GET', listing(`${sibling}/`)))).code).toBe(
      'key-outside-folder'
    );
    expect((await runAs(A.keyId, req('GET', listing(A.prefix)))).code).toBe('key-outside-folder');
    expect(
      (
        await runAs(
          A.keyId,
          req('PUT', `/${BUCKET}/${A.prefix}/x`, copyHeader(BUCKET, `${sibling}/x`))
        )
      ).code
    ).toBe('key-outside-folder');
    expect(
      (
        await runAs(
          A.keyId,
          req('PUT', `/${BUCKET}/${sibling}/x`, copyHeader(BUCKET, `${A.prefix}/x`))
        )
      ).code
    ).toBe('key-outside-folder');
  });

  it('refuses the bare prefix as an object name and the prefix folder with no name', async () => {
    expect((await runAs(A.keyId, req('GET', `/${BUCKET}/${A.prefix}`))).code).toBe(
      'key-outside-folder'
    );
    expect((await runAs(A.keyId, req('GET', `/${BUCKET}/${A.prefix}/`))).code).toBe(
      'target-malformed'
    );
  });
});

describe('listing', () => {
  it.each([
    ['no prefix', `/${BUCKET}?list-type=2`],
    ['an empty prefix', `/${BUCKET}?list-type=2&prefix=`],
    ['the bucket root with a delimiter only', `/${BUCKET}?list-type=2&delimiter=%2F`],
  ])('refuses %s', async (_n, target) => {
    expect((await runAs(A.keyId, req('GET', target))).code).toBe('key-outside-folder');
  });

  it('admits its own prefix, a longer one and a partial name', async () => {
    for (const p of [
      `${A.prefix}/`,
      `${A.prefix}/.pulumi/stacks/proj/`,
      `${A.prefix}/.pulumi/stacks/pr`,
    ]) {
      expect((await runAs(A.keyId, req('GET', listing(p)))).code).toBe('ok');
    }
  });

  it.each([
    ['the V1 listing', `/${BUCKET}?prefix=${A.prefix}%2F`],
    ['a version listing', `/${BUCKET}?list-type=2&prefix=${A.prefix}%2F&versions`],
    ['an upload listing', `/${BUCKET}?uploads&prefix=${A.prefix}%2F`],
    ['a delimiter other than a slash', `/${BUCKET}?list-type=2&prefix=${A.prefix}%2F&delimiter=a`],
    ['a prefix that climbs out', `/${BUCKET}?list-type=2&prefix=${A.prefix}%2F..%2F${B.prefix}%2F`],
    ['a doubled slash', `/${BUCKET}?list-type=2&prefix=${A.prefix}%2F%2F`],
    [
      'a repeated prefix parameter',
      `/${BUCKET}?list-type=2&prefix=${A.prefix}%2F&prefix=${B.prefix}%2F`,
    ],
  ])('refuses %s', async (_n, target) => {
    expect((await runAs(A.keyId, req('GET', target))).code).not.toBe('ok');
  });

  it('does not admit a bucket-level call that is not a listing', async () => {
    for (const method of ['PUT', 'DELETE', 'POST', 'HEAD']) {
      expect((await runAs(A.keyId, req(method, `/${BUCKET}`))).code).toBe('operation-not-allowed');
    }
    expect((await runAs(A.keyId, req('GET', `/${BUCKET}?policy`))).code).toBe(
      'operation-not-allowed'
    );
    expect((await runAs(A.keyId, req('GET', `/${BUCKET}?acl`))).code).toBe('operation-not-allowed');
  });
});

describe('delete is confined to the lock folder of the caller', () => {
  it.each([
    ['a checkpoint', checkpoint(A.prefix)],
    ['a backup', `/${BUCKET}/${A.prefix}/.pulumi/backups/proj/stack/x.json`],
    ['meta.yaml', `/${BUCKET}/${A.prefix}/.pulumi/meta.yaml`],
    ['the locks folder itself', `/${BUCKET}/${A.prefix}/.pulumi/locks/`],
    ['a folder named like locks', `/${BUCKET}/${A.prefix}/.pulumi/locksX/a.json`],
  ])('refuses a delete of %s', async (_n, target) => {
    expect((await runAs(A.keyId, req('DELETE', target))).code).not.toBe('ok');
  });

  it('refuses bulk delete and the abort of an upload', async () => {
    expect((await runAs(A.keyId, req('POST', `/${BUCKET}?delete`))).code).toBe(
      'operation-not-allowed'
    );
    expect((await runAs(A.keyId, req('DELETE', `${lock(A.prefix)}?uploadId=abc`))).code).toBe(
      'operation-not-allowed'
    );
    expect((await runAs(A.keyId, req('DELETE', `${lock(A.prefix)}?versionId=abc`))).code).toBe(
      'operation-not-allowed'
    );
  });
});

describe('bucket and shape', () => {
  it('refuses another bucket, even one with the tenant prefix, for every operation', async () => {
    const other = 'some-media-shard';
    for (const [method, headers] of [
      ['GET', {}],
      ['PUT', {}],
      ['DELETE', {}],
    ] as const) {
      const t =
        method === 'DELETE'
          ? `/${other}/${A.prefix}/.pulumi/locks/x.json`
          : `/${other}/${A.prefix}/x`;
      expect((await runAs(A.keyId, req(method, t, headers))).code).toBe('bucket-not-allowed');
    }
    expect(
      (await runAs(A.keyId, req('GET', `/${other}?list-type=2&prefix=${A.prefix}%2F`))).code
    ).toBe('bucket-not-allowed');
    expect(
      (
        await runAs(
          A.keyId,
          req('PUT', `/${BUCKET}/${A.prefix}/x`, copyHeader(other, `${A.prefix}/x`))
        )
      ).code
    ).toBe('bucket-not-allowed');
  });

  it.each([
    ['a multipart create', req('POST', `/${BUCKET}/${A.prefix}/x?uploads`)],
    ['a multipart part', req('PUT', `/${BUCKET}/${A.prefix}/x?partNumber=1&uploadId=u`)],
    ['an ACL header', req('PUT', `/${BUCKET}/${A.prefix}/x`, { 'x-amz-acl': 'public-read' })],
    ['a tagging header', req('PUT', `/${BUCKET}/${A.prefix}/x`, { 'x-amz-tagging': 'a=b' })],
    [
      'a copy of a version',
      req('PUT', `/${BUCKET}/${A.prefix}/x`, {
        'x-amz-copy-source': `${BUCKET}/${A.prefix}/x%3FversionId%3D1`,
      }),
    ],
    [
      'a repeated copy source',
      req('PUT', `/${BUCKET}/${A.prefix}/x`, {
        'x-amz-copy-source': [`${BUCKET}/${A.prefix}/x`, `${BUCKET}/${B.prefix}/x`],
      }),
    ],
    [
      'a copy source on a read',
      req('GET', `/${BUCKET}/${A.prefix}/x`, copyHeader(BUCKET, `${A.prefix}/x`)),
    ],
    ['an unknown query parameter', req('GET', `/${BUCKET}/${A.prefix}/x?acl`)],
    ['a mismatched operation marker', req('GET', `/${BUCKET}/${A.prefix}/x?x-id=PutObject`)],
    ['an encoded separator', req('GET', `/${BUCKET}/${A.prefix}%2F..%2F${B.prefix}/x`)],
    ['a dot segment', req('GET', `/${BUCKET}/${A.prefix}/../${B.prefix}/x`)],
    ['PATCH', req('PATCH', `/${BUCKET}/${A.prefix}/x`)],
  ])('refuses %s', async (_n, request) => {
    expect((await runAs(A.keyId, request)).code).not.toBe('ok');
  });

  it('admits a copy within its own prefix, with the marker and a leading slash on the source', async () => {
    const src = `/${BUCKET}/${A.prefix}/.pulumi/stacks/proj/stack.json`;
    const request = req(
      'PUT',
      `/${BUCKET}/${A.prefix}/.pulumi/backups/proj/stack/1.json?x-id=CopyObject`,
      {
        'x-amz-copy-source': encodeURIComponent(src).replace(/%2F/g, '/'),
      }
    );
    const routed = routeStateRequest(request);
    expect(routed).toMatchObject({
      ok: true,
      route: { operation: 'CopyObject', copySource: { bucket: BUCKET } },
    });
    expect((await runAs(A.keyId, request)).code).toBe('ok');
  });

  it('refuses a copy source that is malformed', () => {
    for (const bad of ['', 'nobucket', `${BUCKET}/`, `${BUCKET}/a/../b`, '%E0%A4%A']) {
      const r = routeStateRequest(
        req('PUT', `/${BUCKET}/${A.prefix}/x`, { 'x-amz-copy-source': bad })
      );
      expect(r.ok).toBe(false);
    }
  });

  it('lists exactly the operations the design names', () => {
    expect([...STATE_OPERATIONS].sort()).toEqual(
      ['CopyObject', 'DeleteObject', 'GetObject', 'HeadObject', 'ListObjectsV2', 'PutObject'].sort()
    );
  });
});

describe('credential records', () => {
  const route = { operation: 'GetObject', bucket: BUCKET, key: `${A.prefix}/x` } as const;
  it.each([
    ['a media record', { folder: A.prefix, bucket: BUCKET, state: 'active', createdAt: CREATED }],
    [
      'an unknown profile',
      { profile: 'other', folder: A.prefix, bucket: BUCKET, state: 'active', createdAt: CREATED },
    ],
    [
      'a folder with a slash',
      { profile: 'state', folder: 'a/b', bucket: BUCKET, state: 'active', createdAt: CREATED },
    ],
    [
      'an empty folder',
      { profile: 'state', folder: '', bucket: BUCKET, state: 'active', createdAt: CREATED },
    ],
    [
      'a malformed bucket',
      { profile: 'state', folder: A.prefix, bucket: 'B', state: 'active', createdAt: CREATED },
    ],
  ] as const)('guardStateTenant refuses %s as invalid', (_n, record) => {
    expect(guardStateTenant(route, record as unknown as CredentialRecord)?.code).toBe(
      'credential-invalid'
    );
  });

  it('a disabled or revoked state credential is refused before its request is read', async () => {
    for (const state of ['disabled', 'revoked'] as const) {
      records['key-off'] = {
        profile: 'state',
        folder: A.prefix,
        bucket: BUCKET,
        state,
        createdAt: CREATED,
      };
      expect((await runAs('key-off', req('GET', checkpoint(A.prefix)))).code).toBe(
        'credential-not-active'
      );
    }
    delete records['key-off'];
  });

  it('an unknown key id answers as a bad signature', async () => {
    expect((await runAs('never-issued', req('GET', checkpoint(A.prefix)))).code).toBe(
      'signature-refused'
    );
  });

  it('a verifier or store that throws is a refusal, never a pass', async () => {
    const logged: RefusalLogEntry[] = [];
    const logger = { refusal: (e: RefusalLogEntry) => logged.push(e) };
    const r1 = await admitState(req('GET', checkpoint(A.prefix)), {
      verifier: {
        verify: async () => {
          throw new Error('boom');
        },
      },
      credentials: { lookup: async () => records[A.keyId] },
      logger,
    });
    const r2 = await admitState(req('GET', checkpoint(A.prefix)), {
      verifier: { verify: async () => ({ ok: true, keyId: A.keyId }) },
      credentials: {
        lookup: async () => {
          throw new Error('boom');
        },
      },
      logger,
    });
    const r3 = await admitState(req('GET', checkpoint(A.prefix)), {
      verifier: { verify: async () => ({ ok: true, keyId: '' }) },
      credentials: { lookup: async () => records[A.keyId] },
      logger,
    });
    for (const r of [r1, r2, r3])
      expect(r).toMatchObject({ ok: false, refusal: { code: 'internal-error' } });
  });

  it('passes a verifier refusal through', async () => {
    const r = await admitState(req('GET', checkpoint(A.prefix)), {
      verifier: {
        verify: async () => ({
          ok: false,
          refusal: { code: 'signature-refused', message: 'x', status: 403 },
        }),
      },
      credentials: { lookup: async () => records[A.keyId] },
      logger: { refusal: () => undefined },
    });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'signature-refused' } });
  });

  it('credentialProfile: absent is media, state is state, anything else is none', () => {
    expect(credentialProfile({})).toBe('media');
    expect(credentialProfile({ profile: 'media' })).toBe('media');
    expect(credentialProfile({ profile: 'state' })).toBe('state');
    expect(credentialProfile({ profile: 'x' })).toBeUndefined();
  });
});

describe("cross-profile: a credential is refused on the other profile's listener", () => {
  async function onMedia(keyId: string, request: GatewayRequest): Promise<RefusalCode | 'ok'> {
    const result = await admit(request, {
      verifier: { verify: async () => ({ ok: true, keyId }) },
      credentials: { lookup: async (id) => records[id] },
      logger: { refusal: () => undefined },
    });
    return result.ok ? 'ok' : result.refusal.code;
  }

  it('a state credential on the media listener is refused, even for a request the media path would admit', async () => {
    // Harness check: the same request shape is admitted for a media credential.
    expect(await onMedia(MEDIA.keyId, req('GET', `/${MEDIA_BUCKET}/${MEDIA.prefix}/a.png`))).toBe(
      'ok'
    );
    expect(await onMedia(A.keyId, req('GET', `/${BUCKET}/${A.prefix}/a.png`))).toBe(
      'profile-not-allowed'
    );
    expect(await onMedia(A.keyId, req('PUT', `/${BUCKET}/${A.prefix}/a.png`))).toBe(
      'profile-not-allowed'
    );
  });

  it('a media credential on the state listener is refused', async () => {
    const r = await runAs(MEDIA.keyId, req('GET', `/${MEDIA_BUCKET}/${MEDIA.prefix}/a.png`));
    expect(r.code).toBe('profile-not-allowed');
    expect(r.logged[0]).toMatchObject({ code: 'profile-not-allowed', keyId: MEDIA.keyId });
  });

  it('the media listener still refuses a delete of an object, whatever the key', async () => {
    expect(
      await onMedia(MEDIA.keyId, req('DELETE', `/${MEDIA_BUCKET}/${MEDIA.prefix}/a.png`))
    ).toBe('operation-not-allowed');
  });

  it('a record with an unknown profile is admitted by neither listener', async () => {
    records['key-odd'] = {
      profile: 'other',
      folder: A.prefix,
      bucket: BUCKET,
      state: 'active',
      createdAt: CREATED,
    } as unknown as CredentialRecord;
    expect(await onMedia('key-odd', req('GET', `/${BUCKET}/${A.prefix}/a.png`))).toBe(
      'profile-not-allowed'
    );
    expect((await runAs('key-odd', req('GET', checkpoint(A.prefix)))).code).toBe(
      'profile-not-allowed'
    );
    delete records['key-odd'];
  });
});
