# ghost_import_probe.py

Measures, against the built Ghost image, what Ghost's own zip import does with a
demo-shaped site when the tenant's storage is the scanning decorator over the S3
adapter. It answers the "What is not verified" rows of the demo-to-paid
promotion design that name this probe, and prints the answers as one report.

```
python3 adapters/scanning-storage/probe/ghost_import_probe.py --image ghost-platform:ci
```

Options: `--max-zip-mib N` (largest padding the size ladder uploads, default 256),
`--report FILE` (also write the report there), `--sabotage empty-control-list`
(run the control with nothing on the hash list, which must fail). Under GitHub
Actions the report is also appended to the job summary.

## What it runs

One Ghost at a time. The tenant's Ghost runs beside the recording S3 double
(`test/helpers/recording-s3-double.cjs`), because the double is the storage the
tenant writes to.

1. **Demo.** A Ghost whose three storage features are the scanning decorator
   over local storage. The probe uploads 22 images, a media file and a file
   through it, references them from every place the report lists (the post's
   lexical body and rendered html, the three post image fields, a tag, the
   author, the settings, a newsletter), takes Ghost's own content export and
   copies the served media tree out with `docker cp`. The container is then
   removed.
2. **The zip.** The export JSON and the media tree, packed as Ghost's own import
   reads them. The probe adds three staff users (Administrator, Editor, Author),
   a post authored by the editor, a second author on the main post, and a post
   referring to `my photo (1).JPG`, a name with regular-expression characters.
   A demo cannot be made to hold these through the Admin API.
3. **Control.** A tenant Ghost (decorator over S3, a tenant prefix, a media
   address as `cdnUrl`) with one image of the zip on the images hash list. The
   import must fail. With `--sabotage empty-control-list` the list is empty, the
   import completes and the probe exits non-zero.
4. **Measure.** The same tenant with an empty list. The import must complete.
   The tenant's own export is read back, and every reference is classified.
5. **Size.** Zips of rising size (an unreferenced `padding.bin` of random bytes
   beside a one-post export) are uploaded at 1, 4, 16, ... MiB until Ghost
   refuses one or the cap is reached.

## How a reference is classified

Each field class names a unique file stem. The probe finds the address that
holds it in the tenant's export, and reports one of:

- rewritten to the media address plus the tenant prefix;
- site-relative `__GHOST_URL__/content/...` with the name replaced (the import
  renamed the file and wrote the new name);
- site-relative with the demo's name (the import did not touch it);
- left naming the demo's hostname;
- absent.

The "Object" column says whether a stored object sits at the key the reference
reaches: directly, or through the S3 adapter's redirect of a site-relative
`/content/...` path to the media address.

## What fails the run

The findings are not assertions: a reference Ghost leaves is a row in the table.
The run fails when the probe cannot stand: the clean import does not complete,
the control import is not refused, or a container, network or volume labelled
`branchleft.component=ghost-import-probe` is left behind.

## Maintenance

`DEMO_HOST`, `MEDIA_ADDRESS` and `TENANT_PREFIX` in `probe_model.py` are
fixtures. The decorator is configured exactly as a tenant is, apart from the
files store's `tier`, which must take video because Ghost's zip import also
offers a media file to the files store (its extension list holds `.mp4`).
Run `python3 -m unittest discover -s adapters/scanning-storage/probe` for the
pure parts.
