import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createTlsServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';

/** One request as a client sent it, with every key and prefix replaced, so the set can be read and compared. */
export interface RecordedShape {
  readonly method: string;
  /** `bucket`, `bucket/<P>/<rest>` with the tenant prefix named `<P>`, or `other`. */
  readonly path: string;
  /** Query parameter names, sorted, without values. */
  readonly query: readonly string[];
  /** `signed` for a hex digest of the body, otherwise the marker the client sent. */
  readonly payload: string;
  /** Headers that change what a request means, by name. */
  readonly notable: readonly string[];
  readonly status: number;
}

export interface RecordingEdge {
  readonly port: number;
  readonly certFile: string;
  readonly shapes: RecordedShape[];
  close(): Promise<void>;
}

const NOTABLE =
  /^(?:x-amz-copy-source|x-amz-checksum-.*|x-amz-sdk-checksum-algorithm|x-amz-trailer|x-amz-decoded-content-length|content-encoding|transfer-encoding|expect|if-none-match|if-match|x-amz-meta-.*|x-amz-acl|x-amz-storage-class)$/;

/**
 * Stands where the edge stands in production: it terminates TLS with a
 * throwaway certificate and forwards each request, unchanged, over plain HTTP
 * to the state process. It records what Pulumi's client sent, so the request
 * set is read from the client and not from what the process happened to admit.
 */
export async function startRecordingEdge(
  dir: string,
  target: { readonly port: number },
  bucket: string,
  prefix: string
): Promise<RecordingEdge> {
  const keyFile = join(dir, 'edge-key.pem');
  const certFile = join(dir, 'edge-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-subj',
      '/CN=127.0.0.1',
      '-days',
      '1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  );
  const shapes: RecordedShape[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createTlsServer(
    { key: readFileSync(keyFile), cert: readFileSync(certFile) },
    (req, res) => {
      const url = new URL(req.url ?? '/', 'https://edge.invalid');
      const segments = url.pathname.split('/').slice(1);
      let path = 'other';
      if (segments[0] === bucket) {
        const rest = segments.slice(1).join('/');
        path =
          rest === ''
            ? 'bucket'
            : rest.startsWith(`${prefix}/`)
              ? `bucket/<P>/${rest.slice(prefix.length + 1).replace(/[0-9a-f-]{36}/g, '<uuid>')}`
              : `bucket/${rest}`;
      }
      const payloadHeader = req.headers['x-amz-content-sha256'];
      const payload =
        typeof payloadHeader !== 'string'
          ? 'absent'
          : /^[0-9a-f]{64}$/.test(payloadHeader)
            ? 'signed'
            : payloadHeader;
      const record = (status: number): void => {
        shapes.push({
          method: req.method ?? '',
          path,
          query: [...url.searchParams.keys()].sort(),
          payload,
          notable: Object.keys(req.headers)
            .filter((h) => NOTABLE.test(h))
            .sort(),
          status,
        });
      };
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: target.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (answer) => {
          record(answer.statusCode ?? 0);
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        }
      );
      upstream.on('error', () => {
        record(502);
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    }
  );
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    certFile,
    shapes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
