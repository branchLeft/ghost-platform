#!/usr/bin/env node
// Resolves the six CDN script bundles and the one CDN stylesheet the pinned
// Ghost image loads by default (`ghost/core/core/shared/config/defaults.json`
// in `forks/Ghost` at `v6.55.0`, lines 294-318), downloads the exact bytes
// jsdelivr currently resolves each floating `~` range to, and writes them
// into `widgets/dist/` alongside a content-digest manifest in
// `widgets/pins.json`.
//
// Re-running this is how a future upgrade re-pins: it always re-resolves
// against the live CDN, so the diff in `pins.json` and `dist/` is the whole
// review surface for "did the third party change what these bytes are".
// It never runs at deploy or build time — only here, by hand, to produce a
// new commit.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGETS_ROOT = join(__dirname, '..');
const DIST_DIR = join(WIDGETS_ROOT, 'dist');
const PINS_PATH = join(WIDGETS_ROOT, 'pins.json');

// One row per config key Ghost's `getFrontendAppConfig()`
// (`core/frontend/utils/frontend-apps.js`) reads a `:url` or `:styles` value
// from. `floatingRange` and `pkg` are read straight off
// `defaults.json:294-318`; nothing here is invented.
const SOURCES = [
  {
    configKey: 'portal',
    field: 'url',
    envVar: 'portal__url',
    pkg: 'portal',
    floatingRange: '~2.69',
    file: 'umd/portal.min.js',
    servedFile: 'portal.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'sodoSearch',
    field: 'url',
    envVar: 'sodoSearch__url',
    pkg: 'sodo-search',
    floatingRange: '~1.8',
    file: 'umd/sodo-search.min.js',
    servedFile: 'sodo-search.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'sodoSearch',
    field: 'styles',
    envVar: 'sodoSearch__styles',
    pkg: 'sodo-search',
    floatingRange: '~1.8',
    file: 'umd/main.css',
    servedFile: 'sodo-search.min.css',
    mime: 'text/css',
  },
  {
    configKey: 'announcementBar',
    field: 'url',
    envVar: 'announcementBar__url',
    pkg: 'announcement-bar',
    floatingRange: '~1.1',
    file: 'umd/announcement-bar.min.js',
    servedFile: 'announcement-bar.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'comments',
    field: 'url',
    envVar: 'comments__url',
    pkg: 'comments-ui',
    floatingRange: '~1.5',
    file: 'umd/comments-ui.min.js',
    servedFile: 'comments-ui.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'adminToolbar',
    field: 'url',
    envVar: 'adminToolbar__url',
    pkg: 'admin-toolbar',
    floatingRange: '~0.1',
    file: 'umd/admin-toolbar.min.js',
    servedFile: 'admin-toolbar.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'signupForm',
    field: 'url',
    envVar: 'signupForm__url',
    pkg: 'signup-form',
    floatingRange: '~0.3',
    file: 'umd/signup-form.min.js',
    servedFile: 'signup-form.min.js',
    mime: 'application/javascript',
  },
];

function sha384(buf) {
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

async function fetchOne(source) {
  const url = `https://cdn.jsdelivr.net/ghost/${source.pkg}@${source.floatingRange}/${source.file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  const resolvedVersion = res.headers.get('x-jsd-version');
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, resolvedVersion, buf };
}

async function main() {
  await mkdir(DIST_DIR, { recursive: true });
  const bundles = [];

  for (const source of SOURCES) {
    const { url, resolvedVersion, buf } = await fetchOne(source);
    const digest = sha384(buf);
    await writeFile(join(DIST_DIR, source.servedFile), buf);

    bundles.push({
      configKey: source.configKey,
      field: source.field,
      envVar: source.envVar,
      servedPath: `/bl-assets/${source.servedFile}`,
      vendoredFile: `dist/${source.servedFile}`,
      mime: source.mime,
      sourceUrl: url,
      resolvedFrom: `${source.pkg}@${source.floatingRange}`,
      resolvedVersion,
      sha384: digest,
      bytes: buf.length,
    });

    console.log(
      `${source.configKey}.${source.field} -> ${resolvedVersion}  ${digest}  (${buf.length} bytes)`
    );
  }

  const manifest = {
    $comment:
      'Pins for the six CDN script bundles plus one CDN stylesheet the pinned ghost:6.55.0 image loads by default (core/shared/config/defaults.json:294-318 in forks/Ghost at v6.55.0). Each row overrides one Ghost config key via its env-var form (nconf, separator "__") so the byte served is exactly the one pinned here, not whatever jsdelivr currently resolves the floating range to. Re-generate with widgets/scripts/fetch-pins.mjs; verify with widgets/scripts/verify-pins.mjs.',
    sourceGhostImage:
      'ghost:6.55.0-alpine@sha256:de23ea18e09f1f6e94dd323c831c3821494fa054b7a55984a5bd0b817fcab918',
    sourceDefaultsJson:
      'forks/Ghost @ v6.55.0, ghost/core/core/shared/config/defaults.json:294-318',
    servedFrom:
      'widgets/origin (Caddy file_server on /bl-assets/, reverse-proxying everything else to the Ghost container) -- see widgets/README.md',
    pinnedAt: new Date().toISOString().slice(0, 10),
    bundles,
  };

  await writeFile(PINS_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWrote ${PINS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
