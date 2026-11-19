import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request,
  type IncomingMessage,
  type Server,
} from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import {
  docker,
  labelArgs,
  pollHttp200,
  removeContainerProven,
  reservePort,
  runStep,
} from '../../../../test-support/image-harness.mjs';

const execFileAsync = promisify(execFile);

export interface MailRecord {
  readonly to: readonly string[];
  readonly data: string;
}

/**
 * A one-purpose SMTP server on this process's event loop. Nothing in the image
 * test blocks that loop while Ghost is mid-send, so no worker thread is needed.
 * `pause()` closes the listener, so Ghost's next send is refused: a mail path
 * that is down. `resume()` listens again on the same port.
 */
export class SmtpSink {
  readonly messages: MailRecord[] = [];
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  private constructor(readonly port: number) {}

  static async start(): Promise<SmtpSink> {
    const sink = new SmtpSink(await reservePort());
    await sink.listen();
    return sink;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.serve(socket));
      server.on('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        resolve();
      });
    });
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let inData = false;
    let buffer = '';
    let current: { to: string[]; data: string } = { to: [], data: '' };
    const reply = (line: string): void => void socket.write(`${line}\r\n`);
    reply('220 sink ESMTP');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          this.messages.push(current);
          current = { to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = (line.split(' ')[0] ?? '').toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 sink');
        else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  }

  async pause(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async resume(): Promise<void> {
    if (!this.server) await this.listen();
  }

  stop(): Promise<void> {
    return this.pause();
  }
}

export interface Reply {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly text: string;
  readonly setCookies: readonly string[];
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 20_000
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers, timeout: timeoutMs },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            setCookies: res.headers['set-cookie'] ?? [],
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * What Caddy does for the demo edge, in the smallest form that preserves the
 * contract the real one is rendered to: the gate's own paths go straight to
 * the gate, everything else is asked of the gate first and reaches Ghost only
 * on a 200. Every request is written as one line in Caddy's JSON access log.
 */
export async function startEdge(options: {
  gatePort: number;
  ghostPort: number;
  logPath: string;
}): Promise<{ port: number; close(): Promise<void> }> {
  const clientIp = '203.0.113.7';
  const server: Server = createHttpServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      const path = url.split('?')[0];
      const host = req.headers.host ?? '';
      const forwarded: Record<string, string> = { host, 'x-forwarded-for': clientIp };
      if (req.headers.cookie) forwarded.cookie = req.headers.cookie;
      if (req.headers['content-type']) forwarded['content-type'] = req.headers['content-type'];

      let answer: Reply;
      if (path === '/__gate/login' || path === '/__gate/enter') {
        answer = await call(options.gatePort, req.method ?? 'GET', url, forwarded, body);
      } else {
        const verdict = await call(options.gatePort, 'GET', '/__gate/verify', {
          ...forwarded,
          'x-forwarded-uri': url,
        });
        answer =
          verdict.status === 200
            ? await call(
                options.ghostPort,
                req.method ?? 'GET',
                url,
                {
                  ...(req.headers as Record<string, string>),
                  'x-forwarded-proto': 'https',
                },
                body === '' ? undefined : body
              )
            : verdict;
      }
      appendFileSync(
        options.logPath,
        `${JSON.stringify({
          level: 'info',
          ts: Date.now() / 1000,
          logger: 'http.log.access.log0',
          msg: 'handled request',
          request: {
            remote_ip: clientIp,
            method: req.method,
            host,
            uri: url,
            headers: req.headers.referer ? { Referer: [req.headers.referer] } : {},
          },
          status: answer.status,
        })}\n`
      );
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && name !== 'transfer-encoding' && name !== 'connection') {
          headers[name] = value;
        }
      }
      res.writeHead(answer.status, headers);
      res.end(answer.text);
    })().catch(() => {
      res.writeHead(502);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A visitor's browser, as far as these tests need: it carries cookies and follows nothing. */
export class Browser {
  private readonly jar = new Map<string, string>();

  constructor(
    private readonly edgePort: number,
    private readonly host: string
  ) {}

  get cookieNames(): string[] {
    return [...this.jar.keys()];
  }

  async request(method: string, path: string, form?: Record<string, string>): Promise<Reply> {
    const headers: Record<string, string> = { host: this.host, origin: `https://${this.host}` };
    if (this.jar.size > 0) {
      headers.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    let body: string | undefined;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const reply = await call(this.edgePort, method, path, headers, body);
    for (const cookie of reply.setCookies) {
      const [pair] = cookie.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0 && pair) this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return reply;
  }
}

/** A Ghost container from the built image, reached on a published loopback port. */
export class Ghost {
  private constructor(
    readonly name: string,
    readonly port: number,
    readonly host: string
  ) {}

  static start(env: Record<string, string>, host: string, bootMs = 90_000): Promise<Ghost> {
    return runStep(
      'start Ghost container',
      async () => {
        const image = process.env.IMAGE;
        if (!image) throw new Error('IMAGE must name the built Ghost image');
        const port = await reservePort();
        const name = `demo-arrival-${process.pid}-${port}`;
        const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        docker(
          'create',
          '--name',
          name,
          ...labelArgs('demo-gate-arrival'),
          '--add-host',
          'host.docker.internal:host-gateway',
          '-p',
          `127.0.0.1:${port}:2368`,
          ...envArgs,
          image
        );
        const ghost = new Ghost(name, port, host);
        docker('start', name);
        const booted = await pollHttp200(`http://127.0.0.1:${port}/`, {
          containerName: name,
          deadlineMs: bootMs,
          probe: (signal: AbortSignal) =>
            ghost.directRaw('GET', '/', undefined, signal).then((reply) => reply.status),
        } as Parameters<typeof pollHttp200>[1]);
        if (!booted.ok) {
          throw new Error(`Ghost did not boot (${booted.detail}):\n${await ghost.logs()}`);
        }
        return ghost;
      },
      { deadlineMs: bootMs + 60_000 }
    );
  }

  /** The request the edge would make: Ghost's own host name, and https. */
  private directRaw(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          signal,
          headers: {
            host: this.host,
            origin: `https://${this.host}`,
            'x-forwarded-proto': 'https',
            'content-type': 'application/json',
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              setCookies: res.headers['set-cookie'] ?? [],
            })
          );
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  direct(method: string, path: string, body?: unknown): Promise<Reply> {
    return this.directRaw(method, path, body);
  }

  async logs(): Promise<string> {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', this.name], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const colour = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    return `${stdout}${stderr}`.replace(colour, '');
  }

  /** The adapter's own log lines, which are the only way to tell a refusal from an adapter not running. */
  async adapterLines(): Promise<string[]> {
    return (await this.logs())
      .split('\n')
      .filter((line) => line.includes('break-glass:'))
      .map((line) => line.slice(line.indexOf('break-glass:')));
  }

  remove(): void {
    removeContainerProven(this.name);
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
