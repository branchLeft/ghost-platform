/**
 * The edge site block: hostname, gate and body-limit configuration for the
 * proxy in front of a tenant or a demo slot. `admittedHostname` is never
 * `displayHostname` (see edge.md#admitted-vs-display-hostname), and the CSP
 * script-src hash set always arrives as a computed parameter, never
 * hand-set (see edge.md#the-strict-content-policy).
 */

import type { Brand } from './brand.js';
import { assertString, FieldValidationError } from './brand.js';
import type { GateSpec, TenantDescriptor } from './descriptor.js';
import type { ZoneConfig } from './validate.js';
import { servedHostnameOf } from './validate.js';
import type { UploadLimits } from './runtime.js';
import paymentsOrigins from './payments-origins.json' with { type: 'json' };

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

/**
 * Whether the site takes payments through Stripe, and so must let the
 * browser load Stripe's script and frame. `none` renders the policy exactly
 * as it was before payments existed. Same operational-state rule as
 * `ThemeCsp`: an explicit parameter, never a `TenantDescriptor` field, so a
 * tenant with no payments never gets a wider `script-src`. See
 * edge.md#the-payments-allowance.
 */
export type PaymentsCsp = { readonly kind: 'stripe' } | { readonly kind: 'none' };

/** The default: no payment origins in the policy. */
export const PAYMENTS_CSP_NONE: PaymentsCsp = { kind: 'none' };

/** The directives a payments allowance may extend. */
export const PAYMENT_DIRECTIVES = ['script-src', 'frame-src', 'connect-src'] as const;
export type PaymentDirective = (typeof PAYMENT_DIRECTIVES)[number];

// One https origin on a Stripe-owned domain, nothing else: no path, no port,
// no wildcard, no quote or semicolon that could close the directive early.
// Anchored, like SCRIPT_HASH_PATTERN, so a hand edit of the generated file
// cannot smuggle CSP syntax or a third party into the rendered header.
const PAYMENT_ORIGIN_PATTERN =
  /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*(stripe\.com|stripe\.network)$/;

export function validatePaymentOrigin(value: string, field = 'paymentOrigin'): string {
  assertString(value, field);
  if (!PAYMENT_ORIGIN_PATTERN.test(value)) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be a bare https origin on stripe.com or stripe.network ` +
        '(scheme and host only: no wildcard, port, path or CSP syntax).'
    );
  }
  return value;
}

/**
 * The origins Stripe needs, per directive. They are MEASURED, not written:
 * `payments-origins.json` is produced only by
 * `csp/derive/derive-payment-origins.mjs` from a real browser's violation
 * report against a real Ghost loading the real Stripe.js, and its `--check`
 * fails when the file drifts. This module validates and renders them and
 * never adds one.
 */
export function stripeOrigins(
  source: Readonly<Record<string, readonly string[]>> = paymentsOrigins.origins
): Readonly<Record<PaymentDirective, readonly string[]>> {
  const out = {} as Record<PaymentDirective, readonly string[]>;
  for (const directive of PAYMENT_DIRECTIVES) {
    const list = source[directive] ?? [];
    out[directive] = list.map((origin) => validatePaymentOrigin(origin, `payments.${directive}`));
  }
  return out;
}

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
function contentSecurityPolicy(
  themeCsp: ThemeCsp,
  payments: PaymentsCsp
): {
  readonly value: string;
  readonly mode: 'enforcing' | 'report-only';
} {
  const stripe = payments.kind === 'stripe' ? stripeOrigins() : null;
  const withStripe = (directive: PaymentDirective, base: string): string =>
    stripe === null || stripe[directive].length === 0
      ? base
      : `${base} ${stripe[directive].join(' ')}`;
  const scriptSrc = withStripe(
    'script-src',
    themeCsp.kind === 'computed' && themeCsp.hashes.length > 0
      ? `script-src 'self' ${themeCsp.hashes.map((hash) => `'${hash}'`).join(' ')}`
      : "script-src 'self'"
  );
  // default-src does not cover a Stripe frame or request once an allowance is
  // added, so each directive with measured origins is written out beside
  // 'self'. None with no allowance: the header is byte-identical to before.
  const extra = (['frame-src', 'connect-src'] as const)
    .filter((directive) => stripe !== null && stripe[directive].length > 0)
    .map((directive) => withStripe(directive, `${directive} 'self'`));
  const value = [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    ...extra,
    "frame-ancestors 'self'",
  ].join('; ');
  return { value, mode: themeCsp.kind === 'computed' ? 'enforcing' : 'report-only' };
}

export function renderEdgeSiteBlock(
  descriptor: Pick<TenantDescriptor, 'kind' | 'siteUrl' | 'hostname' | 'gate'>,
  zones: Pick<ZoneConfig, 'platformZone' | 'ownedDomains'>,
  limits: UploadLimits,
  themeCsp: ThemeCsp = THEME_CSP_UNAVAILABLE,
  payments: PaymentsCsp = PAYMENTS_CSP_NONE
): EdgeSiteBlock {
  const csp = contentSecurityPolicy(themeCsp, payments);
  return {
    displayHostname: new URL(descriptor.siteUrl).host,
    admittedHostname: servedHostnameOf(descriptor, zones),
    gate: edgeGate(descriptor.gate),
    requestBodyMaxSize: limits.edgeRequestBodyMaxSize,
    contentSecurityPolicy: csp.value,
    contentSecurityPolicyMode: csp.mode,
  };
}
