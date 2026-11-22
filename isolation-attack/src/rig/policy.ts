// The content policy the edge serves, rendered by render-core's own
// `renderEdgeSiteBlock` from the script hashes derived off the tenant's clean
// pages, exactly as the shipped path does. Never a policy written here.

import { renderEdgeSiteBlock } from '../../../render-core/src/edge.ts';
import { deriveThemeCsp } from '../../../csp/derive/derive-script-hashes.mjs';
import { fetchLike } from '../http.ts';

type Descriptor = Parameters<typeof renderEdgeSiteBlock>[0];
type Zones = Parameters<typeof renderEdgeSiteBlock>[1];
type Limits = Parameters<typeof renderEdgeSiteBlock>[2];
type ThemeCsp = Parameters<typeof renderEdgeSiteBlock>[3];

// Only the fields renderEdgeSiteBlock reads; the zone and limits are placeholders
// it never emits into the policy.
const DESCRIPTOR = {
  kind: 'tenant',
  siteUrl: 'https://isolation-attack.platform-domain.example.test',
  hostname: { kind: 'ours', sub: 'isolation-attack', gated: false },
  gate: { kind: 'none' },
} as unknown as Descriptor;

const ZONES = {
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['platform-domain.example.test'],
} as unknown as Zones;

const LIMITS = {
  tmpfsSize: '128m',
  themeCompressedBytes: 1,
  themeEntryUncompressedBytes: 1,
  themeTotalUncompressedBytes: 1,
  edgeRequestBodyMaxSize: '64MiB',
  memoryLimit: '640m',
} as unknown as Limits;

export interface RenderedPolicy {
  readonly mode: 'enforcing' | 'report-only';
  readonly value: string;
}

export function renderPolicy(themeCsp: ThemeCsp): RenderedPolicy {
  const edge = renderEdgeSiteBlock(DESCRIPTOR, ZONES, LIMITS, themeCsp);
  return { mode: edge.contentSecurityPolicyMode, value: edge.contentSecurityPolicy };
}

/** Derives the hash set from a running tenant's clean pages and renders the enforcing policy. */
export async function derivePolicy(
  origin: string,
  paths: readonly string[]
): Promise<RenderedPolicy> {
  const derived = await deriveThemeCsp(origin, paths, fetchLike);
  if (derived.kind !== 'computed') {
    throw new Error(`the theme's script hashes could not be derived: ${derived.reason}`);
  }
  const policy = renderPolicy(derived as unknown as ThemeCsp);
  if (policy.mode !== 'enforcing') {
    throw new Error('the rendered policy is report-only: the control would not be under test');
  }
  return policy;
}
