import * as pulumi from '@pulumi/pulumi';
import {
  SECRET_ENV_KEYS,
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  mediaBucketName,
  mediaPublicBaseUrl,
  render,
  secretsEnvPath,
  stackDirectory,
  stackName,
  validate,
  type Artefact,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';

/**
 * The secret values this tenant's `/etc/branchleft/<slug>.env` carries. The
 * descriptor holds no secret by design, so they arrive here, beside it. Which
 * of them are required is decided by the render core's `secrets.env`
 * template, never by this component. See index.md#ghosttenantsecrets.
 */
export interface GhostTenantSecrets {
  /** The password `db/provision/provision_tenant_db.py` printed once. */
  databasePassword?: pulumi.Input<string>;
  /** This tenant's Object Storage key pair, allowlisted to its own bucket. */
  s3AccessKeyId?: pulumi.Input<string>;
  s3SecretAccessKey?: pulumi.Input<string>;
  /** The SMTP submission password, for an `smtp` transport. */
  mailPassword?: pulumi.Input<string>;
  /** The bulk-mail API key, when the descriptor enables mail. */
  bulkEmailApiKey?: pulumi.Input<string>;
}

export interface GhostTenantArgs {
  /** The paying tenant's descriptor, as the render core defines it. A demo
   * descriptor is refused: demos are reconciled by the broker. */
  descriptor: TenantDescriptor;
  /** The zones `validate()` and `render()` check hostnames and mail against. */
  zones: ZoneConfig;
  secrets: GhostTenantSecrets;
  /** Applied on `db1` by the provisioning script; recorded in the identity so
   * the tenant's configured cap is visible in its own stack. Defaults to 10. */
  maxUserConnections?: number;
}

/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it, read by `scripts/assert-no-tenant-deletes.py` out of the
 * component's own preview state. See index.md#ghosttenantidentity.
 */
export interface GhostTenantIdentity {
  slug: string;
  uid: number;
  stackName: string;
  contentVolume: string;
  adaptersVolume: string;
  databaseName: string;
  appHostPrivateIp: string;
  maxUserConnections: number;
}

const DEFAULT_MAX_USER_CONNECTIONS = 10;

type SecretField = keyof typeof SECRET_ENV_KEYS;

/** The `GhostTenantSecrets` field each secrets-file key is filled from. */
const SECRET_FIELD_BY_KEY = new Map<string, SecretField>(
  (Object.entries(SECRET_ENV_KEYS) as [SecretField, string][]).map(([field, key]) => [key, field])
);

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const TEMPLATE_KEY_LINE = /^([A-Z][A-Z0-9_]*)=$/;

function artefactContent(artefacts: readonly Artefact[], path: string): string {
  const found = artefacts.find((artefact) => artefact.path === path);
  if (found === undefined) {
    throw new Error(`GhostTenant: render() returned no ${path} artefact.`);
  }
  return found.content;
}

/** The secrets-file keys the render core's template names, in its order. */
export function requiredSecretKeys(template: string): string[] {
  return template
    .split('\n')
    .map((line) => TEMPLATE_KEY_LINE.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

/**
 * Refuses, before anything is registered, a secret the template needs but was
 * not supplied, and a secret supplied that the template does not name. See
 * index.md#secret-coverage.
 */
export function assertSecretCoverage(
  slug: string,
  required: readonly string[],
  secrets: GhostTenantSecrets
): void {
  for (const key of required) {
    const field = SECRET_FIELD_BY_KEY.get(key);
    if (field === undefined) {
      throw new Error(
        `GhostTenant: the render core names a secret "${key}" for "${slug}" that this component ` +
          `has no input for.`
      );
    }
    if (secrets[field] === undefined) {
      throw new Error(`GhostTenant: "${slug}" needs secrets.${field} (${key}); none was supplied.`);
    }
  }
  for (const [field, value] of Object.entries(secrets) as [SecretField, unknown][]) {
    if (value !== undefined && !required.includes(SECRET_ENV_KEYS[field])) {
      throw new Error(
        `GhostTenant: secrets.${field} was supplied for "${slug}", but its descriptor needs no ` +
          `such secret. Refused rather than dropped, so a configuration mismatch is visible.`
      );
    }
  }
}

/**
 * Fills each `KEY=` line of the render core's template with its value and
 * leaves every other line exactly as rendered. See
 * index.md#filling-the-secrets-file.
 */
export function fillSecretsTemplate(
  slug: string,
  template: string,
  values: ReadonlyMap<string, string>
): string {
  return template
    .split('\n')
    .map((line) => {
      const key = TEMPLATE_KEY_LINE.exec(line)?.[1];
      if (key === undefined) {
        return line;
      }
      const value = values.get(key);
      if (value === undefined) {
        throw new Error(`GhostTenant: no value for ${key} in the secrets file for "${slug}".`);
      }
      if (CONTROL_CHARACTER.test(value)) {
        throw new Error(
          `GhostTenant: the ${key} for "${slug}" contains a control character. A newline in an ` +
            `EnvironmentFile value adds a line rather than breaking one, so it can set any ` +
            `variable in the container's environment.`
        );
      }
      return `${key}=${value}`;
    })
    .join('\n');
}

/**
 * One paying Ghost tenant on a shared app host. Every artefact comes from the
 * render core's `render(descriptor)`; this component validates, registers
 * and exposes them, and fills the secrets file with the values the
 * descriptor never carries. It declares no cloud resources.
 * See index.md#ghosttenant.
 */
export class GhostTenant extends pulumi.ComponentResource {
  public readonly slug: string;
  public readonly uid: number;
  /** Compose project, systemd instance and `/opt/branchleft` directory name. */
  public readonly stackName: string;
  public readonly stackDirectory: string;
  public readonly composeUnit: string;
  public readonly secretsEnvPath: string;
  public readonly imageEnvPath: string;
  public readonly contentVolume: string;
  public readonly adaptersVolume: string;
  public readonly databaseName: string;
  public readonly databaseUser: string;
  /** This tenant's own Object Storage bucket. Nothing here creates it. */
  public readonly mediaBucket: string;
  /** `<endpoint>/<bucket>`, what Ghost writes into every published post. */
  public readonly mediaPublicBaseUrl: string;
  /** The rendered `compose.yml` for `/opt/branchleft/<slug>/`. */
  public readonly composeFile: string;
  /** The rendered `/etc/branchleft/<slug>.image.env`. */
  public readonly imageEnvFile: string;
  /** The rendered root-run script that creates this tenant's volumes. */
  public readonly provisionScript: string;
  /** The rendered edge site block, as JSON. */
  public readonly edgeSiteBlock: string;
  /** The edge site block's `request_body max_size`, read out of it. */
  public readonly edgeRequestBodyMaxSize: string;
  /** The rendered Ghost settings document, as JSON. */
  public readonly ghostSettings: string;
  /** The exact content of `/etc/branchleft/<slug>.env`. A Pulumi secret. */
  public readonly secretsEnvFile: pulumi.Output<string>;
  /** See `GhostTenantIdentity`. */
  public readonly identity: pulumi.Output<GhostTenantIdentity>;

  constructor(name: string, args: GhostTenantArgs, opts?: pulumi.ComponentResourceOptions) {
    // Everything that can refuse runs before super(), so an invalid
    // descriptor never reaches the engine. See index.md#constructor-order.
    if (args.descriptor.kind !== 'tenant') {
      throw new Error(
        `GhostTenant: descriptor.kind must be "tenant", got "${args.descriptor.kind}". A demo ` +
          `is reconciled by the broker, never by this component.`
      );
    }
    const descriptor = validate(args.descriptor, args.zones);
    const artefacts = render(descriptor, args.zones);
    const slug = descriptor.slug;

    const secretsTemplate = artefactContent(artefacts, 'secrets.env');
    const required = requiredSecretKeys(secretsTemplate);
    assertSecretCoverage(slug, required, args.secrets);

    const rendered = JSON.parse(artefactContent(artefacts, 'identity.json')) as Omit<
      GhostTenantIdentity,
      'maxUserConnections'
    >;
    // See index.md#constructor-identity-object.
    const identity: GhostTenantIdentity = {
      slug: rendered.slug,
      uid: rendered.uid,
      stackName: rendered.stackName,
      contentVolume: rendered.contentVolume,
      adaptersVolume: rendered.adaptersVolume,
      databaseName: rendered.databaseName,
      appHostPrivateIp: rendered.appHostPrivateIp,
      maxUserConnections: args.maxUserConnections ?? DEFAULT_MAX_USER_CONNECTIONS,
    };

    super('ghostPlatform:tenant:GhostTenant', name, { identity }, opts);

    const edge = artefactContent(artefacts, 'edge.json');

    this.slug = slug;
    this.uid = descriptor.uid;
    this.stackName = stackName(slug);
    this.stackDirectory = stackDirectory(slug);
    this.composeUnit = composeUnitName(slug);
    this.secretsEnvPath = secretsEnvPath(slug);
    this.imageEnvPath = imageEnvPath(slug);
    this.contentVolume = contentVolumeName(slug);
    this.adaptersVolume = adaptersVolumeName(slug);
    this.databaseName = databaseAndUserName(slug);
    this.databaseUser = this.databaseName;
    this.mediaBucket = mediaBucketName(slug);
    this.mediaPublicBaseUrl =
      descriptor.media.kind === 's3' ? mediaPublicBaseUrl(descriptor.media.endpoint, slug) : '';
    this.composeFile = artefactContent(artefacts, 'compose.yml');
    this.imageEnvFile = artefactContent(artefacts, 'image.env');
    this.provisionScript = artefactContent(artefacts, 'provision.sh');
    this.edgeSiteBlock = edge;
    this.edgeRequestBodyMaxSize = (
      JSON.parse(edge) as { requestBodyMaxSize: string }
    ).requestBodyMaxSize;
    this.ghostSettings = artefactContent(artefacts, 'ghost-settings.json');

    const values = required.map((key) =>
      pulumi.output(
        args.secrets[SECRET_FIELD_BY_KEY.get(key) as SecretField] as pulumi.Input<string>
      )
    );
    this.secretsEnvFile = pulumi.secret(
      pulumi
        .all(values)
        .apply((resolved) =>
          fillSecretsTemplate(
            slug,
            secretsTemplate,
            new Map(required.map((key, index) => [key, resolved[index]]))
          )
        )
    );

    this.identity = pulumi.output(identity);

    this.registerOutputs({
      identity: this.identity,
      composeFile: this.composeFile,
      composeUnit: this.composeUnit,
      stackDirectory: this.stackDirectory,
      secretsEnvPath: this.secretsEnvPath,
      imageEnvPath: this.imageEnvPath,
      imageEnvFile: this.imageEnvFile,
      provisionScript: this.provisionScript,
      edgeSiteBlock: this.edgeSiteBlock,
      edgeRequestBodyMaxSize: this.edgeRequestBodyMaxSize,
      ghostSettings: this.ghostSettings,
      mediaBucket: this.mediaBucket,
      mediaPublicBaseUrl: this.mediaPublicBaseUrl,
      secretsEnvFile: this.secretsEnvFile,
    });
  }
}

export type {
  Artefact,
  TenantDescriptor,
  ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
export { SECRET_ENV_KEYS };
export { MEDIA_BUCKET_PREFIX, mediaBucketName, mediaPublicBaseUrl } from './media';
export {
  MAX_TENANT_SLUG_LENGTH,
  RESERVED_STACK_NAMES,
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
  validateTenantSlug,
} from './naming';
export {
  DEFAULT_RESOURCE_CAPS,
  DEFAULT_RSS_BUDGET_MIB,
  DEFAULT_UPLOAD_CEILING_MIB,
  TENANT_UID_MAX,
  TENANT_UID_MIN,
  uploadLimits,
  validateTenantUid,
} from './runtime';
export type { ResourceCaps, UploadLimits } from './runtime';
