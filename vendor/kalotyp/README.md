# Kalotyp (vendored)

Vendored third-party image editor for the tenant Ghost image's admin slot.

- Upstream: https://github.com/magicpages/kalotyp
- Package: `@magicpages/kalotyp@0.2.6` (npm, published 2026-10-08)
- Licence: MIT (`LICENSE` here is the upstream copy, Copyright (c) 2026 Magic Pages and contributors)
- Files: `kalotyp.js`, `kalotyp.css`, `LICENSE`, and `kalotyp.sha256` (the pinned hashes)

The pinned hashes are checked with `sha256sum -c kalotyp.sha256` in the root `Dockerfile` at build time. A mismatch fails the build. The files are copied into the image at `core/built/admin/assets/kalotyp/`. No network is used at build.

Upgrading means: fetch the new release with `npm pack`, replace the three files, regenerate `kalotyp.sha256`, and update the version and hashes above. `verify-kalotyp.test.mjs` must still pass.

Environment wiring (the config keys that point Ghost at these files) is not set here.
