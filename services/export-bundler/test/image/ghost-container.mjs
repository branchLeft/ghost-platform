import crypto from 'node:crypto';
import http from 'node:http';
import {
  docker,
  pollHttp200,
  reservePort,
  runStep,
} from '../../../../test-support/image-harness.mjs';

export { docker };

export const SITE_URL = 'https://tenant.example.test';
export const LABEL = 'branchleft.agent=export-reimport-image-test';
const BOOT_TIMEOUT_MS = 120_000;

/**
 * One real Ghost container on its own throwaway SQLite database, reached the
 * way the edge would reach it: the tenant's own host name and https.
 */
export class GhostContainer {
  static start() {
    return runStep('start Ghost container', () => GhostContainer.#start(), {
      deadlineMs: BOOT_TIMEOUT_MS + 60_000,
    });
  }

  static async #start() {
    const port = await reservePort();
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
    const booted = await container.waitForHome();
    if (!booted.ok) {
      const logs = container.logs();
      container.remove();
      throw new Error(`Ghost did not boot (${booted.detail}): ${logs}`);
    }
    return container;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
  }

  // Through the tenant's own host name, so it goes by request(), not a bare fetch.
  waitForHome() {
    return pollHttp200(`http://127.0.0.1:${this.port}/`, {
      containerName: this.name,
      deadlineMs: BOOT_TIMEOUT_MS,
      probe: (signal) => this.request('GET', '/', undefined, {}, signal).then((res) => res.status),
    });
  }

  logs() {
    try {
      return docker('logs', '--tail', '40', this.name);
    } catch {
      return '';
    }
  }

  /** A raw request; `body` is a Buffer/string sent as is, or an object sent as JSON. */
  request(method, path, body, headers = {}, signal) {
    return new Promise((resolve, reject) => {
      const isJson = body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string';
      const payload = isJson ? JSON.stringify(body) : body;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          signal,
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
