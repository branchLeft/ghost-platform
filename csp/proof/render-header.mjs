#!/usr/bin/env node
// Renders the real CSP header value and mode through render-core's own
// built `renderEdgeSiteBlock` -- never a re-implementation -- for the live
// proof to hand to Caddy. Reads the derived `ThemeCsp` as JSON from stdin
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

const edge = renderEdgeSiteBlock(descriptor, zones, limits, themeCsp);
process.stdout.write(`${edge.contentSecurityPolicyMode}\t${edge.contentSecurityPolicy}\n`);
