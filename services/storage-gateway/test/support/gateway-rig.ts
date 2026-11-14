import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type GatewayConfig } from '../../src/config.js';
import { ADMIN_HEADERS, adminSigningPayload } from '../../src/credentials/adminAuth.js';
import { MASTER_SECRET_FILE_ENV } from '../../src/credentials/masterSecret.js';
import { startGateway, type RunningGateway } from '../../src/start.js';
import { referenceSign, sha256Hex, type SignSpec } from './reference-signer.js';

export const REGION = 'nbg1';
export const BUCKET = 'media-shard-a';
export const UPSTREAM_KEY_ID = 'REALHETZNERKEYID01';
export const UPSTREAM_SECRET = 'REAL_UPSTREAM_SECRET_MUST_NEVER_APPEAR';
export const MIB = 1024 * 1024;

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FakeUpstream {
  readonly origin: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

const COMPLETE_XML =
  '<?xml version="1.0"?><CompleteMultipartUploadResult><Location>x</Location></CompleteMultipartUploadResult>';

/** The storage service as far as the gateway can tell: it answers the seven shapes and records what it received. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  let uploads = 0;
  const server: Server = createServer((req, res) => {
    const hash = createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        url,
        headers: req.headers,
        bytes,
        sha256: hash.digest('hex'),
      });
      if (req.method === 'POST' && url.includes('?uploads')) {
        uploads += 1;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>UP-${uploads}</UploadId></InitiateMultipartUploadResult>`
        );
      } else if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(COMPLETE_XML);
      } else if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('OBJECT_BYTES');
      } else if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '12', etag: '"abc"' });
        res.end();
      } else if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { etag: '"abc"' });
        res.end();
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
}

/** One HTTP request to the gateway, sent exactly as given. */
export function call(
  port: number,
  method: string,
  target: string,
  headers: Readonly<Record<string, string>>,
  body?: string | Buffer
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path: target, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

export interface Minted {
  readonly keyId: string;
  readonly secret: string;
  readonly folder: string;
}

export interface SignedCall {
  readonly method: string;
  readonly target: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type S3Spec = Omit<SignSpec, 'headers' | 'payloadHash'> & {
  readonly headers?: Record<string, string>;
};

export interface Rig {
  readonly gateway: RunningGateway;
  readonly config: GatewayConfig;
  readonly env: Record<string, string>;
  readonly upstream: FakeUpstream;
  readonly lines: string[];
  readonly spoolDir: string;
  readonly port: number;
  spoolFiles(): Promise<string[]>;
  mint(folder: string, uploadCeilingMib: number): Promise<Minted>;
  /** Signs with the reference signer; `tamper` may alter the signed headers. Sends nothing. */
  sign(
    tenant: Minted,
    spec: S3Spec,
    tamper?: (headers: Record<string, string>) => Record<string, string>
  ): Promise<SignedCall>;
  /** `sign`, then sends. */
  s3(
    tenant: Minted,
    spec: S3Spec,
    tamper?: (headers: Record<string, string>) => Record<string, string>
  ): Promise<HttpResult>;
  stop(): Promise<void>;
}

export interface RigOptions {
  readonly env?: Record<string, string>;
}

let folderCounter = 0;
export const nextFolder = (): string => `tenantfolder${String(++folderCounter).padStart(8, '0')}`;

/** A whole service: real config, real files, real store, a fake storage service, ephemeral ports. */
export async function startRig(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'gw-rig-'));
  const anchorDir = await mkdtemp(join(tmpdir(), 'gw-rig-anchor-'));
  const spoolDir = await mkdtemp(join(tmpdir(), 'gw-rig-spool-'));
  const upstream = await startFakeUpstream();

  const write = async (name: string, text: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, text, { mode: 0o600 });
    return path;
  };
  const masterFile = await write('master', randomBytes(32).toString('base64'));
  const keyIdFile = await write('upstream-key-id', `${UPSTREAM_KEY_ID}\n`);
  const secretFile = await write('upstream-secret', `${UPSTREAM_SECRET}\n`);

  const controller = generateKeyPairSync('ed25519');
  const erasure = generateKeyPairSync('ed25519');
  const raw = (key: KeyObject): string =>
    key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const keysText = JSON.stringify({
    'provisioning-controller': raw(controller.publicKey),
    'erasure-job': raw(erasure.publicKey),
  });
  const keysFile = await write('admin-keys.json', keysText);
  await write('admin-keys.json.sha256', createHash('sha256').update(keysText).digest('hex'));
  await mkdir(join(dir, 'store'));

  const env: Record<string, string> = {
    [MASTER_SECRET_FILE_ENV]: masterFile,
    STORAGE_GATEWAY_REGION: REGION,
    STORAGE_GATEWAY_LISTEN_HOST: '127.0.0.1',
    STORAGE_GATEWAY_LISTEN_PORT: '0',
    STORAGE_GATEWAY_UPSTREAM_ENDPOINT: upstream.origin,
    STORAGE_GATEWAY_UPSTREAM_KEY_ID_FILE: keyIdFile,
    STORAGE_GATEWAY_UPSTREAM_SECRET_FILE: secretFile,
    STORAGE_GATEWAY_UPSTREAM_DEADLINE_MS: '10000',
    STORAGE_GATEWAY_STORE_PATH: join(dir, 'store', 'credentials.sqlite'),
    STORAGE_GATEWAY_STORE_ANCHOR_PATH: join(anchorDir, 'generation'),
    STORAGE_GATEWAY_SPOOL_DIR: spoolDir,
    STORAGE_GATEWAY_ADMIN_KEYS_FILE: keysFile,
    STORAGE_GATEWAY_ADMIN_LISTEN_PORT: '0',
    STORAGE_GATEWAY_SHUTDOWN_GRACE_MS: '5000',
    ...options.env,
  };
  const config = loadConfig(env);

  const lines: string[] = [];
  const startMs = Date.now();
  let clockOffsetMs = 0;
  const gateway = await startGateway(config, {
    env,
    sink: (line) => lines.push(line),
    trustedUid: process.getuid?.() ?? 0,
    adminClock: () => startMs + clockOffsetMs,
  });
  const port = gateway.address.port;
  const adminPort = (gateway.adminAddress as AddressInfo).port;
  let nonce = 0;

  async function mint(folder: string, uploadCeilingMib: number): Promise<Minted> {
    // The admin interface refuses a request stamped before the process started.
    clockOffsetMs = 10_000;
    const body = Buffer.from(JSON.stringify({ folder, bucket: BUCKET, uploadCeilingMib }));
    const timestamp = String(Math.floor((startMs + clockOffsetMs) / 1000));
    const id = `nonce-${String(++nonce).padStart(12, '0')}`;
    const payload = adminSigningPayload(
      'provisioning-controller',
      'POST',
      '/credentials',
      timestamp,
      id,
      body
    );
    const result = await call(
      adminPort,
      'POST',
      '/credentials',
      {
        [ADMIN_HEADERS.caller]: 'provisioning-controller',
        [ADMIN_HEADERS.timestamp]: timestamp,
        [ADMIN_HEADERS.nonce]: id,
        [ADMIN_HEADERS.signature]: cryptoSign(null, payload, controller.privateKey).toString(
          'base64'
        ),
        'content-length': String(body.length),
      },
      body
    );
    if (result.status !== 201) throw new Error(`mint answered ${result.status}`);
    const minted = JSON.parse(result.text) as { keyId: string; secret: string };
    return { keyId: minted.keyId, secret: minted.secret, folder };
  }

  async function sign(
    tenant: Minted,
    spec: Omit<SignSpec, 'headers' | 'payloadHash'> & { readonly headers?: Record<string, string> },
    tamper: (headers: Record<string, string>) => Record<string, string> = (h) => h
  ): Promise<SignedCall> {
    const body = spec.body ?? '';
    const signed = await referenceSign(
      {
        ...spec,
        headers: {
          host: `127.0.0.1:${port}`,
          'content-length': String(Buffer.byteLength(body)),
          ...spec.headers,
        },
        payloadHash: sha256Hex(body),
      },
      { keyId: tenant.keyId, secret: tenant.secret, region: REGION, signingDate: new Date() }
    );
    return {
      method: spec.method,
      target: signed.request.rawTarget,
      headers: tamper({ ...signed.headers }),
      body,
    };
  }

  async function s3(
    tenant: Minted,
    spec: Omit<SignSpec, 'headers' | 'payloadHash'> & { readonly headers?: Record<string, string> },
    tamper?: (headers: Record<string, string>) => Record<string, string>
  ): Promise<HttpResult> {
    const signed = await sign(tenant, spec, tamper);
    return call(
      port,
      signed.method,
      signed.target,
      signed.headers,
      signed.body === '' ? undefined : signed.body
    );
  }

  return {
    gateway,
    config,
    env,
    upstream,
    lines,
    spoolDir,
    port,
    spoolFiles: () => readdir(spoolDir),
    mint,
    sign,
    s3,
    async stop() {
      await gateway.stop();
      await upstream.close();
      await Promise.all(
        [dir, anchorDir, spoolDir].map((d) => rm(d, { recursive: true, force: true }))
      );
    },
  };
}
