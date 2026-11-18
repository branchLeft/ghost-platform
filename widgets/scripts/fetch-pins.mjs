#!/usr/bin/env node
// Resolves the CDN bundles the Ghost image in the root Dockerfile loads by
// default, downloads the exact bytes jsdelivr currently resolves each
// floating `~` range to, and writes them into widgets/dist/ and
// widgets/pins.json. The ranges are read from that Ghost release's own
// defaults.json (fetched at its release tag), never typed here, so the pins
// cannot name a different Ghost than the image builds on.
// Re-run by hand only, to produce a reviewed commit -- never at build or
// deploy time. See ../README.md#fetch-pinsmjs.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDockerfileGhostImage } from './verify-pins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGETS_ROOT = join(__dirname, '..');
const DIST_DIR = join(WIDGETS_ROOT, 'dist');
const PINS_PATH = join(WIDGETS_ROOT, 'pins.json');

// Ghost moved defaults.json between releases (`ghost/core/core/shared/...`
// became `ghost/core/shared/...`), so try both, newest layout first.
const DEFAULTS_PATHS = [
  'ghost/core/shared/config/defaults.json',
  'ghost/core/core/shared/config/defaults.json',
];

// One row per config key Ghost's `getFrontendAppConfig()`
// (`frontend/utils/frontend-apps.js`) reads a `:url` or `:styles` value from.
// The floating range for each is `~` plus that key's `version` in
// defaults.json.
const SOURCES = [
  {
    configKey: 'portal',
    field: 'url',
    envVar: 'portal__url',
    pkg: 'portal',
    file: 'umd/portal.min.js',
    servedFile: 'portal.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'sodoSearch',
    field: 'url',
    envVar: 'sodoSearch__url',
    pkg: 'sodo-search',
    file: 'umd/sodo-search.min.js',
    servedFile: 'sodo-search.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'sodoSearch',
    field: 'styles',
    envVar: 'sodoSearch__styles',
    pkg: 'sodo-search',
    file: 'umd/main.css',
    servedFile: 'sodo-search.min.css',
    mime: 'text/css',
  },
  {
    configKey: 'announcementBar',
    field: 'url',
    envVar: 'announcementBar__url',
    pkg: 'announcement-bar',
    file: 'umd/announcement-bar.min.js',
    servedFile: 'announcement-bar.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'comments',
    field: 'url',
    envVar: 'comments__url',
    pkg: 'comments-ui',
    file: 'umd/comments-ui.min.js',
    servedFile: 'comments-ui.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'adminToolbar',
    field: 'url',
    envVar: 'adminToolbar__url',
    pkg: 'admin-toolbar',
    file: 'umd/admin-toolbar.min.js',
    servedFile: 'admin-toolbar.min.js',
    mime: 'application/javascript',
  },
  {
    configKey: 'signupForm',
    field: 'url',
    envVar: 'signupForm__url',
    pkg: 'signup-form',
    file: 'umd/signup-form.min.js',
    servedFile: 'signup-form.min.js',
    mime: 'application/javascript',
  },
];

function sha384(buf) {
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

async function fetchGhostDefaults(ghostVersion) {
  const tried = [];
  for (const path of DEFAULTS_PATHS) {
    const url = `https://raw.githubusercontent.com/TryGhost/Ghost/v${ghostVersion}/${path}`;
    const res = await fetch(url);
    if (res.ok) {
      return { defaults: await res.json(), path };
    }
    tried.push(`${url} -> ${res.status}`);
  }
  throw new Error(`no defaults.json for Ghost v${ghostVersion}:\n${tried.join('\n')}`);
}

function floatingRangeFor(defaults, source) {
  const entry = defaults[source.configKey];
  const template = entry?.[source.field];
  if (typeof entry?.version !== 'string' || typeof template !== 'string') {
    throw new Error(`defaults.json has no ${source.configKey}.${source.field} and version`);
  }
  if (!template.includes(`/ghost/${source.pkg}@~{version}/${source.file}`)) {
    throw new Error(
      `${source.configKey}.${source.field} in defaults.json is ${template}, expected package ${source.pkg} at ${source.file}`
    );
  }
  return `~${entry.version}`;
}

async function fetchOne(source, floatingRange) {
  const url = `https://cdn.jsdelivr.net/ghost/${source.pkg}@${floatingRange}/${source.file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  const resolvedVersion = res.headers.get('x-jsd-version');
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, resolvedVersion, buf };
}

async function main() {
  const image = await readDockerfileGhostImage();
  const { defaults, path: defaultsPath } = await fetchGhostDefaults(image.version);
  console.log(`Ghost ${image.version} (${image.ref})`);

  await mkdir(DIST_DIR, { recursive: true });
  const bundles = [];

  for (const source of SOURCES) {
    const floatingRange = floatingRangeFor(defaults, source);
    const { url, resolvedVersion, buf } = await fetchOne(source, floatingRange);
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
      resolvedFrom: `${source.pkg}@${floatingRange}`,
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
      'Pins for the six CDN script bundles plus one CDN stylesheet that the Ghost image built by the root Dockerfile loads by default (the widget config keys in that Ghost release\'s shared/config/defaults.json). Each row overrides one Ghost config key via its env-var form (nconf, separator "__") so the byte served is exactly the one pinned here, not whatever jsdelivr currently resolves the floating range to. Re-generate with widgets/scripts/fetch-pins.mjs; verify with widgets/scripts/verify-pins.mjs, which also fails when ghostVersion or sourceGhostImage stop matching the Dockerfile.',
    ghostVersion: image.version,
    sourceGhostImage: image.ref,
    sourceDefaultsJson: `TryGhost/Ghost @ v${image.version}, ${defaultsPath}`,
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
