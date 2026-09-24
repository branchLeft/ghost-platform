/**
 * The descriptor-to-artefacts step LLD-2 §03 calls "render" — pure and
 * total: same seven artefacts, from the same functions, for every kind and
 * both reconcilers (LLD-1 §02, "the pure core, unchanged in both, extended
 * in §04"). `render()` performs no I/O — see `test/render.test.ts`'s own
 * no-I/O assertion, and `test/dependency-closure.test.ts`, which already
 * refuses any import of a Node built-in (`node:fs`, `node:http`, …) as a
 * bare specifier leaving the package, so an I/O call could not be added
 * here without failing that test first.
 *
 * **No secret ever appears in an artefact.** `render()`'s own parameter is
 * a `TenantDescriptor`, which carries no secret field to begin with — the
 * schema's only credential-shaped values (`gate.argon2idHash`,
 * `backup.encryptionRecipient`) are not secrets by the estate's own
 * definition (a hash and a public age recipient) — so every place a real
 * secret belongs is rendered as a `${VAR:?…}` reference into a file this
 * package never touches (`environment.ts`) or as a blank key name in a
 * template an operator fills in by hand (`secrets.env` below, from
 * `renderSecretsTemplate`).
 *
 * **The seven artefacts, mapped from LLD-1 §04's diagram:**
 *
 * 1. `compose.yml` — `compose.ts`
 * 2. `secrets.env` — the *names* this kind needs in
 *    `/etc/branchleft/<slug>.env`, never their values (LLD-1's `<slug>.env`
 *    box)
 * 3. `image.env` — the digest-pinned image reference (LLD-1's
 *    `<slug>.image.env` box; today rendered by `branchleft-deploy`, not by
 *    this component — folded in here because nothing about the value is
 *    secret and a reconciler that already writes six artefacts should not
 *    have to special-case the seventh out of band)
 * 4. `provision.sh` — the host commands LLD-1's diagram shows as a fourth
 *    box beside the three file artefacts above (volume creation)
 * 5. `edge.json` — `edge.ts`, **new**
 * 6. `ghost-settings.json` — `settings.ts`, **new**
 * 7. `identity.json` — `identity.ts`, **new**
 *
 * **Known Done-criterion conflict, not resolved here — see the PR body.**
 * The story's own Done means says tenant zero's rendered Compose and
 * environment are byte-identical to what `infra/tenant` renders today.
 * `compose.ts`'s own doc comment explains why that cannot hold at the same
 * time as LLD-1 §03b's ruling that blue/green applies "everywhere, demos
 * included": today's renderer emits one service on one port; this one
 * necessarily emits two. The environment *values* this module renders are
 * unchanged for a `mysql`/`s3` tenant; the Compose *document* is not.
 */

import { validatePort, validatePrivateIpV4, validateTenantUid } from './brand.js';
import { renderComposeStack } from './compose.js';
import type { TenantDescriptor } from './descriptor.js';
import { renderEdgeSiteBlock } from './edge.js';
import { tenantEnvironment, SECRET_ENV_KEYS } from './environment.js';
import { renderIdentity } from './identity.js';
import { imageEnvPath, secretsEnvPath, stackName } from './naming.js';
import { uploadLimits } from './runtime.js';
import { renderSettings } from './settings.js';
import type { ZoneConfig } from './validate.js';

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

function renderImageEnv(descriptor: TenantDescriptor): string {
  return `IMAGE=${descriptor.image}\n`;
}

/**
 * The exact root-run command that must create this tenant's two volumes,
 * owned to its uid, before its unit can start — ported from
 * `infra/tenant/index.ts`'s `hostProvisioningCommand`.
 */
function renderProvisionScript(descriptor: TenantDescriptor): string {
  return (
    [
      '#!/bin/sh',
      `# Provisions ${descriptor.slug}'s two named volumes before ${stackName(descriptor.slug)}'s`,
      '# unit is enabled. Idempotent; safe to re-run.',
      `set -eu`,
      `provision_tenant_volume.py --uid ${descriptor.uid} ${descriptor.slug}`,
    ].join('\n') + '\n'
  );
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Re-checks the three fields the broker's own reconcile handler already
 * guards before calling a `Renderer` (`slotAllocation` — LLD-2 §01,
 * load-bearing: "no port to pick, no uid to compute"), so this function is
 * still safe to call directly, outside that handler, by a caller with no
 * slot-allocation check of its own (the Pulumi component, a test, a
 * descriptor rendered for review). It asserts *shape*, never a value this
 * module could not know is correct — allocating the right uid/port for a
 * given slot is the caller's job, not this one's; see `compose.ts`'s own
 * comment on why the descriptor's own fields are the only source render()
 * ever reads a uid or a port from.
 */
function assertAllocationShape(descriptor: TenantDescriptor): void {
  validateTenantUid(descriptor.uid);
  validatePort(descriptor.ports.a, 'ports.a');
  validatePort(descriptor.ports.b, 'ports.b');
  validatePort(descriptor.ports.health, 'ports.health');
  validatePrivateIpV4(descriptor.appHostIp);
}

/**
 * `descriptor` must already have passed `validate()` — `render()` does not
 * re-run it (that would make every call two passes over the same
 * cross-field rules) but does re-check the handful of per-field shapes it
 * reads directly, via `assertAllocationShape`, so a caller that skipped
 * `validate()` gets a named refusal here rather than a malformed artefact.
 *
 * Returns the seven artefacts directly — the shape `services/broker/src/
 * render.ts`'s `Renderer.render()` seam expects, and what the story's own
 * Done means names: "`render(descriptor)` returns all seven artefacts".
 * `renderEdgeSiteBlock`/`renderSettings`/`renderIdentity` stay separately
 * exported for a caller (a test, a future reconciler) that wants one
 * artefact's typed value rather than re-parsing it back out of `content`.
 */
export function render(descriptor: TenantDescriptor, zones: ZoneConfig): readonly Artefact[] {
  assertAllocationShape(descriptor);

  const limits = uploadLimits();
  const environment = tenantEnvironment(descriptor, limits, secretsEnvPath(descriptor.slug));
  const compose = renderComposeStack({
    slug: descriptor.slug,
    uid: descriptor.uid,
    appHostPrivateIp: descriptor.appHostIp,
    ports: descriptor.ports,
    environment,
    limits,
    caps: descriptor.caps,
  });
  const edge = renderEdgeSiteBlock(descriptor, zones, limits);
  const settings = renderSettings(descriptor);
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
export type { EdgeGate, EdgeSiteBlock } from './edge.js';
export type { GhostSettings, CodeInjectionSettings, HostLimitsSettings } from './settings.js';
export type { TenantIdentity } from './identity.js';
