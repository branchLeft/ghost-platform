import { createHash } from 'node:crypto';
import { request, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestBroker, type TestBroker } from '../test/helpers/testBroker.js';
import { demoDescriptor, descriptorForSlot } from '../test/helpers/fixtures.js';
import { signHeaders } from '../test/helpers/signer.js';

/**
 * What the generated adapter would do on its own, that the contract in
 * `openapi.yaml` does not say it does: match a path with an empty segment,
 * answer a bad body as `application/problem+json`, throw on a bad
 * percent-escape. The broker's front door and gate exist to keep those from
 * ever reaching a caller; these tests pin that, over a real socket and with
 * no mock of the adapter.
 */
interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function raw(
  broker: TestBroker,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
  chunks?: readonly Buffer[]
): Promise<RawResponse> {
  const { port } = new URL(broker.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(parts).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    if (chunks !== undefined) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function signed(broker: TestBroker, method: string, path: string, body: Buffer) {
  return {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    ...signHeaders(broker.keyPair, method, path, body, Math.floor(broker.nowMs() / 1000)),
  };
}

describe('the broker front door and gate, in front of the generated adapter', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('answers a path with an empty segment 404, though the adapter alone would match it', async () => {
    broker = await startTestBroker();
    const body = Buffer.from(JSON.stringify({ slot: '0' }));
    const absoluteForm = `${broker.baseUrl}/reset`;
    for (const path of ['/reset/', '//reset', '/status/', '/status/0/', absoluteForm]) {
      const method = path.startsWith('/status') ? 'GET' : 'POST';
      const res = await raw(broker, method, path, signed(broker, method, path, body), body);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe('');
      expect(res.headers['content-type'], path).toBeUndefined();
    }
    // The control case: the same signed request to the exact path is served.
    const ok = await raw(broker, 'POST', '/reset', signed(broker, 'POST', '/reset', body), body);
    expect(ok.status).toBe(200);
  });

  it('checks the signature before it looks at the body: bad signature with invalid JSON is 401, no body', async () => {
    broker = await startTestBroker();
    const body = Buffer.from('{not json');
    const headers = { ...signed(broker, 'POST', '/reconcile', body), 'X-Broker-Signature': 'AAAA' };
    const res = await raw(broker, 'POST', '/reconcile', headers, body);
    expect(res.status).toBe(401);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('answers a signed JSON null as a missing slot (422), not a server fault', async () => {
    broker = await startTestBroker();
    const body = Buffer.from('null');
    const res = await raw(broker, 'POST', '/reset', signed(broker, 'POST', '/reset', body), body);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toHaveProperty('error');
  });

  it('answers a body that breaks the spec schema as 400 {error} JSON, not the adapter problem document', async () => {
    broker = await startTestBroker();
    const body = Buffer.from(JSON.stringify({ slot: '0', descriptor: 7 }));
    const res = await raw(
      broker,
      'POST',
      '/reconcile',
      signed(broker, 'POST', '/reconcile', body),
      body
    );
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({
      error: expect.stringContaining('request body does not match the API contract'),
    });
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('refuses a body over the cap by its declared length, with no body, before reading it', async () => {
    broker = await startTestBroker();
    const body = Buffer.alloc(300 * 1024, 'x');
    const res = await raw(
      broker,
      'POST',
      '/reconcile',
      signed(broker, 'POST', '/reconcile', body),
      body
    );
    expect(res.status).toBe(413);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a body-less poll that carries a body over the cap', async () => {
    broker = await startTestBroker();
    const body = Buffer.alloc(300 * 1024, 'x');
    const res = await raw(broker, 'GET', '/drain', signed(broker, 'GET', '/drain', body), body);
    expect(res.status).toBe(413);
    expect(res.body).toBe('');
  });

  it('answers a fault in the front door itself 500 with no body, never a dropped connection', async () => {
    broker = await startTestBroker({
      wrapDeps: (deps) =>
        Object.create(deps, {
          slotLiterals: {
            get() {
              throw new Error('front door fault');
            },
          },
        }) as typeof deps,
    });
    const res = await raw(broker, 'GET', '/status/0', {});
    expect(res.status).toBe(500);
    expect(res.body).toBe('');
  });

  it('refuses a body over the cap that declares no length', async () => {
    broker = await startTestBroker();
    const body = Buffer.alloc(300 * 1024, 'x');
    const headers = signed(broker, 'POST', '/reconcile', body);
    delete (headers as Record<string, string>)['Content-Length'];
    const res = await raw(broker, 'POST', '/reconcile', headers, undefined, [
      body.subarray(0, 100 * 1024),
      body.subarray(100 * 1024),
    ]);
    expect(res.status).toBe(413);
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('refuses an unknown descriptor field the way validate() did, instead of dropping it', async () => {
    broker = await startTestBroker();
    const descriptor = { ...descriptorForSlot('0' as never), zzExtra: 1 };
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'descriptor has unknown key(s): zzExtra.' });
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('refuses a __proto__ key in the descriptor, as an own property of the parsed body', async () => {
    broker = await startTestBroker();
    const json = JSON.stringify({ slot: '0', descriptor: descriptorForSlot('0' as never) });
    const body = Buffer.from(json.replace('"descriptor":{', '"descriptor":{"__proto__":{"x":1},'));
    const res = await raw(
      broker,
      'POST',
      '/reconcile',
      signed(broker, 'POST', '/reconcile', body),
      body
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'descriptor has unknown key(s): __proto__.' });
    expect(broker.renderer.calls).toHaveLength(0);
  });

  it('answers 200, not a response-check 500, when the clock steps back during an image load', async () => {
    let ticks = 0;
    broker = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        // Each reading is earlier than the one before it.
        imagePush: { ...deps.imagePush, nowMs: () => 10_000 - (ticks += 1) * 100 },
      }),
    });
    const bytes = Buffer.from('a tar stand-in loaded while the clock goes backwards');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const size = String(bytes.length);
    const res = await fetch(`${broker.baseUrl}/image`, {
      method: 'POST',
      headers: {
        ...broker.signImagePushHeaders(digest, size),
        'X-Image-Digest': digest,
        'X-Image-Size': size,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ digest, bytes: bytes.length, durationMs: 0 });
    expect(broker.imageLoader.calls).toHaveLength(1);
  });

  it('never answers with the adapter problem media type, whatever is malformed', async () => {
    broker = await startTestBroker();
    const good = Buffer.from(JSON.stringify({ slot: '0', descriptor: demoDescriptor() }));
    const cases: { method: string; path: string; body: Buffer }[] = [
      { method: 'POST', path: '/reconcile', body: Buffer.from('') },
      { method: 'POST', path: '/reconcile', body: Buffer.from('[]') },
      { method: 'POST', path: '/reset', body: Buffer.from('{"slot": 7}') },
      { method: 'POST', path: '/stop', body: Buffer.from('{"slot": "../x"}') },
      { method: 'POST', path: '/reconcile', body: good.subarray(0, 20) },
    ];
    for (const { method, path, body } of cases) {
      const res = await raw(broker, method, path, signed(broker, method, path, body), body);
      expect(res.status, `${path} ${body.toString()}`).toBeGreaterThanOrEqual(400);
      expect(res.headers['content-type'] ?? '', path).not.toContain('problem');
    }
  });
});
