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
 */

import type { GateSpec, TenantDescriptor } from './descriptor.js';
import type { ZoneConfig } from './validate.js';
import { servedHostnameOf } from './validate.js';
import type { UploadLimits } from './runtime.js';

export interface EdgeGate {
  readonly kind: 'none' | 'passphrase';
  /** Present only for `kind: "passphrase"`. */
  readonly argon2idHash?: string;
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
 * uploaded and remote media). Nothing here is measured against a running
 * Ghost admin session — flagged as a first pass for whichever story wires
 * this into the real edge, not a security-reviewed final policy.
 */
function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export function renderEdgeSiteBlock(
  descriptor: Pick<TenantDescriptor, 'kind' | 'siteUrl' | 'hostname' | 'gate'>,
  zones: Pick<ZoneConfig, 'platformZone' | 'ownedDomains'>,
  limits: UploadLimits
): EdgeSiteBlock {
  return {
    displayHostname: new URL(descriptor.siteUrl).host,
    admittedHostname: servedHostnameOf(descriptor, zones),
    gate: edgeGate(descriptor.gate),
    requestBodyMaxSize: limits.edgeRequestBodyMaxSize,
    contentSecurityPolicy: contentSecurityPolicy(),
  };
}
