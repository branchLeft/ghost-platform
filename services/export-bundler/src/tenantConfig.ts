import { execFile } from 'node:child_process';
import { assertAgeRecipient } from './ageEncryption.js';
import type { GrantLane } from './supportGrant.js';

/**
 * Everything that decides whose data is exported, as whom, and to which
 * key comes from the tenant's own rendered configuration, never from a
 * value the operator types.
 * See ../README.md#whose-data-as-whom-to-which-key-the-tenants-own-config.
 */

export class TenantConfigError extends Error {
  constructor(message: string) {
    super(`refused: ${message}; nothing was started`);
    this.name = 'TenantConfigError';
  }
}

export class RecipientMismatchError extends Error {
  constructor(of = "this tenant's backup.encryptionRecipient") {
    super(`refused: --age-recipient is not ${of}; nothing was started`);
    this.name = 'RecipientMismatchError';
  }
}

export const SUPPORT_IDENTITY_ENV = 'adapters__sso__BreakGlassSSO__supportIdentity';
export const BREAK_GLASS_TENANT_ENV = 'adapters__sso__BreakGlassSSO__tenant';
/** Both colours render the same environment; the export boots as colour a. */
export const SOURCE_SERVICE = 'ghost-a';

export interface TenantVolume {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface TenantRuntime {
  readonly stackName: string;
  readonly image: string;
  readonly user: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: readonly TenantVolume[];
  readonly supportIdentity: string;
}

export interface DescriptorFacts {
  readonly slug: string;
  /**
   * The descriptor's backup recipient. Null for `backup.kind: none`, which
   * every demo has: such an archive can be encrypted only to a recipient a
   * promotion supplies (`PromotionRecipient`).
   */
  readonly ageRecipient: string | null;
  /** Present once the descriptor carries a break-glass triple. */
  readonly supportIdentity: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TenantConfigError(`${where}.${key} is missing or not a string`);
  }
  return value;
}

/** The output of `docker compose config --format json` for the tenant's stack. */
export function parseComposeConfig(config: unknown): TenantRuntime {
  if (!isRecord(config)) throw new TenantConfigError('the compose config is not an object');
  const stackName = stringField(config, 'name', 'compose');
  const services = config.services;
  const service = isRecord(services) ? services[SOURCE_SERVICE] : undefined;
  if (!isRecord(service)) {
    throw new TenantConfigError(`the compose stack has no ${SOURCE_SERVICE} service`);
  }
  const image = stringField(service, 'image', SOURCE_SERVICE);
  const user = typeof service.user === 'string' && service.user.length > 0 ? service.user : null;

  const rawEnv = isRecord(service.environment) ? service.environment : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value === null || value === undefined) continue;
    env[key] = String(value);
  }

  const volumes: TenantVolume[] = [];
  for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
    if (!isRecord(entry) || entry.type !== 'volume') {
      throw new TenantConfigError(`${SOURCE_SERVICE} mounts something other than a named volume`);
    }
    volumes.push({
      source: stringField(entry, 'source', `${SOURCE_SERVICE}.volumes`),
      target: stringField(entry, 'target', `${SOURCE_SERVICE}.volumes`),
      readOnly: entry.read_only === true,
    });
  }
  if (volumes.length === 0) throw new TenantConfigError(`${SOURCE_SERVICE} mounts no volume`);

  const supportIdentity = env[SUPPORT_IDENTITY_ENV];
  if (!supportIdentity) {
    throw new TenantConfigError(
      `the tenant's rendered environment has no ${SUPPORT_IDENTITY_ENV}: break-glass is not configured for it`
    );
  }
  return { stackName, image, user, env, volumes, supportIdentity };
}

/** The fields of a tenant descriptor this package binds to. */
export function parseDescriptorFacts(descriptor: unknown): DescriptorFacts {
  if (!isRecord(descriptor)) throw new TenantConfigError('the descriptor is not an object');
  const slug = stringField(descriptor, 'slug', 'descriptor');
  const backup = descriptor.backup;
  let ageRecipient: string | null = null;
  // Only an explicit `none` is a descriptor without a recipient; a missing or
  // unknown backup stays refused, so a malformed descriptor cannot fall
  // through to the promotion path.
  if (!isRecord(backup) || (backup.kind !== 'bucket-native' && backup.kind !== 'none')) {
    throw new TenantConfigError(
      "the descriptor's backup.kind is neither bucket-native nor none, so the tenant has no encryption recipient"
    );
  }
  if (backup.kind === 'bucket-native') {
    ageRecipient = stringField(backup, 'encryptionRecipient', 'descriptor.backup');
    try {
      assertAgeRecipient(ageRecipient);
    } catch {
      throw new TenantConfigError(
        "the descriptor's backup.encryptionRecipient is not an age recipient"
      );
    }
  }
  let supportIdentity: string | null = null;
  const breakGlass = descriptor.breakGlass;
  if (isRecord(breakGlass) && breakGlass.kind === 'enabled') {
    supportIdentity = stringField(breakGlass, 'supportIdentity', 'descriptor.breakGlass');
  }
  return { slug, ageRecipient, supportIdentity };
}

/**
 * The public `age` recipient a promotion supplies for a demo, which has no
 * backup recipient of its own. The controller keeps the private half on
 * `ops1`; only this half reaches the demo host.
 */
export interface PromotionRecipient {
  readonly recipient: string;
  /** The grant lane the export runs under; a promotion's is always the consented one. */
  readonly grantLane: GrantLane;
}

/**
 * Cross-checks the descriptor, the rendered stack and the operator's
 * stated recipient, and returns the one recipient the archive is encrypted to.
 *
 * That recipient is the descriptor's backup recipient, or, only for a
 * descriptor with none and only under a consented grant, the promotion's.
 * Never both, never neither, and always the one the operator stated.
 */
export function bindTenant(
  descriptor: DescriptorFacts,
  runtime: TenantRuntime,
  operatorRecipient: string,
  promotion: PromotionRecipient | null = null
): string {
  if (runtime.stackName !== descriptor.slug) {
    throw new TenantConfigError(
      `the compose stack is "${runtime.stackName}", not the descriptor's "${descriptor.slug}"`
    );
  }
  const adapterTenant = runtime.env[BREAK_GLASS_TENANT_ENV];
  if (adapterTenant !== descriptor.slug) {
    throw new TenantConfigError(
      `the rendered ${BREAK_GLASS_TENANT_ENV} does not name the descriptor's tenant`
    );
  }
  if (
    descriptor.supportIdentity !== null &&
    descriptor.supportIdentity !== runtime.supportIdentity
  ) {
    throw new TenantConfigError(
      "the rendered support identity is not the descriptor's breakGlass.supportIdentity"
    );
  }
  if (descriptor.ageRecipient === null) {
    if (promotion === null) {
      throw new TenantConfigError(
        'the descriptor has no backup recipient (backup.kind none) and no promotion recipient was given'
      );
    }
    if (promotion.grantLane !== 'consented') {
      throw new TenantConfigError(
        'a promotion recipient is accepted only under a consented support grant'
      );
    }
    try {
      assertAgeRecipient(promotion.recipient);
    } catch {
      // The value is not repeated: a private half pasted here must not reach a log.
      throw new TenantConfigError('the promotion recipient is not an age recipient');
    }
    if (operatorRecipient !== promotion.recipient) {
      throw new RecipientMismatchError("the promotion's recipient");
    }
    return promotion.recipient;
  }
  if (promotion !== null) {
    throw new TenantConfigError(
      "a promotion recipient is accepted only for a descriptor with no backup recipient; this tenant's own backup recipient is never replaced"
    );
  }
  if (operatorRecipient !== descriptor.ageRecipient) throw new RecipientMismatchError();
  return descriptor.ageRecipient;
}

export interface ComposeSource {
  readonly composeFile: string;
  readonly envFiles: readonly string[];
}

export function buildComposeConfigArgs(source: ComposeSource): readonly string[] {
  const args = ['compose', '-f', source.composeFile];
  for (const envFile of source.envFiles) args.push('--env-file', envFile);
  args.push('config', '--format', 'json');
  return args;
}

/**
 * Resolves the stack with Compose's own interpolation. The child gets PATH
 * only, so nothing from the operator's environment can fill a `${VAR}` the
 * tenant's own env files do not.
 */
export function loadComposeConfig(
  source: ComposeSource,
  dockerCommand = 'docker'
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerCommand,
      [...buildComposeConfigArgs(source)],
      { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new TenantConfigError(
              `docker compose config exited ${String(err.code)}: ${stderr.slice(0, 500)}`
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new TenantConfigError('docker compose config printed something other than JSON'));
        }
      }
    );
  });
}

/**
 * The base every one of this tenant's media URLs starts with, read from its
 * own rendered environment and never typed by the operator. Ghost's S3
 * storage serves `${cdnUrl}/${tenantPrefix}/...`, and on a shared shard the
 * prefix is the only thing that separates one tenant from the next, so the
 * scope is the media address plus the prefix whenever a prefix is set.
 * Returns null for a tenant with no object-storage media address.
 */
export function mediaBaseUrlOf(env: Readonly<Record<string, string>>): string | null {
  const cdnUrl = env.storage__images__wrappedConfig__cdnUrl ?? env.storage__images__cdnUrl;
  if (cdnUrl === undefined) return null;
  const prefix = (
    env.storage__images__wrappedConfig__tenantPrefix ??
    env.storage__images__tenantPrefix ??
    ''
  ).replace(/^\/+|\/+$/g, '');
  if (prefix === '') return cdnUrl;
  if (/[?#\\]|(^|\/)\.{1,2}(\/|$)|\/\//.test(prefix)) {
    throw new TenantConfigError('the rendered tenantPrefix is not a plain path');
  }
  return `${cdnUrl.replace(/\/+$/, '')}/${prefix}`;
}
