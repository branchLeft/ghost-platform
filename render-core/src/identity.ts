/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it — a **new** artefact per LLD-1 §04.
 *
 * Ported in spirit from `infra/tenant/index.ts`'s `GhostTenantIdentity`
 * (there, read by `scripts/assert-no-tenant-deletes.py` out of the Pulumi
 * component's own preview state): rename the content volume and the
 * tenant's themes, settings and generated assets are orphaned on the host
 * under the old name; change the UID and the tenant loses access to its own
 * `0700` volume; change the database name and Ghost boots against an empty
 * schema. Rendered here as a plain artefact rather than a Pulumi output so
 * the same identity a delete guard can diff is available to a reconciler
 * that never touches Pulumi at all (the broker).
 *
 * `maxUserConnections` is not carried: it lived on the old component's
 * `GhostTenantArgs`, not on anything `TenantDescriptor` carries today, and
 * fabricating a value here would be a config surface this schema does not
 * yet expose. A consumer that needs it still has `db/provision`'s own
 * default.
 */

import type { Slug, TenantUid } from './brand.js';
import type { DatabaseSpec, MediaSpec, TenantDescriptor } from './descriptor.js';
import { mediaBucketName, validateMediaBucket } from './media.js';
import { adaptersVolumeName, contentVolumeName, databaseAndUserName, stackName } from './naming.js';

export interface TenantIdentity {
  readonly slug: Slug;
  readonly uid: TenantUid;
  readonly stackName: string;
  /** The Docker volume holding Ghost's own content directory — themes,
   * settings snapshots, generated image derivatives. Present for every
   * kind: this is not the media-storage backend (`media`, below). */
  readonly contentVolume: string;
  readonly adaptersVolume: string;
  readonly appHostPrivateIp: string;
  /** `null` for a `sqlite` descriptor: there is no separate database name
   * to orphan, only the file at `database.path`. */
  readonly databaseName: string | null;
  /** `null` for a `local` descriptor: there is no bucket to orphan. */
  readonly mediaBucket: string | null;
}

function databaseIdentity(slug: Slug, database: DatabaseSpec): string | null {
  return database.kind === 'mysql' ? databaseAndUserName(slug) : null;
}

function mediaIdentity(slug: Slug, media: MediaSpec): string | null {
  if (media.kind !== 's3') return null;
  validateMediaBucket(slug, media);
  return mediaBucketName(slug);
}

export function renderIdentity(
  descriptor: Pick<TenantDescriptor, 'slug' | 'uid' | 'appHostIp' | 'database' | 'media'>
): TenantIdentity {
  return {
    slug: descriptor.slug,
    uid: descriptor.uid,
    stackName: stackName(descriptor.slug),
    contentVolume: contentVolumeName(descriptor.slug),
    adaptersVolume: adaptersVolumeName(descriptor.slug),
    appHostPrivateIp: descriptor.appHostIp,
    databaseName: databaseIdentity(descriptor.slug, descriptor.database),
    mediaBucket: mediaIdentity(descriptor.slug, descriptor.media),
  };
}
