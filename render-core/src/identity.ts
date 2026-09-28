/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it. Rendered as a plain artefact so a delete guard can diff it
 * without touching Pulumi. See identity.md#tenant-identity.
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
