# content-type.js

## What it fixes

Ghost 6.55.0's `S3Storage.save()` sends `ContentType: file.type`, but
`S3Storage.saveRaw(buffer, targetPath)` takes no type and sends none, so the
bucket stores `application/octet-stream` and a browser will not draw the object
as an image. `saveRaw` is the path of every on-demand resized derivative (a
favicon's `size/w256h256/format/jpeg/` object), of every held upload when its
verdict clears and it is promoted, and of every same-name overwrite. A `save()`
whose file names no type is stored untyped the same way.

## What it does

`stampImageContentType(wrapped)` runs once, in the decorator's constructor. It
wraps `wrapped.client.send` so that a `PutObject` whose input has a whole-buffer
`Body`, a `Key` and no `ContentType` gets one from
`sniffImageContentType(Body)`. The type is read from the bytes only; a name, a
path or a type the uploader declared is never an input.

| Bytes | Type |
|---|---|
| JPEG, PNG, GIF (`GIF87a`, `GIF89a`) | `image/jpeg`, `image/png`, `image/gif` |
| WebP (`RIFF` ... `WEBP`) | `image/webp` |
| AVIF (`ftyp` with brand `avif` or `avis`) | `image/avif` |
| ICO (reserved word, type 1, at least one entry that fits) | `image/x-icon` |

## Rulings in the code

- **Anything else is left alone.** SVG can carry script, so it is never given
  an image type; HTML, text and unrecognised bytes keep the bucket default.
- **A type already named wins.** The stamp fills a gap and never overrides.
- **Multipart parts are skipped.** A part carries an `UploadId` and
  `PartNumber`; the create call that opened the upload sets its own type.
- **No client, no stamp.** The local adapters have no S3 client; their files are
  typed by the web server and `stampImageContentType` answers `false`. On the
  `S3Storage` tier a `false` is logged as `CONTENT_TYPE_STAMP_UNAVAILABLE`,
  because a Ghost change that renames the client would otherwise go back to
  untyped objects with nothing failing.

## What it does not do

- It does not repair objects already stored without a type. Each needs an
  S3 `CopyObject` of the key onto itself with `MetadataDirective=REPLACE` and
  the right `ContentType`, or a re-upload, by an operator holding the media
  bucket's write credential.
- It does not decide whether bytes are safe. The scan runs before the write.
