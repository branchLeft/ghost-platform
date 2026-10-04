import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stateful stand-in for the slice of Ghost's Admin API the broker's
 * client uses, over real HTTP. It verifies the staff token's signature the
 * way Ghost does, so a wrongly signed or revoked token is refused here too.
 */
export interface FakeGhost {
  readonly port: number;
  readonly requests: { method: string; path: string; headers: IncomingMessage['headers'] }[];
  readonly settings: Map<string, string | null>;
  setupBody: Record<string, unknown> | undefined;
  /** Answer 503 to this many readiness polls before answering normally. */
  bootPolls: number;
  /** Override one route's answer: `"<METHOD> <path>"` to a status and body. */
  readonly overrides: Map<
    string,
    { status: number; body?: unknown; headers?: Record<string, string> }
  >;
  /** Overwrite what PUT /settings/ reads back for a key. */
  readonly readBackOverrides: Map<string, string>;
  isSetUp(): boolean;
  markSetUp(): void;
  staffKey(): string;
  regenerateStaffKey(): void;
  sessionsOpen(): number;
  close(): Promise<void>;
}

const OWNER_ID = 'a'.repeat(24);

function newKey(): { id: string; secret: string } {
  return { id: randomBytes(12).toString('hex'), secret: randomBytes(32).toString('hex') };
}

function verifyToken(header: string | undefined, key: { id: string; secret: string }): boolean {
  const match = /^Ghost ([^.]+)\.([^.]+)\.([^.]+)$/.exec(header ?? '');
  if (!match) return false;
  const [, h, p, sig] = match as unknown as [string, string, string, string];
  const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>;
  const body = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
    string,
    number | string
  >;
  const expected = createHmac('sha256', Buffer.from(key.secret, 'hex'))
    .update(`${h}.${p}`)
    .digest('base64url');
  const now = Math.floor(Date.now() / 1000);
  return (
    sig === expected &&
    head.alg === 'HS256' &&
    head.kid === key.id &&
    body.aud === '/admin/' &&
    typeof body.exp === 'number' &&
    typeof body.iat === 'number' &&
    body.exp - body.iat <= 300 &&
    body.exp > now
  );
}

export async function startFakeGhost(): Promise<FakeGhost> {
  let setUp = false;
  let key = newKey();
  let password: string | undefined;
  const sessions = new Set<string>();
  const requests: FakeGhost['requests'] = [];
  const settings = new Map<string, string | null>([['members_support_address', 'noreply']]);
  const overrides: FakeGhost['overrides'] = new Map();
  const readBackOverrides = new Map<string, string>();

  const state = {
    setupBody: undefined as Record<string, unknown> | undefined,
    bootPolls: 0,
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/ghost\/api\/admin/, '');
      requests.push({ method: req.method ?? '', path, headers: req.headers });
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };
      const override = overrides.get(`${req.method} ${path}`);
      if (override) return send(override.status, override.body, override.headers);
      const cookie = /ghost-admin-api-session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const signedIn = cookie !== undefined && sessions.has(cookie);

      if (req.method === 'GET' && path === '/authentication/setup/') {
        if (state.bootPolls > 0) {
          state.bootPolls -= 1;
          return send(503, { errors: [{ message: 'Site is starting up' }] });
        }
        return send(200, { setup: [{ status: setUp }] });
      }
      if (req.method === 'POST' && path === '/authentication/setup/') {
        if (setUp) return send(403, { errors: [{ message: 'Setup has already been completed.' }] });
        const entry = (body.setup as Record<string, unknown>[])[0] ?? {};
        state.setupBody = entry;
        password = String(entry.password);
        setUp = true;
        return send(201, { users: [{ id: OWNER_ID }] });
      }
      if (req.method === 'POST' && path === '/session/') {
        if (!req.headers.origin) return send(400, { errors: [{ message: 'no origin' }] });
        if (body.password !== password) return send(401, { errors: [{ message: 'bad password' }] });
        const id = randomBytes(8).toString('hex');
        sessions.add(id);
        return send(201, 'Created', {
          'Set-Cookie': `ghost-admin-api-session=${id}; Path=/ghost; HttpOnly`,
        });
      }
      if (req.method === 'DELETE' && path === '/session/') {
        if (cookie) sessions.delete(cookie);
        return send(204);
      }
      if (req.method === 'GET' && path === '/users/me/') {
        if (!signedIn) return send(403, { errors: [{ message: 'no session' }] });
        return send(200, { users: [{ id: OWNER_ID }] });
      }
      if (req.method === 'GET' && path === `/users/${OWNER_ID}/token/`) {
        if (!signedIn) return send(403, { errors: [{ message: 'no session' }] });
        return send(200, { apiKey: { id: key.id, secret: key.secret, user_id: OWNER_ID } });
      }
      if (req.method === 'PUT' && path === '/settings/') {
        if (!verifyToken(req.headers.authorization, key)) {
          return send(401, { errors: [{ message: 'Invalid token' }] });
        }
        for (const s of body.settings as { key: string; value: string }[]) {
          settings.set(s.key, s.value === '' ? null : s.value);
        }
        return send(200, {
          settings: [...settings].map(([k, v]) => ({
            key: k,
            value: readBackOverrides.get(k) ?? v,
          })),
          meta: {},
        });
      }
      return send(404, { errors: [{ message: `no route ${req.method} ${path}` }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    requests,
    settings,
    overrides,
    readBackOverrides,
    get setupBody() {
      return state.setupBody;
    },
    set setupBody(value) {
      state.setupBody = value;
    },
    get bootPolls() {
      return state.bootPolls;
    },
    set bootPolls(value) {
      state.bootPolls = value;
    },
    isSetUp: () => setUp,
    markSetUp: () => {
      setUp = true;
    },
    staffKey: () => `${key.id}:${key.secret}`,
    regenerateStaffKey: () => {
      key = newKey();
    },
    sessionsOpen: () => sessions.size,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
