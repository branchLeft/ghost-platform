import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUCKET,
  MIB,
  call,
  callKeepAlive,
  nextFolder,
  startRig,
  type Minted,
  type Rig,
  type SignedCall,
} from './support/gateway-rig.js';

// The service as a tenant meets it: a signed request sent twice, one tenant
// holding more than its share of uploads, and what the connection does after
// a refusal. Each test runs the real service with a fake storage service.

const OBJECT = (folder: string, name: string): string => `/${BUCKET}/${folder}/${name}`;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const badSignature = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  authorization:
    headers.authorization?.replace(/Signature=[0-9a-f]{64}$/, `Signature=${'0'.repeat(64)}`) ?? '',
});

/** Sends a signed call exactly as signed. */
function send(rig: Rig, signed: SignedCall) {
  return call(rig.port, signed.method, signed.target, signed.headers, signed.body || undefined);
}

function sendKeepAlive(rig: Rig, signed: SignedCall) {
  return callKeepAlive(
    rig.port,
    signed.method,
    signed.target,
    signed.headers,
    signed.body || undefined
  );
}

interface OpenUpload {
  /** Resolves with the answer, whenever it comes. */
  readonly answer: Promise<number | string>;
  /** Sends the rest of the body and waits for the answer. */
  finish(): Promise<number | string>;
  /** Drops the connection with the body unfinished. */
  abort(): void;
}

/** A signed upload that has sent half its body and holds the rest back, so it keeps its slot. */
function openUpload(rig: Rig, signed: SignedCall, restOverride?: string): OpenUpload {
  const half = Math.floor(signed.body.length / 2);
  const req = httpRequest({
    host: '127.0.0.1',
    port: rig.port,
    method: signed.method,
    path: signed.target,
    headers: signed.headers,
    agent: false,
  });
  const answer = new Promise<number | string>((resolve) => {
    req.on('error', () => resolve('reset'));
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
  });
  req.write(signed.body.slice(0, half));
  return {
    answer,
    finish: () => {
      req.end(restOverride ?? signed.body.slice(half));
      return answer;
    },
    abort: () => req.destroy(),
  };
}

async function upload(rig: Rig, tenant: Minted, name: string, size = 2000): Promise<SignedCall> {
  return rig.sign(tenant, {
    method: 'PUT',
    path: OBJECT(tenant.folder, name),
    body: 'u'.repeat(size),
  });
}

describe('a replayed request', () => {
  let rig: Rig;
  let tenant: Minted;

  beforeAll(async () => {
    rig = await startRig({ env: { STORAGE_GATEWAY_SPOOL_THRESHOLD_BYTES: '1024' } });
    tenant = await rig.mint(nextFolder(), 16);
  });

  afterAll(async () => {
    await rig.stop();
  });

  it('is refused the second time and reaches the storage service once, for a GET', async () => {
    const before = rig.upstream.seen.length;
    const signed = await rig.sign(tenant, {
      method: 'GET',
      path: OBJECT(tenant.folder, 'get.png'),
    });
    expect((await send(rig, signed)).status).toBe(200);
    const again = await send(rig, signed);
    expect(again.status).toBe(403);
    expect(again.text).toContain('<Code>AccessDenied</Code>');
    expect(rig.upstream.seen.length - before).toBe(1);
    expect(rig.lines.join('\n')).toContain('"reason":"replayed"');
  });

  it('is refused the second time, for a CreateMultipartUpload, so no second upload id is bound', async () => {
    const before = rig.upstream.seen.length;
    const signed = await rig.sign(tenant, {
      method: 'POST',
      path: OBJECT(tenant.folder, 'create.bin'),
      query: { uploads: '' },
    });
    expect((await send(rig, signed)).status).toBe(200);
    expect((await send(rig, signed)).status).toBe(403);
    expect(rig.upstream.seen.length - before).toBe(1);
  });

  it('is refused the second time, for a PUT with a body, before the body is read', async () => {
    const before = rig.upstream.seen.length;
    const signed = await upload(rig, tenant, 'put.bin', 4096);
    expect((await send(rig, signed)).status).toBe(200);
    expect((await send(rig, signed)).status).toBe(403);
    expect(rig.upstream.seen.length - before).toBe(1);
    expect(await rig.spoolFiles()).toEqual([]);
  });

  it('does not let a tampered copy burn the signature the real request needs', async () => {
    const signed = await rig.sign(tenant, {
      method: 'GET',
      path: OBJECT(tenant.folder, 'burn.png'),
    });
    // The same Authorization header on a different object: the signature does not match it.
    const tampered = {
      ...signed,
      target: OBJECT(tenant.folder, 'burn-other.png'),
    };
    expect((await send(rig, tampered)).status).toBe(403);
    expect((await send(rig, signed)).status).toBe(200);
  });

  it('lets two different requests signed in the same second both through', async () => {
    const path = OBJECT(tenant.folder, 'pair.png');
    const get = await rig.sign(tenant, { method: 'GET', path });
    const head = await rig.sign(tenant, { method: 'HEAD', path });
    const other = await rig.sign(tenant, {
      method: 'GET',
      path: OBJECT(tenant.folder, 'pair2.png'),
    });
    for (const signed of [get, head, other]) expect((await send(rig, signed)).status).toBe(200);
  });

  it('keeps the connection closed for a refused PUT whose body it never read', async () => {
    const signed = await upload(rig, tenant, 'closed.bin');
    expect((await send(rig, signed)).status).toBe(200);
    const again = await sendKeepAlive(rig, signed);
    expect(again.status).toBe(403);
    expect(again.headers.connection).toBe('close');
  });
});

describe('a signature the gateway answered "try again" to', () => {
  it('can be sent again as it was, in the same second, and is not taken for a replay', async () => {
    const rig = await startRig({
      env: {
        STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS: '4',
        STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS_PER_TENANT: '1',
      },
    });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const holder = openUpload(rig, await upload(rig, tenant, 'holder.bin'));
      await pause(150);
      const retried = await upload(rig, tenant, 'retried.bin');
      const refused = await send(rig, retried);
      expect(refused.status).toBe(503);
      expect(refused.text).toContain('<Code>SlowDown</Code>');
      expect(await holder.finish()).toBe(200);
      // An SDK retry signs again within the same second: the same bytes, the same signature.
      expect((await send(rig, retried)).status).toBe(200);
      // And now it is spent.
      expect((await send(rig, retried)).status).toBe(403);
    } finally {
      await rig.stop();
    }
  });

  it('can be sent again when the client cut the body short', async () => {
    const rig = await startRig();
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const signed = await upload(rig, tenant, 'cut.bin');
      const cut = openUpload(rig, signed);
      await pause(100);
      cut.abort();
      await pause(100);
      expect((await send(rig, signed)).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });
});

describe('a full replay guard', () => {
  it('refuses a request it cannot remember with a retryable 503, and logs why', async () => {
    const rig = await startRig({ replayLimit: 1 });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const first = await rig.sign(tenant, { method: 'GET', path: OBJECT(tenant.folder, 'a.png') });
      const second = await rig.sign(tenant, {
        method: 'GET',
        path: OBJECT(tenant.folder, 'b.png'),
      });
      expect((await send(rig, first)).status).toBe(200);
      const full = await send(rig, second);
      expect(full.status).toBe(503);
      expect(rig.lines.join('\n')).toContain('"reason":"full"');
      // Nothing was evicted to make room: the first request is still a replay.
      expect((await send(rig, first)).status).toBe(403);
      // Its failure is retryable, so the same request may be sent again; it is full still.
      expect((await send(rig, second)).status).toBe(503);
    } finally {
      await rig.stop();
    }
  });
});

describe('the per-tenant upload cap', () => {
  const ENV = {
    STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS: '4',
    STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS_PER_TENANT: '2',
  };

  it('stops one tenant at its cap, lets another tenant on, and lets the first on again when it frees', async () => {
    const rig = await startRig({ env: ENV });
    try {
      const a = await rig.mint(nextFolder(), 16);
      const b = await rig.mint(nextFolder(), 16);
      const held = [
        openUpload(rig, await upload(rig, a, 'one.bin')),
        openUpload(rig, await upload(rig, a, 'two.bin')),
      ];
      await pause(150);

      const third = await send(rig, await upload(rig, a, 'three.bin'));
      expect(third.status).toBe(503);
      expect(third.text).toContain('<Code>SlowDown</Code>');
      expect(rig.lines.join('\n')).toContain('"code":"tenant-upload-limit"');

      // The gateway as a whole is not full, so another tenant is served.
      expect((await send(rig, await upload(rig, b, 'mine.bin'))).status).toBe(200);

      expect(await held[0]?.finish()).toBe(200);
      expect((await send(rig, await upload(rig, a, 'four.bin'))).status).toBe(200);
      expect(await held[1]?.finish()).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('gives the slot back on every way an upload can end', async () => {
    const rig = await startRig({ env: ENV });
    try {
      const a = await rig.mint(nextFolder(), 16);
      // Ends in a digest mismatch: same length, other bytes.
      const swapped = openUpload(rig, await upload(rig, a, 'swapped.bin', 2000), 'z'.repeat(1000));
      expect(await swapped.finish()).toBe(403);
      // Ends with the client gone.
      const dropped = openUpload(rig, await upload(rig, a, 'dropped.bin'));
      await pause(100);
      dropped.abort();
      expect(await dropped.answer).toBe('reset');
      // Ends normally.
      expect((await send(rig, await upload(rig, a, 'normal.bin'))).status).toBe(200);
      await pause(100);

      // A leaked slot would leave room for one, not two.
      const held = [
        openUpload(rig, await upload(rig, a, 'one.bin')),
        openUpload(rig, await upload(rig, a, 'two.bin')),
      ];
      await pause(150);
      expect((await send(rig, await upload(rig, a, 'three.bin'))).status).toBe(503);
      for (const h of held) expect(await h.finish()).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('cannot be used up by requests that only name the tenant key', async () => {
    const rig = await startRig({ env: ENV });
    try {
      const a = await rig.mint(nextFolder(), 16);
      const held = [
        openUpload(rig, await upload(rig, a, 'one.bin')),
        openUpload(rig, await upload(rig, a, 'two.bin')),
      ];
      await pause(150);
      // With the tenant at its cap, a forged request is still a bad signature, not a slot refusal.
      for (let i = 0; i < 3; i += 1) {
        const forged = await rig.sign(
          a,
          { method: 'PUT', path: OBJECT(a.folder, `forged${i}.bin`), body: 'f'.repeat(100) },
          badSignature
        );
        const answer = await send(rig, forged);
        expect(answer.status).toBe(403);
        expect(answer.text).toContain('<Code>AccessDenied</Code>');
      }
      for (const h of held) expect(await h.finish()).toBe(200);
      // The forged traffic took nothing from the tenant: it holds its full share again.
      const again = [
        openUpload(rig, await upload(rig, a, 'five.bin')),
        openUpload(rig, await upload(rig, a, 'six.bin')),
      ];
      await pause(150);
      expect((await send(rig, await upload(rig, a, 'seven.bin'))).status).toBe(503);
      for (const h of again) expect(await h.finish()).toBe(200);
    } finally {
      await rig.stop();
    }
  });
});

describe('Connection: close on a refused request', () => {
  let rig: Rig;
  let tenant: Minted;
  let small: Minted;

  beforeAll(async () => {
    rig = await startRig({
      env: {
        STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS: '3',
        STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS_PER_TENANT: '1',
      },
    });
    tenant = await rig.mint(nextFolder(), 16);
    small = await rig.mint(nextFolder(), 1);
  });

  afterAll(async () => {
    await rig.stop();
  });

  const put = (
    who: Minted,
    folder: string,
    tamper?: (h: Record<string, string>) => Record<string, string>
  ) =>
    rig.sign(
      who,
      {
        method: 'PUT',
        path: OBJECT(folder, `refused-${Math.random()}.bin`),
        body: 'b'.repeat(100),
      },
      tamper
    );

  it('is sent when the body was not read, whatever refused the request', async () => {
    // The tenant's own cap is 1: a held upload makes its next one refuse for that.
    const holder = openUpload(rig, await upload(rig, tenant, 'holder.bin'));
    await pause(150);
    const declaredTooLarge = await rig.sign(small, {
      method: 'PUT',
      path: OBJECT(small.folder, 'big.bin'),
      body: 'x',
      headers: { 'content-length': String(2 * MIB) },
    });
    const cases: [string, SignedCall, number][] = [
      [
        'an unsigned request',
        {
          ...(await put(tenant, tenant.folder)),
          headers: { host: `127.0.0.1:${rig.port}`, 'content-length': '100' },
        },
        403,
      ],
      ['a bad signature', await put(tenant, tenant.folder, badSignature), 403],
      ["a folder that is not the tenant's", await put(tenant, 'someoneelsesfolder0001'), 403],
      ['a body over the tenant ceiling', declaredTooLarge, 413],
      ['a tenant already at its upload cap', await put(tenant, tenant.folder), 503],
    ];
    for (const [name, signed, status] of cases) {
      const answer = await sendKeepAlive(rig, signed);
      expect(answer.status, name).toBe(status);
      expect(answer.headers.connection, name).toBe('close');
    }
    expect(await holder.finish()).toBe(200);
  });

  it('is sent when the gateway as a whole is full', async () => {
    const others = await Promise.all([1, 2, 3].map(() => rig.mint(nextFolder(), 16)));
    const holders = await Promise.all(
      others.map(async (who) => openUpload(rig, await upload(rig, who, 'h.bin')))
    );
    await pause(150);
    const fourth = await rig.mint(nextFolder(), 16);
    const answer = await sendKeepAlive(rig, await put(fourth, fourth.folder));
    expect(answer.status).toBe(503);
    expect(rig.lines.join('\n')).toContain('"code":"upstream-throttled"');
    expect(answer.headers.connection).toBe('close');
    for (const h of holders) expect(await h.finish()).toBe(200);
  });

  it('is not sent when the connection can be reused: an answered GET, and a refusal with no body to leave unread', async () => {
    const ok = await rig.sign(tenant, { method: 'GET', path: OBJECT(tenant.folder, 'plain.png') });
    expect((await sendKeepAlive(rig, ok)).headers.connection).toBe('keep-alive');
    const refused = await rig.sign(tenant, {
      method: 'GET',
      path: OBJECT('someoneelsesfolder0001', 'x.png'),
    });
    const answer = await sendKeepAlive(rig, refused);
    expect(answer.status).toBe(403);
    expect(answer.headers.connection).toBe('keep-alive');
  });
});
