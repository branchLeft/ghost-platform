import { request as httpRequest } from 'node:http';
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
    expect(seen[0]?.url).toBe(OBJECT(tenant.folder, 'photo.png').replace(/^/, ''));
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
    const answer = await rig.s3(small, {
      method: 'PUT',
      path: OBJECT(small.folder, 'big.bin'),
      body: 'z'.repeat(2 * MIB),
    });
    expect(answer.status).toBe(413);
    expect(answer.text).toContain('<Code>EntityTooLarge</Code>');
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

describe('a pre-authentication body cap', () => {
  it('refuses an oversized body from a client that is not yet authenticated, leaving no spool file', async () => {
    const rig = await startRig({ env: { STORAGE_GATEWAY_MAX_BODY_MIB: '1' } });
    try {
      const folder = nextFolder();
      // The gateway answers before the client has finished sending and closes the
      // connection, so a client may see the 413 or a reset; either way nothing is kept.
      const outcome = await new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: rig.port,
            method: 'PUT',
            path: OBJECT(folder, 'huge.bin'),
            agent: false,
            headers: {
              host: `127.0.0.1:${rig.port}`,
              authorization: `AWS4-HMAC-SHA256 Credential=NOBODY/20260101/nbg1/s3/aws4_request, SignedHeaders=host, Signature=${'0'.repeat(64)}`,
              'content-length': String(2 * MIB),
            },
          },
          (res) => resolve(`status ${res.statusCode}`)
        );
        req.on('error', () => resolve('reset'));
        req.end('y'.repeat(2 * MIB));
      });
      expect(['status 413', 'reset']).toContain(outcome);
      await new Promise((r) => setTimeout(r, 100));
      expect(rig.lines.join('\n')).toContain('"code":"body-too-large"');
      expect(await rig.spoolFiles()).toEqual([]);
      expect(rig.upstream.seen).toEqual([]);
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
