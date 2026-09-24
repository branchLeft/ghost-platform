import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  validateLeaseId,
  validateSlotName,
  type LeaseId,
  type SlotName,
} from '@branchleft/ghost-platform-render-core';

// `__Host-` makes the browser itself enforce Secure, Path=/ and the absence
// of a Domain attribute, so the cookie cannot be widened to a sibling demo
// host by a later change to the attributes below.
export const COOKIE_NAME = '__Host-bl_demo_gate';

export const MIN_KEY_BYTES = 32;

export interface GateClaim {
  readonly slot: SlotName;
  readonly lease: LeaseId;
  /** Expiry, whole seconds since the epoch. */
  readonly exp: number;
}

export type CookieVerdict =
  | { readonly ok: true; readonly claim: GateClaim }
  | { readonly ok: false; readonly reason: 'malformed' | 'signature' | 'expired' };

const VERSION = 'v1';
// Fields are dot-separated, and none of them can contain a dot: the slot
// name's charset excludes it, a ULID is base32, exp is digits, the MAC is
// base64url.
const COOKIE_PATTERN =
  /^v1\.([a-z0-9-]{1,63})\.([0-9A-Z]{26})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function signCookie(key: Buffer, claim: GateClaim): string {
  const payload = `${VERSION}.${claim.slot}.${claim.lease}.${claim.exp}`;
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

/**
 * Checks shape, then signature, then expiry. The signature comparison is
 * constant-time; nothing about the claim is trusted until it has passed.
 * Whether the claim's slot and lease are the current ones is the caller's
 * question, because only the caller knows which host was asked for.
 */
export function verifyCookie(key: Buffer, value: string, nowSeconds: number): CookieVerdict {
  const match = COOKIE_PATTERN.exec(value);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, slotRaw, leaseRaw, expRaw, macRaw] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const presented = Buffer.from(macRaw, 'base64url');
  const expected = mac(key, `${VERSION}.${slotRaw}.${leaseRaw}.${expRaw}`);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'signature' };
  }
  let slot: SlotName;
  let lease: LeaseId;
  try {
    slot = validateSlotName(slotRaw);
    lease = validateLeaseId(leaseRaw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const exp = Number(expRaw);
  if (exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claim: { slot, lease, exp } };
}

/** Every cookie value this service is sent under its own name; any one of them may be the valid one. */
export function readGateCookies(header: string | undefined): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

export function setCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
