/**
 * The `AdminApiClient` the broker runs in production: on a site's first
 * build it creates the owner account, keeps only that owner's staff access
 * token, and applies the settings with it; every later configure uses the
 * stored token. See client.md#ghostadminclient.
 */
import { randomBytes } from 'node:crypto';
import {
  renderSettings,
  type SlotName,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import type { AdminApiClient } from '../adminApi.js';
import { isAdminApiKey, type AdminKeyStore } from './keyStore.js';
import { loopbackGhostTransport, type GhostResponse, type GhostTransport } from './request.js';
import { adminApiToken } from './token.js';

export const OWNER_NAME_PLACEHOLDER = 'ALL_CAPS_PLACEHOLDER_OWNER_NAME';
export const SITE_TITLE_PLACEHOLDER = 'ALL_CAPS_PLACEHOLDER_SITE_TITLE';

const ADMIN = '/ghost/api/admin';
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

/** The stored token is gone or Ghost no longer accepts it; the caller must not proceed. */
export class AdminAccessLostError extends Error {
  constructor(slot: string, why: string) {
    super(
      `slot "${slot}": ${why}; the site's settings were not re-applied, so this change is ` +
        'refused and the demo stays as it was'
    );
    this.name = 'AdminAccessLostError';
  }
}

export interface GhostAdminClientOptions {
  readonly keyStore: AdminKeyStore;
  readonly zones: Pick<ZoneConfig, 'demoMailDomain'>;
  readonly readyTimeoutMs: number;
  readonly transport?: GhostTransport;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newPassword?: () => string;
}

interface Target {
  readonly port: number;
  readonly siteHost: string;
}

function describe(res: GhostResponse): string {
  const body = res.body as { errors?: { message?: string }[] } | undefined;
  const message = body?.errors?.[0]?.message;
  return message ? `${res.status} (${message})` : String(res.status);
}

function expectStatus(res: GhostResponse, status: number, step: string): void {
  if (res.status !== status) {
    throw new Error(`Ghost refused ${step}: ${describe(res)}`);
  }
}

function sessionCookie(res: GhostResponse): string {
  const cookies = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0] ?? '');
  const session = cookies.filter((c) => c.startsWith('ghost-admin-api-session='));
  if (session.length !== 1) throw new Error('Ghost set no admin session cookie');
  return session[0] as string;
}

export function createGhostAdminClient(options: GhostAdminClientOptions): AdminApiClient {
  const transport = options.transport ?? loopbackGhostTransport;
  const nowMs = options.nowMs ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newPassword = options.newPassword ?? (() => randomBytes(32).toString('base64url'));

  function call(
    target: Target,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    extra: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<GhostResponse> {
    return transport({
      port: target.port,
      siteHost: target.siteHost,
      method,
      path: `${ADMIN}${path}`,
      body: extra.body,
      headers: extra.headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  /** Waits out Ghost's boot; answers whether the site already has its owner. */
  async function isSetUp(target: Target): Promise<boolean> {
    const deadline = nowMs() + options.readyTimeoutMs;
    let last = 'no answer';
    for (;;) {
      try {
        const res = await call(target, 'GET', '/authentication/setup/');
        const status = (res.body as { setup?: { status?: unknown }[] } | undefined)?.setup?.[0]
          ?.status;
        if (res.status === 200 && typeof status === 'boolean') return status;
        last = describe(res);
      } catch (err) {
        last = (err as Error).message;
      }
      if (nowMs() >= deadline) {
        throw new Error(
          `Ghost's Admin API did not answer within ${options.readyTimeoutMs}ms (last: ${last})`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** The one time a password exists: it never leaves this function. */
  async function firstBuild(target: Target, ownerEmail: string): Promise<string> {
    const password = newPassword();
    const origin = { Origin: `https://${target.siteHost}` };
    expectStatus(
      await call(target, 'POST', '/authentication/setup/', {
        body: {
          setup: [
            {
              name: OWNER_NAME_PLACEHOLDER,
              email: ownerEmail,
              password,
              blogTitle: SITE_TITLE_PLACEHOLDER,
            },
          ],
        },
      }),
      201,
      'site setup'
    );
    const signIn = await call(target, 'POST', '/session/', {
      body: { username: ownerEmail, password },
      headers: origin,
    });
    expectStatus(signIn, 201, 'the first sign-in');
    const session = { ...origin, Cookie: sessionCookie(signIn) };
    try {
      const me = await call(target, 'GET', '/users/me/', { headers: session });
      expectStatus(me, 200, 'reading the owner');
      const id = (me.body as { users?: { id?: unknown }[] }).users?.[0]?.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) {
        throw new Error('Ghost returned no owner id');
      }
      const tokenRes = await call(target, 'GET', `/users/${id}/token/`, { headers: session });
      expectStatus(tokenRes, 200, "reading the owner's staff access token");
      const apiKey = (tokenRes.body as { apiKey?: { id?: unknown; secret?: unknown } }).apiKey;
      const key = `${String(apiKey?.id)}:${String(apiKey?.secret)}`;
      if (!isAdminApiKey(key)) throw new Error('Ghost returned no usable staff access token');
      return key;
    } finally {
      await call(target, 'DELETE', '/session/', { headers: session }).catch(() => undefined);
    }
  }

  async function applySettings(
    target: Target,
    slot: SlotName,
    key: string,
    descriptor: TenantDescriptor
  ): Promise<void> {
    const rendered = renderSettings(descriptor, options.zones);
    const wanted: Record<string, string> = {
      codeinjection_head: rendered.codeinjection_head,
      codeinjection_foot: rendered.codeinjection_foot,
      members_support_address: rendered.members_support_address,
    };
    const res = await call(target, 'PUT', '/settings/', {
      body: { settings: Object.entries(wanted).map(([k, value]) => ({ key: k, value })) },
      headers: { Authorization: `Ghost ${adminApiToken(key, Math.floor(nowMs() / 1000))}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new AdminAccessLostError(
        slot,
        `Ghost no longer accepts the stored owner access token (${describe(res)}): ` +
          'the site owner regenerated or revoked it'
      );
    }
    expectStatus(res, 200, 'the settings update');
    const got = new Map(
      ((res.body as { settings?: { key: string; value: unknown }[] }).settings ?? []).map((s) => [
        s.key,
        s.value ?? '',
      ])
    );
    for (const [k, value] of Object.entries(wanted)) {
      if (got.get(k) !== value) {
        throw new Error(`Ghost did not apply ${k}: it reads back a different value`);
      }
    }
  }

  return {
    async configure(baseUrl, descriptor, slot) {
      const target: Target = {
        port: Number(new URL(baseUrl).port),
        siteHost: new URL(descriptor.siteUrl).host,
      };
      if (!(await isSetUp(target))) {
        // A fresh site: anything stored for this slot belongs to a tenancy
        // whose data is gone, so it is dropped before a new token exists.
        await options.keyStore.remove(slot);
        const key = await firstBuild(target, descriptor.ownerEmail);
        await options.keyStore.write(slot, key);
        await applySettings(target, slot, key, descriptor);
        return;
      }
      const key = await options.keyStore.read(slot);
      if (key === null) {
        throw new AdminAccessLostError(slot, 'no owner access token is stored for this site');
      }
      await applySettings(target, slot, key, descriptor);
    },

    async forget(slot) {
      await options.keyStore.remove(slot);
    },
  };
}
