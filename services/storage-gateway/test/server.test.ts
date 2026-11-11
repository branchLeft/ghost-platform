import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUCKET,
  MIB,
  UPSTREAM_KEY_ID,
  UPSTREAM_SECRET,
  call,
  nextFolder,
  startRig,
  type Minted,
  type Rig,
  type SignedCall,
} from './support/gateway-rig.js';
import { sha256Hex } from './support/reference-signer.js';

// The real service, started from its real configuration, with a fake storage
// service behind it and tenants minted through the real admin interface.

const OBJECT = (folder: string, name: string): string => `/${BUCKET}/${folder}/${name}`;
const PART = 5 * MIB;

describe('the gateway service', () => {
  let rig: Rig;
  let tenant: Minted;

  beforeAll(async () => {
    rig = await startRig();
    tenant = await rig.mint(nextFolder(), 16);
  });

  afterAll(async () => {
    await rig.stop();
  });

  it('answers health and readiness without credentials', async () => {
    const health = await call(rig.port, 'GET', '/healthz', {});
    expect(health.status).toBe(200);
    expect(health.text).toBe('{"status":"ok"}');
    expect((await call(rig.port, 'HEAD', '/healthz', {})).status).toBe(200);
    const ready = await call(rig.port, 'GET', '/readyz', {});
    expect(ready.status).toBe(200);
    expect(ready.text).toBe('{"status":"ready"}');
    expect(ready.headers['x-gateway-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('forwards a PUT object, re-signed with the gateway key and with the body intact', async () => {
    const before = rig.upstream.seen.length;
    const body = 'IMAGE_BYTES_PLACEHOLDER';
    const answer = await rig.s3(tenant, {
      method: 'PUT',
      path: OBJECT(tenant.folder, 'photo.png'),
      headers: { 'content-type': 'image/png' },
      body,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.etag).toBe('"abc"');
    const seen = rig.upstream.seen.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.url).toBe(OBJECT(tenant.folder, 'photo.png'));
    expect(seen[0]?.sha256).toBe(sha256Hex(body));
    const authorization = String(seen[0]?.headers.authorization);
    expect(authorization).toContain(`Credential=${UPSTREAM_KEY_ID}/`);
    expect(authorization).not.toContain(tenant.keyId);
  });

  it('serves GET and HEAD of an object', async () => {
    const get = await rig.s3(tenant, { method: 'GET', path: OBJECT(tenant.folder, 'photo.png') });
    expect(get.status).toBe(200);
    expect(get.text).toBe('OBJECT_BYTES');
    const head = await rig.s3(tenant, { method: 'HEAD', path: OBJECT(tenant.folder, 'photo.png') });
    expect(head.status).toBe(200);
    expect(head.headers.etag).toBe('"abc"');
  });

  it('completes a 12 MiB multipart upload in parts, spooling each and leaving no spool file', async () => {
    const before = rig.upstream.seen.length;
    const path = OBJECT(tenant.folder, 'video.bin');
    const created = await rig.s3(tenant, { method: 'POST', path, query: { uploads: '' } });
    expect(created.status).toBe(200);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.text)?.[1] ?? '';
    expect(uploadId).not.toBe('');

    const sizes = [PART, PART, 2 * MIB];
    const parts: string[] = [];
    for (const [index, size] of sizes.entries()) {
      const number = index + 1;
      const part = await rig.s3(tenant, {
        method: 'PUT',
        path,
        query: { partNumber: String(number), uploadId },
        body: String.fromCharCode(97 + index).repeat(size),
      });
      expect(part.status).toBe(200);
      parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>"abc"</ETag></Part>`);
    }
    const done = await rig.s3(tenant, {
      method: 'POST',
      path,
      query: { uploadId },
      headers: { 'content-type': 'application/xml' },
      body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
    });
    expect(done.status).toBe(200);
    expect(done.text).toContain('CompleteMultipartUploadResult');

    const seen = rig.upstream.seen.slice(before);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'PUT', 'PUT', 'PUT', 'POST']);
    expect(seen.slice(1, 4).reduce((sum, s) => sum + s.bytes, 0)).toBe(12 * MIB);
    expect(await rig.spoolFiles()).toEqual([]);
  });

  it('refuses a part for an upload id it never issued, and sends nothing upstream', async () => {
    const before = rig.upstream.seen.length;
    const part = await rig.s3(tenant, {
      method: 'PUT',
      path: OBJECT(tenant.folder, 'other.bin'),
      query: { partNumber: '1', uploadId: 'NOT-ISSUED' },
      body: 'x',
    });
    expect(part.status).toBe(403);
    expect(rig.upstream.seen.length).toBe(before);
  });

  it('refuses a bad signature with 403 and sends nothing upstream', async () => {
    const before = rig.upstream.seen.length;
    const forged = await rig.s3(
      tenant,
      { method: 'PUT', path: OBJECT(tenant.folder, 'evil.png'), body: 'FORGED_BYTES' },
      (headers) => ({
        ...headers,
        authorization:
          headers.authorization?.replace(
            /Signature=[0-9a-f]{64}$/,
            `Signature=${'0'.repeat(64)}`
          ) ?? '',
      })
    );
    expect(forged.status).toBe(403);
    expect(forged.text).toContain('<Code>AccessDenied</Code>');
    expect(rig.upstream.seen.length).toBe(before);
  });

  it('refuses an unsigned request before reading its body', async () => {
    const before = rig.upstream.seen.length;
    const answer = await call(
      rig.port,
      'PUT',
      OBJECT(tenant.folder, 'unsigned.png'),
      { host: `127.0.0.1:${rig.port}`, 'content-length': '5' },
      'hello'
    );
    expect(answer.status).toBe(403);
    expect(rig.upstream.seen.length).toBe(before);
    expect(await rig.spoolFiles()).toEqual([]);
  });

  it('refuses a request for another tenant folder', async () => {
    const before = rig.upstream.seen.length;
    const answer = await rig.s3(tenant, {
      method: 'PUT',
      path: OBJECT('someoneelsesfolder0001', 'photo.png'),
      body: 'x',
    });
    expect(answer.status).toBe(403);
    expect(rig.upstream.seen.length).toBe(before);
  });

  it('refuses a body over the tenant ceiling, removes its spool file and sends nothing upstream', async () => {
    const small = await rig.mint(nextFolder(), 1);
    const before = rig.upstream.seen.length;
    const body = 'z'.repeat(2 * MIB);
    const signed = await rig.sign(small, {
      method: 'PUT',
      path: OBJECT(small.folder, 'big.bin'),
      body,
    });
    // Refused from the declared length, before the body is read: the gateway answers
    // and closes while the client is still sending, so the client sees the 413 or a reset.
    const outcome = await held(rig, signed, body);
    expect(['413', 'reset']).toContain(String(outcome.status));
    expect(rig.lines.join('\n')).toContain('"code":"body-too-large"');
    expect(outcome.maxSpooled).toBe(0);
    expect(rig.upstream.seen.length).toBe(before);
    expect(await rig.spoolFiles()).toEqual([]);
  });

  it('keeps every secret, the authorization header and every object name out of the logs', async () => {
    await rig.s3(tenant, { method: 'GET', path: OBJECT(tenant.folder, 'logged-name.png') });
    const log = rig.lines.join('\n');
    expect(rig.lines.every((line) => JSON.parse(line) !== null)).toBe(true);
    expect(log).toContain('"event":"request"');
    expect(log).toContain('"requestId"');
    for (const hidden of [
      tenant.secret,
      UPSTREAM_SECRET,
      'AWS4-HMAC-SHA256',
      'logged-name.png',
      'photo.png',
      'video.bin',
    ]) {
      expect(log).not.toContain(hidden);
    }
  });

  it('answers the admin interface only to a signed caller', async () => {
    const adminPort = rig.gateway.adminAddress?.port ?? 0;
    expect((await call(adminPort, 'GET', '/credentials/GWABCDEFGHIJKLMNOPQRSTUV', {})).status).toBe(
      401
    );
    expect((await call(adminPort, 'POST', '/credentials?x=1', {}, '{}')).status).toBe(400);
    expect((await call(adminPort, 'POST', '/credentials', {}, 'x'.repeat(20_000))).status).toBe(
      413
    );
  });
});

interface Held {
  readonly status: number | string;
  /** True when the gateway answered before the client had sent the rest of its body. */
  readonly answeredBeforeRest: boolean;
  /** The most spool files seen in the spool directory while the request was open. */
  readonly maxSpooled: number;
  /** True when the gateway told the client to go ahead (`Expect: 100-continue`). */
  readonly continued: boolean;
}

/**
 * Sends a signed request, writes `first`, and holds the rest back for a while,
 * watching the spool directory throughout. Resolves with the answer, or
 * `'none'` when the gateway has not answered in three seconds.
 */
function held(rig: Rig, signed: SignedCall, first: string, rest?: string): Promise<Held> {
  let maxSpooled = 0;
  const poll = setInterval(() => {
    void rig.spoolFiles().then((files) => {
      maxSpooled = Math.max(maxSpooled, files.length);
    });
  }, 10);
  return new Promise<Held>((resolve) => {
    let restSent = false;
    let continued = false;
    const expectsContinue = signed.headers.expect !== undefined;
    const done = (status: number | string): void => {
      clearTimeout(giveUp);
      clearInterval(poll);
      resolve({ status, answeredBeforeRest: !restSent, maxSpooled, continued });
      req.destroy();
    };
    const req = httpRequest({
      host: '127.0.0.1',
      port: rig.port,
      method: signed.method,
      path: signed.target,
      headers: signed.headers,
      agent: false,
    });
    const giveUp = setTimeout(() => done('none'), 3000);
    req.on('error', () => done('reset'));
    req.on('continue', () => {
      continued = true;
      req.write(first);
      if (rest !== undefined) req.end(rest);
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode ?? 0));
    });
    if (expectsContinue) {
      req.flushHeaders();
      return;
    }
    req.write(first);
    if (rest !== undefined) {
      setTimeout(() => {
        restSent = true;
        req.end(rest);
      }, 400);
    }
  });
}

async function emptied(rig: Rig): Promise<string[]> {
  for (let i = 0; i < 50; i += 1) {
    const files = await rig.spoolFiles();
    if (files.length === 0) return files;
    await new Promise((r) => setTimeout(r, 20));
  }
  return rig.spoolFiles();
}

const badSignature = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  authorization:
    headers.authorization?.replace(/Signature=[0-9a-f]{64}$/, `Signature=${'0'.repeat(64)}`) ?? '',
});

describe('nothing is read from a client until its signature has verified', () => {
  const SPOOLING = { STORAGE_GATEWAY_SPOOL_THRESHOLD_BYTES: '1024' };

  it('answers a bad signature 403 without reading the body: no spool file is ever created', async () => {
    const rig = await startRig({ env: SPOOLING });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      // Declares 3 MiB, sends 2 MiB, and never sends the last MiB: a gateway that
      // read first would sit waiting for it, and spool what it had.
      const signed = await rig.sign(
        tenant,
        { method: 'PUT', path: OBJECT(tenant.folder, 'forged.bin'), body: 'f'.repeat(3 * MIB) },
        badSignature
      );
      const outcome = await held(rig, signed, 'f'.repeat(2 * MIB));
      expect(['403', 'reset']).toContain(String(outcome.status));
      expect(rig.lines.join('\n')).toContain('"code":"signature-refused"');
      expect(outcome.answeredBeforeRest).toBe(true);
      expect(outcome.maxSpooled).toBe(0);
      expect(await rig.spoolFiles()).toEqual([]);
      expect(rig.upstream.seen).toEqual([]);
    } finally {
      await rig.stop();
    }
  });

  it('refuses a request signed by an unknown key before reading the body', async () => {
    const rig = await startRig({ env: SPOOLING });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const stranger = { ...tenant, keyId: 'GWNOBODYNOBODYNOBODYNOBOD' };
      const signed = await rig.sign(stranger, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'stranger.bin'),
        body: 's'.repeat(3 * MIB),
      });
      const outcome = await held(rig, signed, 's'.repeat(2 * MIB));
      expect(['403', 'reset']).toContain(String(outcome.status));
      expect(rig.lines.join('\n')).toContain('"code":"signature-refused"');
      expect(outcome.maxSpooled).toBe(0);
      expect(rig.upstream.seen).toEqual([]);
    } finally {
      await rig.stop();
    }
  });

  it('refuses a body whose bytes are not the ones the signature covered, and deletes its spool file', async () => {
    const rig = await startRig({ env: SPOOLING });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const signed = await rig.sign(tenant, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'swapped.bin'),
        body: 'a'.repeat(2 * MIB),
      });
      // Same length, other bytes: it is spooled while it arrives, then refused and removed.
      const outcome = await held(rig, signed, 'b'.repeat(MIB), 'b'.repeat(MIB));
      expect(outcome.status).toBe(403);
      expect(outcome.maxSpooled).toBeGreaterThan(0);
      expect(await emptied(rig)).toEqual([]);
      expect(rig.upstream.seen).toEqual([]);
      expect(rig.lines.join('\n')).toContain('"code":"signature-refused"');
    } finally {
      await rig.stop();
    }
  });

  it('does not tell an Expect: 100-continue client to send its body until the signature has verified', async () => {
    const rig = await startRig({ env: SPOOLING });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const body = 'c'.repeat(MIB);
      const path = OBJECT(tenant.folder, 'continue.bin');
      const spec = { method: 'PUT', path, headers: { expect: '100-continue' }, body };
      const refused = await held(rig, await rig.sign(tenant, spec, badSignature), body);
      expect(refused.status).toBe(403);
      expect(refused.continued).toBe(false);

      const accepted = await held(rig, await rig.sign(tenant, spec), body);
      expect(accepted.continued).toBe(true);
      expect(accepted.status).toBe(200);
      expect(rig.upstream.seen).toHaveLength(1);
    } finally {
      await rig.stop();
    }
  });
});

describe('the body cap', () => {
  it('refuses a body over the configured maximum before reading it, whatever the tenant ceiling', async () => {
    const rig = await startRig({
      env: { STORAGE_GATEWAY_MAX_BODY_MIB: '1', STORAGE_GATEWAY_SPOOL_THRESHOLD_BYTES: '1024' },
    });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const body = 'y'.repeat(2 * MIB);
      const signed = await rig.sign(tenant, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'huge.bin'),
        body,
      });
      // The gateway answers and closes while the client is still sending, so the
      // client sees the 413 or a reset; either way nothing was read or kept.
      const outcome = await held(rig, signed, body);
      expect(['413', 'reset']).toContain(String(outcome.status));
      expect(outcome.maxSpooled).toBe(0);
      expect(rig.lines.join('\n')).toContain('"code":"body-too-large"');
      expect(await rig.spoolFiles()).toEqual([]);
      expect(rig.upstream.seen).toEqual([]);
    } finally {
      await rig.stop();
    }
  });
});

describe('limits on connections and uploads', () => {
  it('starts the server with every timeout and the connection limit set', async () => {
    const rig = await startRig({
      env: {
        STORAGE_GATEWAY_REQUEST_TIMEOUT_MS: '60000',
        STORAGE_GATEWAY_HEADERS_TIMEOUT_MS: '2000',
        STORAGE_GATEWAY_KEEP_ALIVE_TIMEOUT_MS: '3000',
        STORAGE_GATEWAY_MAX_CONNECTIONS: '7',
      },
    });
    try {
      const server = rig.gateway.tenantServer;
      expect(server.requestTimeout).toBe(60_000);
      expect(server.headersTimeout).toBe(2000);
      expect(server.keepAliveTimeout).toBe(3000);
      expect(server.maxConnections).toBe(7);
    } finally {
      await rig.stop();
    }
  });

  it('starts with bounded defaults when nothing is set', async () => {
    const rig = await startRig();
    try {
      const server = rig.gateway.tenantServer;
      expect(server.requestTimeout).toBe(300_000);
      expect(server.headersTimeout).toBe(15_000);
      expect(server.keepAliveTimeout).toBe(5000);
      expect(server.maxConnections).toBe(512);
    } finally {
      await rig.stop();
    }
  });

  it('drops a connection past the connection limit, and takes new ones once room is made', async () => {
    const rig = await startRig({ env: { STORAGE_GATEWAY_MAX_CONNECTIONS: '2' } });
    const open: Socket[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        open.push(
          await new Promise<Socket>((resolve) => {
            const socket = connect(rig.port, '127.0.0.1', () => resolve(socket));
          })
        );
      }
      await new Promise((r) => setTimeout(r, 100));
      await expect(call(rig.port, 'GET', '/healthz', {})).rejects.toThrow();
      for (const socket of open) socket.destroy();
      await new Promise((r) => setTimeout(r, 200));
      expect((await call(rig.port, 'GET', '/healthz', {})).status).toBe(200);
    } finally {
      for (const socket of open) socket.destroy();
      await rig.stop();
    }
  });

  it('answers 503 to an upload past the in-flight limit without reading it, and takes the next once one finishes', async () => {
    const rig = await startRig({ env: { STORAGE_GATEWAY_MAX_CONCURRENT_UPLOADS: '1' } });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const body = 'u'.repeat(2 * MIB);
      const slow = held(
        rig,
        await rig.sign(tenant, {
          method: 'PUT',
          path: OBJECT(tenant.folder, 'first.bin'),
          body,
        }),
        body.slice(0, MIB),
        body.slice(MIB)
      );
      await new Promise((r) => setTimeout(r, 150));
      const second = await rig.s3(tenant, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'second.bin'),
        body: 'x',
      });
      expect(second.status).toBe(503);
      expect(rig.lines.join('\n')).toContain('"code":"upstream-throttled"');
      expect((await slow).status).toBe(200);
      const third = await rig.s3(tenant, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'third.bin'),
        body: 'x',
      });
      expect(third.status).toBe(200);
    } finally {
      await rig.stop();
    }
  });
});

describe('shutdown', () => {
  /** A PUT whose body is sent in two halves, so it is still in flight when the service is told to stop. */
  async function inFlight(rig: Rig, tenant: Minted, finishAfterMs: number | undefined) {
    const body = 'slow-body-bytes';
    const signed = await rig.sign(tenant, {
      method: 'PUT',
      path: OBJECT(tenant.folder, 'slow.bin'),
      body,
    });
    return new Promise<string>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: rig.port,
        method: signed.method,
        path: signed.target,
        headers: signed.headers,
        agent: false,
      });
      req.on('error', () => resolve('cut'));
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(`status ${res.statusCode}`));
      });
      req.write(body.slice(0, 5));
      if (finishAfterMs !== undefined) setTimeout(() => req.end(body.slice(5)), finishAfterMs);
    });
  }

  it('lets an in-flight upload finish within the grace, then refuses new connections', async () => {
    const rig = await startRig({ env: { STORAGE_GATEWAY_SHUTDOWN_GRACE_MS: '5000' } });
    try {
      const tenant = await rig.mint(nextFolder(), 4);
      const answer = inFlight(rig, tenant, 500);
      await new Promise((r) => setTimeout(r, 200));
      const [stopped, status] = await Promise.all([rig.gateway.stop(), answer]);
      expect(status).toBe('status 200');
      expect(stopped.forced).toBe(false);
      await expect(call(rig.port, 'GET', '/healthz', {})).rejects.toThrow();
    } finally {
      await rig.stop();
    }
  });

  it('cuts a stalled upload once the grace has passed, and leaves no spool file', async () => {
    const rig = await startRig({ env: { STORAGE_GATEWAY_SHUTDOWN_GRACE_MS: '300' } });
    try {
      const tenant = await rig.mint(nextFolder(), 4);
      const answer = inFlight(rig, tenant, undefined);
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      const stopped = await rig.gateway.stop();
      expect(stopped.forced).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await answer).toBe('cut');
      expect(await rig.spoolFiles()).toEqual([]);
    } finally {
      await rig.stop();
    }
  });
});
