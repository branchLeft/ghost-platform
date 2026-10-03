import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { clearStaleSocket, listenOnUnixSocket } from '../../src/unixSocket.js';

let dir: string;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

function app(drained: boolean, ghostHealthy: boolean) {
  return createApp(
    { isSet: () => drained },
    { isHealthy: async () => ghostHealthy },
    { getVersion: async () => null },
    null
  );
}

function get(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('listenOnUnixSocket', () => {
  it('answers /healthz over the socket', async () => {
    const path = join(dir, 'health.sock');
    servers.push(await listenOnUnixSocket(app(false, true), path));
    expect(await get(path, '/healthz')).toBe(200);
  });

  it('answers 503 over the socket when drained', async () => {
    const path = join(dir, 'health.sock');
    servers.push(await listenOnUnixSocket(app(true, true), path));
    expect(await get(path, '/healthz')).toBe(503);
  });

  it('creates the socket 0600 and restores the process umask', async () => {
    const before = process.umask(0o022);
    process.umask(before);
    const path = join(dir, 'health.sock');
    servers.push(await listenOnUnixSocket(app(false, true), path));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const after = process.umask(0o022);
    process.umask(after);
    expect(after).toBe(before);
  });

  it('replaces a socket already at the path', async () => {
    const path = join(dir, 'health.sock');
    const stale = createNetServer();
    await new Promise<void>((resolve) => stale.listen(path, resolve));
    stale.unref();
    expect(existsSync(path)).toBe(true);
    servers.push(await listenOnUnixSocket(app(false, true), path));
    expect(await get(path, '/healthz')).toBe(200);
    stale.close();
  });

  it('removes the socket when the server closes', async () => {
    const path = join(dir, 'health.sock');
    const server = await listenOnUnixSocket(app(false, true), path);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(existsSync(path)).toBe(false);
  });

  it('opens no TCP listener', async () => {
    const path = join(dir, 'health.sock');
    const server = await listenOnUnixSocket(app(false, true), path);
    servers.push(server);
    expect(typeof server.address()).toBe('string');
  });

  it('rejects when the directory does not exist', async () => {
    await expect(
      listenOnUnixSocket(app(false, true), join(dir, 'missing', 'h.sock'))
    ).rejects.toThrow();
  });
});

describe('clearStaleSocket', () => {
  it('does nothing when the path is absent', () => {
    expect(() => clearStaleSocket(join(dir, 'none'))).not.toThrow();
  });

  it('refuses to remove a regular file', () => {
    const path = join(dir, 'file');
    writeFileSync(path, 'x');
    expect(() => clearStaleSocket(path)).toThrow(/not a socket/);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses to remove a directory', () => {
    const path = join(dir, 'sub');
    mkdirSync(path);
    expect(() => clearStaleSocket(path)).toThrow(/not a socket/);
    expect(existsSync(path)).toBe(true);
  });
});
