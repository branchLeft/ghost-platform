/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it. Rendered as a plain artefact so a delete guard can diff it
 * without touching Pulumi. See identity.md#tenant-identity.
 */

import type { Slug, TenantUid } from './brand.js';
import type { DatabaseSpec, MediaSpec, TenantDescriptor } from './descriptor.js';
import {
  mediaBucketName,
  validateMediaBucket,
  validateMediaFolder,
  validateMediaShard,
} from './media.js';
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
  /** `null` for a `local` descriptor: there is no bucket to orphan. For a
   * `gateway` descriptor, the shared shard the tenant's folder is in. */
  readonly mediaBucket: string | null;
  /** Present only for a `gateway` descriptor: the tenant's folder. Changing
   * it orphans every object and every published media URL. See
   * identity.md#the-media-folder. */
  readonly mediaFolder?: string;
}

function databaseIdentity(slug: Slug, database: DatabaseSpec): string | null {
  return database.kind === 'mysql' ? databaseAndUserName(slug) : null;
}

function mediaIdentity(
  slug: Slug,
  media: MediaSpec
): Pick<TenantIdentity, 'mediaBucket' | 'mediaFolder'> {
  if (media.kind === 'local') return { mediaBucket: null };
  if (media.kind === 'gateway') {
    validateMediaShard(slug, media);
    validateMediaFolder(slug, media);
    return { mediaBucket: media.shard, mediaFolder: media.folder };
  }
  validateMediaBucket(slug, media);
  return { mediaBucket: mediaBucketName(slug) };
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
    ...mediaIdentity(descriptor.slug, descriptor.media),
  };
}
