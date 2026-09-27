/**
 * The edge site block: hostname, gate and body-limit configuration for the
 * proxy in front of a tenant or a demo slot — a **new** artefact per
 * LLD-1 §04, moving "concerns that do not live on the host at all" (the
 * gate is edge configuration, not an app-host one) into the render core.
 *
 * **Load-bearing: `admittedHostname` is never `displayHostname`.**
 * `validate.ts#servedHostnameOf`'s own doc comment states the reason a demo
 * must never reach on-demand TLS admission under its own hostname: a demo
 * slot sits under a platform wildcard certificate, and asking per-hostname
 * for one would put a reusable slot's current name into a public,
 * append-only CT log for good, which the never-reuse rule for slot names
 * cannot tolerate. This module keeps that as two separate fields rather
 * than one, precisely so a caller cannot use the human-readable hostname
 * for a certificate decision by accident: `displayHostname` is always the
 * descriptor's own host (safe to show, redirect to, log); `admittedHostname`
 * is `servedHostnameOf`'s own answer, `null` for every demo.
 *
 * **The strict content policy (LLD-5 C1-C4).**
 * `script-src` is `'self'` plus the theme's own derived inline-script hash
 * set — never a hand-written list; see `ThemeCsp` below. The hash set is
 * deliberately **not** a `TenantDescriptor` field: it is operational state
 * that changes on every theme upload, not part of what a tenant was
 * promised, and `render-core/src/lease.ts`'s `SlotLeaseRecord` already
 * draws that same line for the same reason (the cross-document review's P1
 * makes the general case; the issue's own open question marks this split
 * incidental). So it arrives here as an explicit parameter, computed
 * upstream by the derivation tool (`csp/derive/`) — this module never
 * computes a hash itself, only renders one it was handed. **Load-bearing
 * (LLD-5's own marks): the hash set is always derived, never hand-set, and
 * a theme whose set could not be computed gets the report-only policy plus
 * a flag — an enforcing policy is never guessed.** `style-src
 * 'unsafe-inline'` stays for every tenant: Portal styles the iframe it
 * builds for itself inline, and LLD-5 C4 accepts that residual as
 * materially less dangerous than injected script.
 */

import type { Brand } from './brand.js';
import { assertString, FieldValidationError } from './brand.js';
import type { GateSpec, TenantDescriptor } from './descriptor.js';
import type { ZoneConfig } from './validate.js';
import { servedHostnameOf } from './validate.js';
import type { UploadLimits } from './runtime.js';

export interface EdgeGate {
  readonly kind: 'none' | 'passphrase';
  /** Present only for `kind: "passphrase"`. */
  readonly argon2idHash?: string;
}

/** A CSP hash-source token, e.g. `sha256-<base64 of the SHA-256 digest>`. */
export type ScriptHash = Brand<string, 'ScriptHash'>;

// "sha256-" plus the base64 encoding of a 32-byte digest: 43 base64
// characters plus one "=" pad, per RFC 4648 with no line breaks. Anchored
// and length-bounded rather than a bare `+` quantifier, so a caller cannot
// smuggle CSP-syntax characters (a quote, a semicolon) through this field
// into the rendered header.
const SCRIPT_HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

export function validateScriptHash(value: string, field = 'scriptHash'): ScriptHash {
  assertString(value, field);
  if (!SCRIPT_HASH_PATTERN.test(value)) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be a CSP hash-source token: "sha256-" followed by the ` +
        `base64 (with padding) of a SHA-256 digest, e.g. "sha256-" + 43 base64 characters + "=".`
    );
  }
  return value as ScriptHash;
}

/**
 * The derived script-hash set for one theme at one Ghost version, or a
 * statement that it could not be computed. Never constructed by hand outside
 * a validator or the derivation tool's own output — see this module's doc
 * comment for why it is not a descriptor field.
 */
export type ThemeCsp =
  | { readonly kind: 'computed'; readonly hashes: readonly ScriptHash[] }
  | { readonly kind: 'unavailable' };

/** The fail-soft default (LLD-5's own mark): report-only until a real hash set is supplied. */
export const THEME_CSP_UNAVAILABLE: ThemeCsp = { kind: 'unavailable' };

export interface EdgeSiteBlock {
  /** The hostname the site is reached on — safe to display, redirect to or
   * log. Never fed to a certificate-admission decision; see
   * `admittedHostname`. */
  readonly displayHostname: string;
  /** The hostname on-demand TLS may issue a certificate for, or `null` if
   * this descriptor must never reach that decision at all (every demo). */
  readonly admittedHostname: string | null;
  readonly gate: EdgeGate;
  /** The tenant's Caddy `request_body max_size`, in Caddy's own size
   * syntax — bounds the upload paths Ghost itself leaves unlimited. */
  readonly requestBodyMaxSize: string;
  readonly contentSecurityPolicy: string;
  /** `'enforcing'` only when a real, derived hash set was supplied; a
   * caller renders this policy under the `Content-Security-Policy` header
   * for `'enforcing'` and `Content-Security-Policy-Report-Only` for
   * `'report-only'` — and a tenant's health row shows `'report-only'` as
   * the flag LLD-5's own Done means asks for. */
  readonly contentSecurityPolicyMode: 'enforcing' | 'report-only';
}

function edgeGate(gate: GateSpec): EdgeGate {
  if (gate.kind === 'passphrase') {
    return { kind: 'passphrase', argon2idHash: gate.argon2idHash };
  }
  return { kind: 'none' };
}

/**
 * A conservative baseline CSP: same-origin by default, with the narrow
 * allowances Ghost's own admin panel and default themes need (inline
 * styles for theme CSS custom properties, `data:`/`https:` images for
 * uploaded and remote media). `script-src` carries the theme's own derived
 * hash set when one was computed (LLD-5 C1-C3); otherwise it stays
 * `'self'` alone and the policy is rendered report-only rather than
 * enforcing (LLD-5's fail-soft mark) — never a security-reviewed final
 * policy beyond what the spike measured for the default theme.
 */
function contentSecurityPolicy(themeCsp: ThemeCsp): {
  readonly value: string;
  readonly mode: 'enforcing' | 'report-only';
} {
  const scriptSrc =
    themeCsp.kind === 'computed' && themeCsp.hashes.length > 0
      ? `script-src 'self' ${themeCsp.hashes.map((hash) => `'${hash}'`).join(' ')}`
      : "script-src 'self'";
  const value = [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "frame-ancestors 'self'",
  ].join('; ');
  return { value, mode: themeCsp.kind === 'computed' ? 'enforcing' : 'report-only' };
}

export function renderEdgeSiteBlock(
  descriptor: Pick<TenantDescriptor, 'kind' | 'siteUrl' | 'hostname' | 'gate'>,
  zones: Pick<ZoneConfig, 'platformZone' | 'ownedDomains'>,
  limits: UploadLimits,
  themeCsp: ThemeCsp = THEME_CSP_UNAVAILABLE
): EdgeSiteBlock {
  const csp = contentSecurityPolicy(themeCsp);
  return {
    displayHostname: new URL(descriptor.siteUrl).host,
    admittedHostname: servedHostnameOf(descriptor, zones),
    gate: edgeGate(descriptor.gate),
    requestBodyMaxSize: limits.edgeRequestBodyMaxSize,
    contentSecurityPolicy: csp.value,
    contentSecurityPolicyMode: csp.mode,
  };
}
