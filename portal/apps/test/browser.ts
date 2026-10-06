import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Handler = (
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse
) => Promise<void>;

export interface Running {
  readonly origin: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Starts `build(origin)` on an ephemeral loopback port. */
export async function serve(build: (origin: string) => Handler): Promise<Running> {
  let handler: Handler | undefined;
  const server = createServer((request, response) => void handler?.(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = build(origin);
  return {
    origin,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
  readonly location: string | null;
}

/** A client with one cookie jar, following no redirects on its own. */
export class Browser {
  readonly #jar = new Map<string, string>();
  readonly #origin: string;

  constructor(origin: string) {
    this.#origin = origin;
  }

  cookie(name: string): string | undefined {
    return this.#jar.get(name);
  }

  async request(
    path: string,
    init: { method?: string; headers?: Record<string, string> } = {}
  ): Promise<Reply> {
    const cookies = [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(`${this.#origin}${path}`, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      headers: { ...(cookies ? { cookie: cookies } : {}), ...init.headers },
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, at);
      const value = (pair ?? '').slice(at + 1);
      if (/Max-Age=0\b/.test(line)) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
    return {
      status: response.status,
      body: await response.text(),
      headers: response.headers,
      location: response.headers.get('location'),
    };
  }

  /** Starts a sign-in and returns the state the application issued. */
  async begin(): Promise<string> {
    const reply = await this.request('/login');
    return new URL(reply.location ?? '').searchParams.get('state') ?? '';
  }

  /** Completes the sign-in the application started, presenting `code`. */
  async finish(code: string, state?: string): Promise<Reply> {
    const issued = await this.begin();
    return this.request(`/callback?code=${code}&state=${state ?? issued}`);
  }
}
