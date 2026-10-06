import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

export const SITE_URL = 'https://tenant.example.test';
export const LABEL = 'branchleft.agent=export-reimport-image-test';
const BOOT_TIMEOUT_MS = 120_000;

export function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One real Ghost container on its own throwaway SQLite database, reached the
 * way the edge would reach it: the tenant's own host name and https.
 */
export class GhostContainer {
  static async start() {
    const port = await freePort();
    const name = `export-reimport-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const env = {
      url: SITE_URL,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'Direct',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      storage__images__adapter: 'ScanningStorageAdapter',
      storage__images__wraps: 'LocalImagesStorage',
      storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__media__adapter: 'ScanningStorageAdapter',
      storage__media__wraps: 'LocalMediaStorage',
      storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__files__adapter: 'ScanningStorageAdapter',
      storage__files__wraps: 'LocalFilesStorage',
      storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const image = process.env.IMAGE;
    if (!image)
      throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
    docker(
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      image
    );
    const container = new GhostContainer(name, port);
    docker('start', name);
    if (!(await container.waitForHome())) {
      const logs = container.logs();
      container.remove();
      throw new Error(`Ghost did not boot: ${logs}`);
    }
    return container;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
  }

  async waitForHome() {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if ((await this.request('GET', '/')).status === 200) return true;
      } catch {
        // not listening yet
      }
      if (docker('inspect', '-f', '{{.State.Running}}', this.name).trim() !== 'true') return false;
      await sleep(500);
    }
    return false;
  }

  logs() {
    try {
      return docker('logs', '--tail', '40', this.name);
    } catch {
      return '';
    }
  }

  /** A raw request; `body` is a Buffer/string sent as is, or an object sent as JSON. */
  request(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const isJson = body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string';
      const payload = isJson ? JSON.stringify(body) : body;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          headers: {
            ...(isJson ? { 'content-type': 'application/json' } : {}),
            host: new URL(SITE_URL).host,
            origin: SITE_URL,
            'x-forwarded-proto': 'https',
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks),
              get text() {
                return this.body.toString('utf8');
              },
              headers: res.headers,
            })
          );
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  remove() {
    try {
      docker('rm', '-f', '-v', this.name);
    } catch {
      // already gone
    }
  }
}
