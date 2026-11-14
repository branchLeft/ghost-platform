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
  validateTenantStack,
  type Artefact,
  type TenantStackDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';

export interface GhostTenantArgs {
  /** The paying tenant's descriptor, as the render core defines it, without
   * `ownerEmail`: that reaches the host in the secrets file. A demo descriptor
   * is refused: demos are reconciled by the broker. */
  descriptor: TenantStackDescriptor;
  /** The zones `validateTenantStack()` and `render()` check hostnames and mail against. */
  zones: ZoneConfig;
  /** Applied on `db1` by the provisioning script; recorded in the identity so
   * the tenant's configured cap is visible in its own stack. Defaults to 10. */
  maxUserConnections?: number;
}

/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it, read by `scripts/assert-no-tenant-deletes.py` out of the
 * component's own preview state. See index.md#ghosttenantidentity.
 * `maxUserConnections` is not one of them: a raised cap is a safe reapply
 * (db/provision/provision_tenant_db.md, Overview section).
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
 * One paying Ghost tenant on a shared app host. Every artefact comes from the
 * render core's `render(descriptor)`; this component validates, registers
 * and exposes them. It holds no secret value and exposes none: the secrets
 * file is rendered on the host. It declares no cloud resources.
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
  /** The render core's `secrets.env` text: key names with empty values, never
   * a value. The host fills it; see `app/provision/render_tenant_secrets.py`. */
  public readonly secretsEnvTemplate: string;
  /** The `KEY` names `secretsEnvTemplate` lists, in its order. */
  public readonly secretKeys: string[];
  /** See `GhostTenantIdentity`. */
  public readonly identity: pulumi.Output<GhostTenantIdentity>;

  constructor(name: string, args: GhostTenantArgs, opts?: pulumi.ComponentResourceOptions) {
    // Everything that can refuse runs before super(), so an invalid
    // descriptor never reaches the engine. See index.md#constructor-order.
    // A removed argument is refused, never dropped, and never echoed.
    if ('secrets' in (args as unknown as Record<string, unknown>)) {
      throw new Error(
        'GhostTenant: the "secrets" argument was removed in 8.0.0. A tenant stack holds no ' +
          'secret value; the host renders the secrets file. See index.md#secrets-on-the-host.'
      );
    }
    if (args.descriptor.kind !== 'tenant') {
      throw new Error(
        `GhostTenant: descriptor.kind must be "tenant", got "${args.descriptor.kind}". A demo ` +
          `is reconciled by the broker, never by this component.`
      );
    }
    // Render core's claim rule is the only one: a registered tenant name is taken
    // only from its own repository, which Actions reports in GITHUB_REPOSITORY.
    // With the variable unset (a local run) render core refuses a registered
    // name, so this fails closed. See naming.md#the-tenant-name-claim.
    const descriptor = validateTenantStack(args.descriptor, args.zones, {
      claimantRepo: process.env['GITHUB_REPOSITORY'],
    });
    const artefacts = render(descriptor, args.zones);
    const slug = descriptor.slug;

    const secretsTemplate = artefactContent(artefacts, 'secrets.env');
    const secretKeys = requiredSecretKeys(secretsTemplate);

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

    this.secretsEnvTemplate = secretsTemplate;
    this.secretKeys = secretKeys;

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
      secretsEnvTemplate: this.secretsEnvTemplate,
      secretKeys: this.secretKeys,
    });
  }
}

export type {
  Artefact,
  TenantDescriptor,
  TenantStackDescriptor,
  ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
export { SECRET_ENV_KEYS };
export { MEDIA_BUCKET_PREFIX, mediaBucketName, mediaPublicBaseUrl } from './media';
export {
  MAX_TENANT_SLUG_LENGTH,
  RESERVED_STACK_NAMES,
  TENANT_NAMES,
  TENANT_NAME_REGISTER,
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
export type { RegisteredName } from './naming';
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
