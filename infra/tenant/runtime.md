# runtime.ts

## DEFAULT_UPLOAD_CEILING_MIB

Default upload ceiling, in MiB. The single input every upload-related limit
below derives from.

It cannot be read off Ghost's own defaults: Ghost 6.55.0 accepts a 1 GiB
compressed theme expanding to 4 GiB, and its generic upload middleware
(`multer({dest: os.tmpdir()})`) carries no limit at all. Both stage bytes
in `/tmp`, which on a read-only rootfs is a tmpfs charged to the
container's memory cgroup — so Ghost's own limits are not a per-tenant
memory budget on a 4-8 GB host, and the platform imposes its own.

## edgeRequestBodyMaxSize

The tenant's Caddy `request_body max_size` at the edge, in Caddy's own
size syntax. The only limit that bounds the upload paths Ghost leaves
unlimited, and the only one that rejects an oversized body before it
reaches an app host at all.

`MiB`, not `MB`: Caddy reads `MB` as a power of ten and every other value
derived here is a power of two. The point of deriving them from one input
is that they cannot disagree, and a unit that means something else by
~4.4% is a disagreement.

## uploadLimits

Derives every upload-related limit from one ceiling.

The proportions, and why they are not all equal to the ceiling:

- Theme *extraction* happens in `/tmp`, and the compressed archive is still
  there while it expands — so the uncompressed total gets half the tmpfs and
  not all of it.
- The edge limit bounds a single request body. At half the ceiling two
  concurrent uploads still fit in `/tmp`; at the full ceiling one upload
  plus any concurrent theme extraction does not.
- Only `theme__uploadLimits__*` can bound extraction, because they are what
  Ghost hands to `gscan.checkZip`; a proxy in front cannot see how far a
  compressed archive expands. Only the edge limit can bound the image,
  media, file and content-import paths, because Ghost sets no limit on
  those at all. Neither one substitutes for the other, which is why both
  are set.
