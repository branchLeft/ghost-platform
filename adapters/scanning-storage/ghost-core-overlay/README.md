# Ghost core overlay: theme-storage.js

Why a theme upload needs a gate of its own, and what it does, is in the
decorator's README under "Theme uploads". This directory is the one Ghost-core
seam that gate needs.

## What it is

Ghost's `core/server/services/themes/theme-storage.js` is the class that copies
an extracted theme into the served themes directory. Ghost constructs it
itself, so no adapter setting reaches it. The root `Dockerfile`:

1. checks the file at that path against `theme-storage.upstream.sha256`, and
   fails the build on a mismatch;
2. renames it to `theme-storage.upstream.js`;
3. copies this directory's `theme-storage.js` to the original path.

`theme-storage.js` here is a shim: it requires the renamed upstream class and
hands it to `defineGatedThemeStorage` (`../src/theme-gate.js`, copied into the
image's storage adapters directory with the rest of `src/`). Nothing of
Ghost's source is copied into this repository, so there is no pristine copy to
keep in step and no licence notice to carry.

The class `defineGatedThemeStorage` returns does two things Ghost's own class
does not. It screens the extracted tree in `save()` before the copy. And it
holds the "move the existing theme aside" `rename()` that Ghost's
`setFromZip` makes before `save()`, performing it only once the tree has been
screened clean: Ghost's restore after a failed save is not awaited and races
the removal of the backup, so a refusal that came after the move could
destroy the theme being replaced. The README of the decorator, under "Theme
uploads", has the detail.

## Re-deriving the pin on a Ghost upgrade

A version bump that changes the upstream file must fail the build, not wrap a
different class. To re-pin:

1. Extract the file from the new base image:
   ```sh
   cid=$(docker create ghost:<new-version>-alpine@sha256:<digest>)
   docker cp "$cid:/var/lib/ghost/current/core/server/services/themes/theme-storage.js" /tmp/theme-storage.js
   docker rm "$cid"
   ```
2. Read it against the previous one. The shim relies on: `module.exports` is
   the class, its `save(file, targetDir)` takes `file.path` as the extracted
   directory, and it has no write method besides `save` and the inherited
   `saveRaw`. If another write method appears, the gate must cover it. Also
   read `services/themes/storage.js` `setFromZip`: the shim assumes the
   existing theme is moved aside with `rename(<name>, <name>_<24 hex>)` before
   `save()` and that nothing else moves a theme. If that order or the backup
   name changes, the held move no longer matches and a refusal is unsafe
   again; the image test that re-uploads an installed theme name repeatedly
   is what catches it.
3. Write `<sha256 of /tmp/theme-storage.js>  theme-storage.js` into
   `theme-storage.upstream.sha256`.
4. Run `npm run coverage` here and the image test (`npm run test:image`).
