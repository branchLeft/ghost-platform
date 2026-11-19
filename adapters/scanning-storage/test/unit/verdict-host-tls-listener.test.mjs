import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  hashOf,
  newTempDir,
  signHeaders,
  startRig,
  verdictFor,
} from '../helpers/verdict-host-rig.mjs';
import { pinOfPeerCertificate, tlsRequest } from '../helpers/verdict-host-tls-client.mjs';

const require = createRequire(import.meta.url);
const { startInbound } = require('../../verdict-host/inbound.js');
const { ensureTlsIdentity } = require('../../verdict-host/tls-identity.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const closed = (socket) => new Promise((resolve) => socket.once('close', resolve));

let rig;
let inbound;
let directory;
const sockets = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tls-listener-'));
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await inbound?.close();
  inbound = undefined;
  await rig?.cleanup();
  rig = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function startTlsRig(config = {}) {
  const rigDirectory = newTempDir();
  rig = await startRig({
    directory: rigDirectory,
    config: {
      tlsCertFile: path.join(rigDirectory, 'tls.crt'),
      tlsKeyFile: path.join(rigDirectory, 'tls.key'),
      ...config,
    },
  });
  rig.port = rig.host.inbound.address.port;
  rig.signed = (method, url, body = '') =>
    signHeaders(rig.keys.privateKey, method, url, body, { now: rig.clock.now() });
  return rig;
}

describe('the host end serving TLS', () => {
  it('answers a signed poll over TLS 1.3 and reports the pin of the certificate it shows', async () => {
    await startTlsRig();
    const answer = await tlsRequest({
      port: rig.port,
      path: '/safety/v1/pending',
      headers: rig.signed('GET', '/safety/v1/pending'),
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ v: 1, hashes: [] });
    expect(answer.protocol).toBe('TLSv1.3');
    expect(rig.host.tlsPin).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.pin).toBe(rig.host.tlsPin);
  });

  it('takes a verdict over TLS: the whole round', async () => {
    await startTlsRig({ holdMs: 1000 });
    rig.host.queue.ask(hashOf(1));
    const poll = await tlsRequest({
      port: rig.port,
      path: '/safety/v1/pending',
      headers: rig.signed('GET', '/safety/v1/pending'),
    });
    const { batch, hashes } = JSON.parse(poll.text);
    expect(hashes).toEqual([hashOf(1)]);
    const body = JSON.stringify({ v: 1, batch, verdicts: [verdictFor(hashOf(1))] });
    const post = await tlsRequest({
      port: rig.port,
      path: '/safety/v1/verdicts',
      method: 'POST',
      body,
      headers: {
        ...rig.signed('POST', '/safety/v1/verdicts', body),
        'content-length': String(body.length),
      },
    });
    expect(post.status).toBe(204);
    expect(rig.host.queue.counts()).toMatchObject({ queued: 0, leased: 0, verdicts: 1 });
  });

  it('refuses an unsigned request over TLS exactly as it does over plain HTTP', async () => {
    await startTlsRig();
    const answer = await tlsRequest({ port: rig.port, path: '/safety/v1/pending' });
    expect(answer.status).toBe(401);
    expect(answer.text).toBe('');
  });

  it('keeps the same pin across a restart over the same files, and a different one for a new host', async () => {
    await startTlsRig();
    const first = rig.host.tlsPin;
    const { directory: rigDirectory, config } = rig;
    await rig.stop();
    const again = await startRig({ directory: rigDirectory, config });
    try {
      expect(again.host.tlsPin).toBe(first);
    } finally {
      await again.stop();
    }
    const other = await startTlsRig();
    expect(other.host.tlsPin).not.toBe(first);
  });

  it('has no pin, and plain HTTP, when TLS is not configured', async () => {
    rig = await startRig();
    expect(rig.host.tlsPin).toBeUndefined();
    expect((await rig.call('GET', '/safety/v1/pending')).status).toBe(200);
  });

  it('does not answer a plain-HTTP request on the TLS port, and carries on', async () => {
    await startTlsRig();
    const refused = await new Promise((resolve) => {
      const req = http.get({
        host: '127.0.0.1',
        port: rig.port,
        path: '/safety/v1/pending',
        agent: false,
      });
      req.on('response', () => resolve('answered'));
      req.on('error', (err) => resolve(err.code ?? err.message));
    });
    expect(refused).not.toBe('answered');
    await wait(50);
    expect(rig.lines.join('\n')).toContain('VERDICT_HOST_TLS_HANDSHAKE_FAILED');
    const answer = await tlsRequest({
      port: rig.port,
      path: '/safety/v1/pending',
      headers: rig.signed('GET', '/safety/v1/pending'),
    });
    expect(answer.status).toBe(200);
  });

  it('refuses a client that offers TLS 1.2 at most', async () => {
    await startTlsRig();
    await expect(
      tlsRequest({
        port: rig.port,
        path: '/safety/v1/pending',
        headers: rig.signed('GET', '/safety/v1/pending'),
        tlsOptions: { maxVersion: 'TLSv1.2' },
      })
    ).rejects.toThrow(/protocol version/i);
    expect(rig.lines.join('\n')).toContain('VERDICT_HOST_TLS_HANDSHAKE_FAILED');
  });

  it('survives a client that starts a handshake and walks away, or resets', async () => {
    await startTlsRig();
    const partial = net.connect(rig.port, '127.0.0.1');
    sockets.push(partial);
    await new Promise((resolve) => partial.once('connect', resolve));
    partial.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x30, 0x01]));
    partial.destroy();
    const reset = net.connect(rig.port, '127.0.0.1');
    sockets.push(reset);
    await new Promise((resolve) => reset.once('connect', resolve));
    reset.write(Buffer.from([0x16, 0x03, 0x01]));
    reset.resetAndDestroy();
    const silent = net.connect(rig.port, '127.0.0.1');
    sockets.push(silent);
    await new Promise((resolve) => silent.once('connect', resolve));
    silent.destroy();
    await wait(100);
    const answer = await tlsRequest({
      port: rig.port,
      path: '/safety/v1/pending',
      headers: rig.signed('GET', '/safety/v1/pending'),
    });
    expect(answer.status).toBe(200);
  });

  it('serves the pin a client computes itself from the peer certificate, on a raw TLS socket too', async () => {
    await startTlsRig();
    const tls = await import('node:tls');
    const socket = tls.connect({ port: rig.port, host: '127.0.0.1', rejectUnauthorized: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    expect(pinOfPeerCertificate(socket)).toBe(rig.host.tlsPin);
  });
});

describe('the listener on its own', () => {
  const idleQueue = () =>
    Object.assign(new EventEmitter(), {
      lease: () => null,
      batchHashes: () => null,
      settle: () => false,
    });

  async function startOwn(options = {}) {
    const { certificatePem, privateKeyPem } = ensureTlsIdentity({
      certFile: path.join(directory, 'tls.crt'),
      keyFile: path.join(directory, 'tls.key'),
    });
    const lines = [];
    inbound = await startInbound({
      queue: idleQueue(),
      authenticate: () => ({ ok: true }),
      host: '127.0.0.1',
      port: 0,
      holdMs: 50,
      logger: { error: (line) => lines.push(line) },
      tls: { cert: certificatePem, key: privateKeyPem },
      ...options,
    });
    return { port: inbound.address.port, lines };
  }

  async function secureSocket(port) {
    const tls = await import('node:tls');
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
    sockets.push(socket);
    socket.on('error', () => {});
    socket.resume();
    await new Promise((resolve) => socket.once('secureConnect', resolve));
    return socket;
  }

  it('drops a connection that never finishes its handshake', async () => {
    const { port } = await startOwn({ requestTimeoutMs: 300 });
    const idle = net.connect(port, '127.0.0.1');
    sockets.push(idle);
    idle.on('error', () => {});
    const started = Date.now();
    await closed(idle);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('drops a secured connection that starts a request and never finishes its headers', async () => {
    const { port } = await startOwn({ requestTimeoutMs: 300, connectionsCheckIntervalMs: 100 });
    const socket = await secureSocket(port);
    socket.write('GET /safety/v1/pending HTTP/1.1\r\nhost: x\r\n');
    const started = Date.now();
    await closed(socket);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('holds at most maxConnections connections, handshake or not', async () => {
    const { port } = await startOwn({ maxConnections: 2 });
    const first = await secureSocket(port);
    const second = await secureSocket(port);
    const third = net.connect(port, '127.0.0.1');
    sockets.push(third);
    third.on('error', () => {});
    await closed(third);
    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(false);
  });

  it('closes every connection, secured or still in the handshake, and stops listening', async () => {
    const { port } = await startOwn();
    const secured = await secureSocket(port);
    const midHandshake = net.connect(port, '127.0.0.1');
    sockets.push(midHandshake);
    midHandshake.on('error', () => {});
    await new Promise((resolve) => midHandshake.once('connect', resolve));
    const both = Promise.all([closed(secured), closed(midHandshake)]);
    await Promise.race([
      inbound.close(),
      wait(3000).then(() => Promise.reject(new Error('close hung'))),
    ]);
    inbound = undefined;
    await both;
    const refused = await new Promise((resolve) => {
      const probe = net.connect(port, '127.0.0.1');
      probe.on('error', (err) => resolve(err.code));
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  it('does not log a request body, a header or the key when a handshake fails', async () => {
    const { port, lines } = await startOwn();
    const junk = net.connect(port, '127.0.0.1');
    sockets.push(junk);
    junk.on('error', () => {});
    junk.write('GET /safety/v1/pending HTTP/1.1\r\nx-broker-signature: SECRET\r\n\r\n');
    await closed(junk);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines.join('\n')).toMatch(/VERDICT_HOST_TLS_HANDSHAKE_FAILED error=\S+$/);
  });
});
