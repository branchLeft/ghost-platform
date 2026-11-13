#!/usr/bin/env node
// Renders the real CSP header value and mode through render-core's own
// built `renderEdgeSiteBlock` -- never a re-implementation -- for the live
// proof to hand to Caddy (CSP_PAYMENTS=stripe adds the measured Stripe
// origins; see below). Reads the derived `ThemeCsp` as JSON from stdin
// (the exact shape `derive-script-hashes.mjs` prints on its "computed"
// path, or `{"kind":"unavailable"}`) and prints
// `<mode>\t<contentSecurityPolicy value>` to stdout.
import { readFileSync } from 'node:fs';
import { renderEdgeSiteBlock, CURRENT_SCHEMA_VERSION } from '../../render-core/dist/index.js';

const themeCspJson = readFileSync(0, 'utf-8').trim();
const themeCsp = JSON.parse(themeCspJson);

// A minimal, valid entry-tenant-shaped descriptor -- only the fields
// renderEdgeSiteBlock actually reads (kind, siteUrl, hostname, gate).
const descriptor = {
  version: CURRENT_SCHEMA_VERSION,
  kind: 'tenant',
  siteUrl: 'https://csp-proof.platform-domain.example.test',
  hostname: { kind: 'ours', sub: 'csp-proof', gated: false },
  gate: { kind: 'none' },
};
const zones = {
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['platform-domain.example.test'],
};
const limits = {
  tmpfsSize: '128m',
  themeCompressedBytes: 1,
  themeEntryUncompressedBytes: 1,
  themeTotalUncompressedBytes: 1,
  edgeRequestBodyMaxSize: '64MiB',
  memoryLimit: '640m',
};

// The payments allowance, rendered by the same function: CSP_PAYMENTS=stripe
// (the checkout gate's policy) or unset/none (everything else, byte-identical
// to before payments existed). Anything else is a typo that must not quietly
// fall back to "none" and prove the wrong policy.
const paymentsKind = process.env.CSP_PAYMENTS || 'none';
if (paymentsKind !== 'stripe' && paymentsKind !== 'none') {
  console.error(`render-header: CSP_PAYMENTS must be "stripe" or "none", got "${paymentsKind}"`);
  process.exit(2);
}

const edge = renderEdgeSiteBlock(descriptor, zones, limits, themeCsp, { kind: paymentsKind });
process.stdout.write(`${edge.contentSecurityPolicyMode}\t${edge.contentSecurityPolicy}\n`);
