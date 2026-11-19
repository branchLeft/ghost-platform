import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FakeUpstream, Seen } from './gateway-rig.js';

interface Stored {
  readonly body: Buffer;
  readonly modified: Date;
}

export interface MemoryShard extends FakeUpstream {
  /** Every object key the shard holds, sorted. */
  keys(): string[];
}

const xml = (text: string): string => `<?xml version="1.0" encoding="UTF-8"?>${text}`;
const esc = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * A state shard that remembers what it is given: enough of S3's object and
 * ListObjectsV2 behaviour for a Pulumi backend to run against it, with the
 * answers a real shard gives for a missing object. It speaks only plain HTTP
 * on loopback and checks no signature: the process in front of it does that.
 */
export async function startMemoryShard(bucket: string): Promise<MemoryShard> {
  const objects = new Map<string, Stored>();
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://shard.invalid');
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
      const parts = url.pathname.split('/').slice(1);
      const key = parts.slice(1).map(decodeURIComponent).join('/');
      const missing = (): void => {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(xml('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>'));
      };
      if (parts[0] !== bucket) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(xml('<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>'));
        return;
      }
      const method = req.method ?? '';
      if (key === '' && method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const delimiter = url.searchParams.get('delimiter');
        const after = url.searchParams.get('start-after') ?? '';
        const matching = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort();
        const contents: string[] = [];
        const commonPrefixes = new Set<string>();
        for (const k of matching) {
          const rest = k.slice(prefix.length);
          const cut = delimiter === null || delimiter === '' ? -1 : rest.indexOf(delimiter);
          if (cut === -1) contents.push(k);
          else commonPrefixes.add(prefix + rest.slice(0, cut + delimiter!.length));
        }
        const entries = contents
          .map((k) => {
            const stored = objects.get(k) as Stored;
            return `<Contents><Key>${esc(k)}</Key><LastModified>${stored.modified.toISOString()}</LastModified><ETag>"x"</ETag><Size>${stored.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          })
          .join('');
        const prefixes = [...commonPrefixes]
          .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
          .join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          xml(
            `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${contents.length + commonPrefixes.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${entries}${prefixes}</ListBucketResult>`
          )
        );
        return;
      }
      if (method === 'PUT') {
        const source = req.headers['x-amz-copy-source'];
        let data: Buffer = body;
        if (typeof source === 'string') {
          const from = decodeURIComponent(source).replace(/^\//, '').split('/').slice(1).join('/');
          const found = objects.get(from);
          if (found === undefined) return missing();
          data = found.body;
        }
        objects.set(key, { body: data, modified: new Date() });
        res.writeHead(200, { etag: '"x"', 'content-type': 'application/xml' });
        res.end(
          typeof source === 'string'
            ? xml('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>')
            : ''
        );
        return;
      }
      const stored = objects.get(key);
      if (method === 'GET' || method === 'HEAD') {
        if (stored === undefined) {
          if (method === 'HEAD') {
            res.writeHead(404);
            res.end();
            return;
          }
          return missing();
        }
        res.writeHead(200, {
          'content-length': String(stored.body.length),
          'last-modified': stored.modified.toUTCString(),
          etag: '"x"',
        });
        res.end(method === 'HEAD' ? undefined : stored.body);
        return;
      }
      if (method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
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
    keys: () => [...objects.keys()].sort(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
