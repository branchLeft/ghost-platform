import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPSTREAM_KEY_ID, UPSTREAM_SECRET, call, type Minted } from './support/gateway-rig.js';
import { STATE_BUCKET, nextPrefix, startStateRig, type StateRig } from './support/state-rig.js';

/** A path that is never the same twice, so a repeated request is not mistaken for a replay. */
let unique = 0;
const fresh = (path: string): string => `${path}.n${String(++unique)}`;
const lock = (p: string) => `/${STATE_BUCKET}/${p}/.pulumi/locks/organization/proj/stack/0001.json`;
const checkpoint = (p: string) => `/${STATE_BUCKET}/${p}/.pulumi/stacks/proj/stack.json`;
const listing = (p: string, rest = '.pulumi/stacks/') => ({
  method: 'GET',
  path: `/${STATE_BUCKET}`,
  query: { 'list-type': '2', prefix: `${p}/${rest}`, delimiter: '/' },
});

let visibleReads = 0;

describe('the state process, end to end', () => {
  let rig: StateRig;
  let a: Minted;
  let b: Minted;

  beforeAll(async () => {
    rig = await startStateRig();
    a = await rig.mint(nextPrefix());
    b = await rig.mint(nextPrefix());
  });
  afterAll(async () => {
    await rig.stop();
  });

  const seenCount = (): number => rig.upstream.seen.length;

  describe("a tenant's own prefix", () => {
    it('writes, reads, lists, copies and deletes a lock, each signed upstream with the shard key', async () => {
      const before = seenCount();
      const put = await rig.s3(a, { method: 'PUT', path: checkpoint(a.folder), body: '{"v":1}' });
      expect(put.status).toBe(200);
      expect((await rig.s3(a, { method: 'GET', path: checkpoint(a.folder) })).text).toBe(
        'STATE_BYTES'
      );
      expect((await rig.s3(a, { method: 'HEAD', path: checkpoint(a.folder) })).status).toBe(200);
      const list = await rig.s3(a, listing(a.folder));
      expect(list.status).toBe(200);
      expect(list.text).toContain('ListBucketResult');
      const copy = await rig.s3(a, {
        method: 'PUT',
        path: `${checkpoint(a.folder)}.bak`,
        headers: {
          'x-amz-copy-source': `/${STATE_BUCKET}/${a.folder}/.pulumi/stacks/proj/stack.json`,
        },
      });
      expect(copy.status).toBe(200);
      expect(copy.text).toContain('CopyObjectResult');
      expect((await rig.s3(a, { method: 'DELETE', path: lock(a.folder) })).status).toBe(204);

      const seen = rig.upstream.seen.slice(before);
      expect(seen.map((s) => s.method)).toEqual(['PUT', 'GET', 'HEAD', 'GET', 'PUT', 'DELETE']);
      for (const s of seen) {
        const authorization = String(s.headers.authorization);
        // Signed with the gateway's own key for the shard, never the tenant's.
        expect(authorization).toContain(`Credential=${UPSTREAM_KEY_ID}/`);
        expect(authorization).not.toContain(a.keyId);
      }
      expect(seen[0]?.bytes).toBe(7);
      // The copy source is rebuilt by the gateway from what it admitted.
      expect(seen[4]?.headers['x-amz-copy-source']).toBe(
        `/${STATE_BUCKET}/${a.folder}/.pulumi/stacks/proj/stack.json`
      );
      // The listing reaches the shard with the tenant's prefix and no owner request.
      expect(seen[3]?.url).toBe(
        `/${STATE_BUCKET}?delimiter=%2F&list-type=2&prefix=${a.folder}%2F.pulumi%2Fstacks%2F`
      );
    });

    it('never puts the upstream secret in an answer or a log line', async () => {
      const answer = await rig.s3(a, { method: 'GET', path: fresh(checkpoint(a.folder)) });
      const everything = [answer.text, JSON.stringify(answer.headers), ...rig.lines].join('\n');
      expect(everything).not.toContain(UPSTREAM_SECRET);
      expect(everything).not.toContain(a.secret);
    });
  });

  describe('two tenants, in both directions, scored by the gateway’s own refusal code', () => {
    const attacks = (own: Minted, other: Minted) =>
      [
        [
          'a read of the other tenant',
          { method: 'GET', path: checkpoint(other.folder) },
          'key-outside-folder',
        ],
        [
          'a head of the other tenant',
          { method: 'HEAD', path: checkpoint(other.folder) },
          'key-outside-folder',
        ],
        [
          'a write to the other tenant',
          { method: 'PUT', path: checkpoint(other.folder), body: 'x' },
          'key-outside-folder',
        ],
        ['a listing of the other tenant', listing(other.folder), 'key-outside-folder'],
        [
          'a listing of the whole bucket',
          { method: 'GET', path: `/${STATE_BUCKET}`, query: { 'list-type': '2', prefix: '' } },
          'key-outside-folder',
        ],
        [
          'a listing with no prefix',
          { method: 'GET', path: `/${STATE_BUCKET}`, query: { 'list-type': '2' } },
          'key-outside-folder',
        ],
        [
          'a delete of the other tenant’s lock',
          { method: 'DELETE', path: lock(other.folder) },
          'key-outside-folder',
        ],
        [
          'a delete of its own checkpoint',
          { method: 'DELETE', path: checkpoint(own.folder) },
          'key-outside-folder',
        ],
        [
          'a copy that reads the other tenant',
          {
            method: 'PUT',
            path: `${checkpoint(own.folder)}.stolen`,
            headers: {
              'x-amz-copy-source': `/${STATE_BUCKET}/${other.folder}/.pulumi/stacks/proj/stack.json`,
            },
          },
          'key-outside-folder',
        ],
        [
          'a copy that writes into the other tenant',
          {
            method: 'PUT',
            path: `${checkpoint(other.folder)}.planted`,
            headers: {
              'x-amz-copy-source': `/${STATE_BUCKET}/${own.folder}/.pulumi/stacks/proj/stack.json`,
            },
          },
          'key-outside-folder',
        ],
        [
          'an object in another bucket',
          { method: 'GET', path: `/some-other-bucket/${own.folder}/x` },
          'bucket-not-allowed',
        ],
        [
          'a multipart start',
          { method: 'POST', path: checkpoint(own.folder), query: { uploads: '' } },
          'operation-not-allowed',
        ],
        [
          'a bulk delete',
          { method: 'POST', path: `/${STATE_BUCKET}`, query: { delete: '' } },
          'operation-not-allowed',
        ],
        [
          'a bucket policy read',
          { method: 'GET', path: `/${STATE_BUCKET}`, query: { policy: '' } },
          'operation-not-allowed',
        ],
        [
          'an ACL write',
          { method: 'PUT', path: checkpoint(own.folder), query: { acl: '' } },
          'operation-not-allowed',
        ],
      ] as const;

    it.each([
      ['A against B', () => [a, b] as const],
      ['B against A', () => [b, a] as const],
    ])(
      '%s: every attack is refused with the gateway’s own code and reaches no storage',
      async (_label, pick) => {
        const [own, other] = pick();
        // The harness can see: the other tenant reads its own object first.
        // (A name of its own each time: an identical signed request is a replay.)
        const visible = `${checkpoint(other.folder)}.visible-${String(++visibleReads)}`;
        expect((await rig.s3(other, { method: 'GET', path: visible })).status).toBe(200);

        for (const [label, spec, code] of attacks(own, other)) {
          const beforeSeen = seenCount();
          const beforeRefusals = rig.refusals().length;
          const result = await rig.s3(own, spec as never);
          expect(result.status, label).toBeGreaterThanOrEqual(400);
          expect(rig.refusals().slice(beforeRefusals), label).toEqual([code]);
          expect(seenCount(), `${label} reached the shard`).toBe(beforeSeen);
        }
      }
    );

    it('refuses the sibling prefix: abc never reaches abcd', async () => {
      const short = await rig.mint('siblingprefix000');
      const long = await rig.mint('siblingprefix0000');
      const before = rig.refusals().length;
      const result = await rig.s3(short, { method: 'GET', path: checkpoint(long.folder) });
      expect(result.status).toBe(403);
      expect(rig.refusals().slice(before)).toEqual(['key-outside-folder']);
    });
  });

  describe('who may call', () => {
    it('answers an unsigned request and an unknown key id as a bad signature', async () => {
      const unsigned = await call(rig.port, 'GET', checkpoint(a.folder), {});
      const stranger = await rig.s3(
        { keyId: 'GWSTRANGER00000000000000', secret: 'nope', folder: a.folder },
        { method: 'GET', path: checkpoint(a.folder) }
      );
      expect(unsigned.status).toBe(403);
      expect(stranger.status).toBe(403);
      expect(unsigned.text).toBe(stranger.text);
    });

    it('refuses a tampered body: the bytes must be the ones the signature covered', async () => {
      const signed = await rig.sign(a, {
        method: 'PUT',
        path: checkpoint(a.folder),
        body: 'signed',
      });
      const before = seenCount();
      const result = await call(rig.port, 'PUT', signed.target, signed.headers, 'SIGNED');
      expect(result.status).toBe(403);
      expect(seenCount()).toBe(before);
    });

    it('refuses a read, a listing, a copy or a delete that declares a body, and reads none of it', async () => {
      const before = seenCount();
      const refusals = rig.refusals().length;
      const outcome = await rig
        .s3(a, { method: 'GET', path: fresh(checkpoint(a.folder)), body: 'unexpected' })
        .then(
          (r) => String(r.status),
          () => 'reset'
        );
      expect(['403', 'reset']).toContain(outcome);
      expect(rig.refusals().slice(refusals)).toEqual(['operation-not-allowed']);
      expect(seenCount()).toBe(before);
    });

    it('refuses a replay of the same signed request', async () => {
      const signed = await rig.sign(a, { method: 'GET', path: fresh(checkpoint(a.folder)) });
      expect((await call(rig.port, 'GET', signed.target, signed.headers)).status).toBe(200);
      expect((await call(rig.port, 'GET', signed.target, signed.headers)).status).toBe(403);
    });
  });

  describe('the body cap', () => {
    it('refuses a body over the state cap before reading it, and stores nothing', async () => {
      const capped = await startStateRig({ env: { STORAGE_GATEWAY_MAX_BODY_MIB: '1' } });
      try {
        const t = await capped.mint(nextPrefix());
        const over = 'x'.repeat(1024 * 1024 + 1);
        // The process refuses on the declared length and closes while the client is still
        // sending, so the client sees the 413 or a reset; the log says which refusal it was.
        const outcome = await capped
          .s3(t, { method: 'PUT', path: checkpoint(t.folder), body: over })
          .then(
            (r) => String(r.status),
            () => 'reset'
          );
        expect(['413', 'reset']).toContain(outcome);
        expect(capped.refusals()).toEqual(['body-too-large']);
        expect(capped.upstream.seen).toHaveLength(0);
        const under = await capped.s3(t, {
          method: 'PUT',
          path: fresh(checkpoint(t.folder)),
          body: 'ok',
        });
        expect(under.status).toBe(200);
      } finally {
        await capped.stop();
      }
    });
  });

  describe('the write switch', () => {
    it('stops writes and deletes for a tenant and leaves its reads alone', async () => {
      const t = await rig.mint(nextPrefix());
      rig.gateway.switches.setTenant(t.keyId, true);
      const before = rig.refusals().length;
      expect(
        (await rig.s3(t, { method: 'PUT', path: checkpoint(t.folder), body: 'x' })).status
      ).toBe(503);
      expect((await rig.s3(t, { method: 'DELETE', path: lock(t.folder) })).status).toBe(503);
      expect(rig.refusals().slice(before)).toEqual(['writes-disabled', 'writes-disabled']);
      expect((await rig.s3(t, { method: 'GET', path: checkpoint(t.folder) })).status).toBe(200);
      rig.gateway.switches.setTenant(t.keyId, false);
    });
  });

  describe('a media credential on the state process', () => {
    it('is refused: the state store holds no media credential and its secret source signs for none', async () => {
      const result = await rig.s3(
        {
          keyId: 'GWMEDIA000000000000000000',
          secret: 'media-secret',
          folder: 'mediafolder0000001',
        },
        { method: 'GET', path: `/${STATE_BUCKET}/mediafolder0000001/x` }
      );
      expect(result.status).toBe(403);
    });
  });

  describe('health', () => {
    it('answers health and readiness without a signature', async () => {
      expect((await call(rig.port, 'GET', '/healthz', {})).status).toBe(200);
      expect((await call(rig.port, 'GET', '/readyz', {})).status).toBe(200);
    });
  });
});
