import { CALLBACK_PATH, createTokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { parseTrustedProxies } from 'ghost-platform-request-guard/dist/index.js';
import type { createShell } from '../src/shell/app.js';
import { serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

export type CreateShell = typeof createShell;

export const LOGIN_COOKIE = 'portal_login';

/** The loopback peer every request in these tests comes from. */
export const EDGE = '127.0.0.1';

export interface Rig extends Running {
  readonly issuer: FakeIssuer;
  /** How many times the shell called the token endpoint. */
  tokenCalls(): number;
  /** Moves the shell's clock to this many seconds past the starting time. */
  advanceTo(seconds: number): void;
}

export interface RigOptions {
  /** The trusted proxies; absent, the shell is built with no client limit at all. */
  readonly trusted?: string;
  /** Builds a replacement token endpoint over the stand-in issuer; every call to it is still counted. */
  readonly tokenEndpoint?: (issuer: FakeIssuer) => typeof fetch;
}

/** The shell built by `create`, served on loopback with a stand-in token endpoint. */
export async function startRig(create: CreateShell, options: RigOptions = {}): Promise<Rig> {
  const issuer = new FakeIssuer();
  let offset = 0;
  let calls = 0;
  const tokenEndpoint = options.tokenEndpoint?.(issuer) ?? issuer.fetch;
  const running = await serve((origin) =>
    create<string>({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      redirectUri: `${origin}${CALLBACK_PATH}`,
      publicOrigin: origin,
      verifier: createTokenVerifier({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        requiredRole: 'tenant-admin',
        allowedOrgIds: new Set(['org-x']),
        clock: () => NOW,
        fetchKeys: async () => jwks,
      }),
      secureCookies: false,
      title: 'T',
      nav: [],
      signOutLabel: 'OUT',
      clock: () => NOW + offset,
      fetch: (url, init) => {
        calls += 1;
        return tokenEndpoint(url, init);
      },
      bind: async () => 'bound',
      landing: async () => '<p>HELLO</p>',
      ...(options.trusted === undefined
        ? {}
        : { clientLimit: { trustedProxies: parseTrustedProxies(options.trusted) } }),
    })
  );
  return {
    ...running,
    issuer,
    tokenCalls: () => calls,
    advanceTo: (seconds) => {
      offset = seconds;
    },
  };
}

export const accessToken = (): string =>
  mint({ org: 'org-x', client: CLIENT_PORTAL, role: 'tenant-admin' });

export interface Answer {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: number | null;
  readonly setCookie: readonly string[];
  readonly location: string | null;
}

/** One request as the edge would forward it: from the loopback peer, naming the client. */
export async function ask(
  rig: Running,
  path: string,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const response = await fetch(`${rig.origin}${path}`, { redirect: 'manual', headers });
  const retry = response.headers.get('retry-after');
  return {
    status: response.status,
    body: await response.text(),
    retryAfter: retry === null ? null : Number(retry),
    setCookie: response.headers.getSetCookie(),
    location: response.headers.get('location'),
  };
}

/** Requests the same path `count` times in turn and returns every status. */
export async function repeat(
  rig: Running,
  path: string,
  count: number,
  headers: (index: number) => Record<string, string>
): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    statuses.push((await ask(rig, path, headers(index))).status);
  }
  return statuses;
}

export const forwardedFor = (address: string): Record<string, string> => ({
  'x-forwarded-for': address,
});

/** A started sign-in: the sealed cookie and state a callback must carry. */
export async function begin(
  rig: Running,
  headers: Record<string, string> = {}
): Promise<{ cookie: string; state: string }> {
  const started = await ask(rig, '/login', headers);
  // A start that was refused has no state and no cookie; the caller sees that.
  const state =
    started.location === null ? '' : (new URL(started.location).searchParams.get('state') ?? '');
  const cookie = (started.setCookie[0] ?? '').split(';')[0] ?? '';
  return { cookie, state };
}

/** The callback with a code, carrying a pending sign-in's cookie, from the client named. */
export async function callbackWith(
  rig: Running,
  pending: { cookie: string; state: string },
  code: string,
  headers: Record<string, string> = {}
): Promise<Answer> {
  return ask(rig, `${CALLBACK_PATH}?code=${code}&state=${pending.state}`, {
    ...headers,
    cookie: pending.cookie,
  });
}

export const CLIENT_A = '203.0.113.7';
export const CLIENT_B = '203.0.113.8';
export const CLIENT_C = '203.0.113.50';
/** Starts the sign-ins the callback flood carries, so it never spends A, B or C. */
export const CLIENT_STARTER = '203.0.113.99';
/** The limit the shell is built with: thirty per client per route per minute. */
export const LIMIT = 30;

export interface FloodOutcome {
  readonly firstThirtyLoginsAllStarted: boolean;
  readonly thirtyFirstLogin: Answer;
  readonly otherClientLogin: Answer;
  readonly firstThirtyCallbacksAllReachedTheIssuer: boolean;
  readonly thirtyFirstCallback: Answer;
  /** Token endpoint calls made by the thirty-first callback alone. */
  readonly tokenCallsByThirtyFirstCallback: number;
}

/**
 * The flood both the real test and its sabotage observe: client A starts
 * thirty sign-ins and a thirty-first, client B starts one, and client C sends
 * thirty callbacks that each reach the token endpoint and a thirty-first. The
 * shell is built by `create` behind a trusted loopback edge.
 */
export async function floodOutcome(create: CreateShell): Promise<FloodOutcome> {
  const rig = await startRig(create, { trusted: EDGE });
  try {
    const logins = await repeat(rig, '/login', LIMIT, () => forwardedFor(CLIENT_A));
    const thirtyFirstLogin = await ask(rig, '/login', forwardedFor(CLIENT_A));
    const otherClientLogin = await ask(rig, '/login', forwardedFor(CLIENT_B));

    const pending = await begin(rig, forwardedFor(CLIENT_STARTER));
    const callbacks: Answer[] = [];
    for (let sent = 0; sent < LIMIT; sent += 1) {
      callbacks.push(await callbackWith(rig, pending, 'NEVER-ISSUED', forwardedFor(CLIENT_C)));
    }
    const before = rig.tokenCalls();
    const thirtyFirstCallback = await callbackWith(
      rig,
      pending,
      'NEVER-ISSUED',
      forwardedFor(CLIENT_C)
    );
    return {
      firstThirtyLoginsAllStarted: logins.every((status) => status === 302),
      thirtyFirstLogin,
      otherClientLogin,
      // The issuer refuses a code it never gave, which the shell answers 403:
      // reaching that answer is proof the request got as far as the token endpoint.
      firstThirtyCallbacksAllReachedTheIssuer:
        callbacks.every((answer) => answer.status === 403) && before === LIMIT,
      thirtyFirstCallback,
      tokenCallsByThirtyFirstCallback: rig.tokenCalls() - before,
    };
  } finally {
    await rig.close();
  }
}

/**
 * Two callbacks that carry the same sealed pending sign-in, each with its own
 * valid code, sent together to a token endpoint that holds the first reply
 * until the second has arrived. Both therefore pass the check for an already
 * spent sign-in before either has claimed it; only the claim after the token
 * is verified can tell them apart.
 */
export async function concurrentCallbacks(create: CreateShell): Promise<Answer[]> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const rig = await startRig(create, {
    tokenEndpoint: (issuer) => async (url, init) => {
      arrived += 1;
      if (arrived === 1) await held;
      else release();
      return issuer.fetch(url, init);
    },
  });
  try {
    const pending = await begin(rig);
    const first = rig.issuer.issue(accessToken());
    const second = rig.issuer.issue(accessToken());
    return await Promise.all([
      callbackWith(rig, pending, first),
      callbackWith(rig, pending, second),
    ]);
  } finally {
    await rig.close();
  }
}
