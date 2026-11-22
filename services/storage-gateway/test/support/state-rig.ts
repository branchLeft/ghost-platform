import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type GatewayConfig } from '../../src/config.js';
import { ADMIN_HEADERS, adminSigningPayload } from '../../src/credentials/adminAuth.js';
import { MASTER_SECRET_FILE_ENV } from '../../src/credentials/masterSecret.js';
import { startStateGateway } from '../../src/start-state.js';
import type { RunningGateway } from '../../src/start.js';
import {
  REGION,
  UPSTREAM_KEY_ID,
  UPSTREAM_SECRET,
  call,
  type FakeUpstream,
  type HttpResult,
  type Minted,
  type Seen,
  type SignedCall,
} from './gateway-rig.js';
import { referenceSign, sha256Hex, type SignSpec } from './reference-signer.js';

export const STATE_BUCKET = 'state-shard-a';

const LIST_XML =
  '<?xml version="1.0"?><ListBucketResult><Name>state-shard-a</Name><KeyCount>0</KeyCount></ListBucketResult>';
const COPY_XML = '<?xml version="1.0"?><CopyObjectResult><ETag>"abc"</ETag></CopyObjectResult>';

/** The state shard as far as the process can tell: it answers the state shapes and records what it received. */
export async function startStateFakeUpstream(
  behave: (req: {
    method: string;
    url: string;
  }) => { status: number; body: string } | undefined = () => undefined
): Promise<FakeUpstream> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const hash = createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? '';
      seen.push({ method, url, headers: req.headers, bytes, sha256: hash.digest('hex') });
      const scripted = behave({ method, url });
      if (scripted !== undefined) {
        res.writeHead(scripted.status, { 'content-type': 'application/xml' });
        res.end(scripted.body);
      } else if (method === 'GET' && url.includes('list-type=2')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(LIST_XML);
      } else if (method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('STATE_BYTES');
      } else if (method === 'HEAD') {
        res.writeHead(200, { 'content-length': '11', etag: '"abc"' });
        res.end();
      } else if (method === 'DELETE') {
        res.writeHead(204);
        res.end();
      } else if (method === 'PUT' && req.headers['x-amz-copy-source'] !== undefined) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(COPY_XML);
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

type S3Spec = Omit<SignSpec, 'headers' | 'payloadHash'> & {
  readonly headers?: Record<string, string>;
  /** The payload marker to sign, where it is not the body's own digest. */
  readonly payloadHash?: string;
};

export interface StateRig {
  readonly gateway: RunningGateway;
  readonly config: GatewayConfig;
  readonly env: Record<string, string>;
  readonly upstream: FakeUpstream;
  readonly lines: string[];
  readonly port: number;
  /** The refusal codes the process logged, in order. */
  refusals(): string[];
  mint(folder: string): Promise<Minted>;
  sign(tenant: Minted, spec: S3Spec): Promise<SignedCall>;
  s3(tenant: Minted, spec: S3Spec): Promise<HttpResult>;
  stop(): Promise<void>;
}

export interface StateRigOptions {
  readonly env?: Record<string, string>;
  readonly behave?: Parameters<typeof startStateFakeUpstream>[0];
}

let counter = 0;
export const nextPrefix = (): string => `statepref${String(++counter).padStart(10, '0')}`;

/** A whole state process: real config, real files, real store, a fake shard, ephemeral ports. */
export async function startStateRig(options: StateRigOptions = {}): Promise<StateRig> {
  const dir = await mkdtemp(join(tmpdir(), 'gw-state-rig-'));
  const anchorDir = await mkdtemp(join(tmpdir(), 'gw-state-rig-anchor-'));
  const spoolDir = await mkdtemp(join(tmpdir(), 'gw-state-rig-spool-'));
  const upstream = await startStateFakeUpstream(options.behave);

  const write = async (name: string, text: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, text, { mode: 0o600 });
    return path;
  };
  const masterFile = await write('state-master', randomBytes(32).toString('base64'));
  const keyIdFile = await write('upstream-key-id', `${UPSTREAM_KEY_ID}\n`);
  const secretFile = await write('upstream-secret', `${UPSTREAM_SECRET}\n`);

  const controller = generateKeyPairSync('ed25519');
  const raw = controller.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
  const erasure = generateKeyPairSync('ed25519');
  const keysText = JSON.stringify({
    'provisioning-controller': raw,
    'erasure-job': erasure.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
  });
  const keysFile = await write('admin-keys.json', keysText);
  await write('admin-keys.json.sha256', createHash('sha256').update(keysText).digest('hex'));
  await mkdir(join(dir, 'store'));

  const env: Record<string, string> = {
    [MASTER_SECRET_FILE_ENV]: masterFile,
    STORAGE_GATEWAY_PROFILE: 'state',
    STORAGE_GATEWAY_STATE_BUCKET: STATE_BUCKET,
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
  const gateway = await startStateGateway(config, {
    env,
    sink: (line) => lines.push(line),
    trustedUid: process.getuid?.() ?? 0,
    adminClock: () => startMs + clockOffsetMs,
  });
  const port = gateway.address.port;
  const adminPort = (gateway.adminAddress as AddressInfo).port;
  let nonce = 0;

  async function mint(folder: string): Promise<Minted> {
    // The admin interface refuses a request stamped before the process started.
    clockOffsetMs = 10_000;
    const body = Buffer.from(JSON.stringify({ folder }));
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

  async function sign(tenant: Minted, spec: S3Spec): Promise<SignedCall> {
    const body = spec.body ?? '';
    const signed = await referenceSign(
      {
        ...spec,
        headers: {
          host: `127.0.0.1:${port}`,
          'content-length': String(Buffer.byteLength(body)),
          ...spec.headers,
        },
        payloadHash: spec.payloadHash ?? sha256Hex(body),
      },
      { keyId: tenant.keyId, secret: tenant.secret, region: REGION, signingDate: new Date() }
    );
    return {
      method: spec.method,
      target: signed.request.rawTarget,
      headers: { ...signed.headers },
      body,
    };
  }

  async function s3(tenant: Minted, spec: S3Spec): Promise<HttpResult> {
    const signed = await sign(tenant, spec);
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
    port,
    refusals: () =>
      lines
        .map((l) => JSON.parse(l) as { event: string; code?: string })
        .filter((l) => l.event === 'request-refused')
        .map((l) => l.code ?? ''),
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
