import { appendFileSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';

/**
 * A stand-in for the tenant's object-storage media address, for the bundler's
 * real-Ghost proof (scripts/test-export-bundler.sh). The bundler probes each
 * referenced media object with a HEAD against the public address; this answers
 * that probe from a fixed table, so a proof run holds no real storage.
 *
 * `answer500` is the sabotage switch: a key listed there answers 500, which
 * the bundler cannot tell from an outage, so it reports that object as
 * unchecked and the media extension as partial. A proof that stays green with
 * the switch on is not proving the media extension.
 */

export interface FakeMediaStorageOptions {
  /** The tenant's path under the host, e.g. `/media-proof`; no trailing slash. */
  readonly prefix: string;
  /** Object key (below the prefix) to size in bytes: the objects that exist. */
  readonly objects: Readonly<Record<string, number>>;
  /** Object keys that answer 500, whether or not they exist. */
  readonly answer500: readonly string[];
  /** Called with one line per request: `METHOD /path STATUS`. */
  readonly onRequest?: (line: string) => void;
}

export function createFakeMediaStorageHandler(options: FakeMediaStorageOptions): RequestListener {
  const prefix = `${options.prefix}/`;
  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const answer = (status: number, headers: Record<string, string> = {}): void => {
      options.onRequest?.(`${method} ${path} ${String(status)}`);
      res.writeHead(status, headers);
      res.end();
    };
    if (method !== 'HEAD' && method !== 'GET') {
      answer(405);
      return;
    }
    if (!path.startsWith(prefix)) {
      answer(404);
      return;
    }
    const key = path
      .slice(prefix.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    if (options.answer500.includes(key)) {
      answer(500);
      return;
    }
    const bytes = Object.hasOwn(options.objects, key) ? options.objects[key] : undefined;
    if (bytes === undefined) {
      answer(404);
      return;
    }
    // The bundler only ever sends HEAD; a GET gets the headers and no body.
    answer(200, { 'content-length': String(bytes), 'content-type': 'application/octet-stream' });
  };
}

interface Cli {
  readonly port: number;
  readonly prefix: string;
  readonly objects: Record<string, number>;
  readonly answer500: string[];
  readonly cert: string | undefined;
  readonly key: string | undefined;
  readonly requestLog: string | undefined;
}

function parseCli(argv: readonly string[]): Cli {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string' },
      prefix: { type: 'string' },
      object: { type: 'string', multiple: true },
      'answer-500': { type: 'string', multiple: true },
      cert: { type: 'string' },
      key: { type: 'string' },
      'request-log': { type: 'string' },
    },
  });
  const objects: Record<string, number> = {};
  for (const spec of values.object ?? []) {
    const [name, size] = spec.split('=');
    if (name === undefined || name === '' || size === undefined || !/^\d+$/.test(size)) {
      throw new Error(`--object takes KEY=BYTES, got ${JSON.stringify(spec)}`);
    }
    objects[name] = Number(size);
  }
  const prefix = (values.prefix ?? '').replace(/\/+$/, '');
  if (prefix === '' || !prefix.startsWith('/'))
    throw new Error('--prefix must be a path like /name');
  if ((values.cert === undefined) !== (values.key === undefined)) {
    throw new Error('--cert and --key go together');
  }
  return {
    port: Number(values.port ?? '0'),
    prefix,
    objects,
    answer500: values['answer-500'] ?? [],
    cert: values.cert,
    key: values.key,
    requestLog: values['request-log'],
  };
}

/**
 * Entry point for the proof script: serves until killed, over https when
 * given a certificate, and prints `listening <port>` once it is ready.
 */
function main(argv: readonly string[]): void {
  const cli = parseCli(argv);
  const handler = createFakeMediaStorageHandler({
    prefix: cli.prefix,
    objects: cli.objects,
    answer500: cli.answer500,
    onRequest: (line) => {
      if (cli.requestLog !== undefined) appendFileSync(cli.requestLog, `${line}\n`);
    },
  });
  const server =
    cli.cert !== undefined && cli.key !== undefined
      ? createHttpsServer({ cert: readFileSync(cli.cert), key: readFileSync(cli.key) }, handler)
      : createHttpServer(handler);
  server.listen(cli.port, '127.0.0.1', () => {
    console.log(`listening ${String((server.address() as AddressInfo).port)}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (import.meta.main) main(process.argv.slice(2));
