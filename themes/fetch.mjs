#!/usr/bin/env node
// Materialise the pinned themes and fonts from themes/manifest.json (usage: themes/README.md).
// The default mode never writes the manifest and fails on the first byte that differs from its pin.
// Nothing is fetched except by a full commit SHA or a release asset with a pinned sha256.
// Node built-ins only: the image build runs it with the Node already in the Ghost base image.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_FONT_CHOICE } from './lib/manifest.mjs';
import { sha256File, treeSha256 } from './lib/treehash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(HERE, 'manifest.json');
const MAX_BYTES = 64 * 1024 * 1024;

export function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function repoOf(upstream) {
  return upstream.replace('https://github.com/', '');
}

async function download(url, dest) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) throw new Error(`refusing ${declared} bytes`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) throw new Error(`refusing ${body.length} bytes`);
      fs.writeFileSync(dest, body);
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`download of ${url} failed: ${lastError?.message}`);
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function firstCopyrightLine(text) {
  const line = text.split('\n').find((l) => /^\s*copyright/i.test(l));
  return line ? line.trim() : '';
}

/** Fetch one GitHub tree at a commit into `dest`. */
export async function fetchThemeTree(theme, dest, tmp) {
  const tarball = path.join(tmp, `${theme.name}.tar.gz`);
  await download(
    `https://codeload.github.com/${repoOf(theme.upstream)}/tar.gz/${theme.commit}`,
    tarball
  );
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', dest], { stdio: 'pipe' });
  // Some tar implementations write the pax comment as a file.
  fs.rmSync(path.join(dest, 'pax_global_header'), { force: true });
}

async function fetchRaw(font, filePath, dest) {
  const url = `https://raw.githubusercontent.com/${repoOf(font.upstream)}/${font.commit}/${encodePath(filePath)}`;
  await download(url, dest);
}

function fail(message) {
  throw new Error(message);
}

function checkPin(label, actual, pinned, pin, assign) {
  if (pin) {
    assign(actual);
  } else if (actual !== pinned) {
    fail(`${label}: pinned ${pinned} but fetched ${actual}`);
  }
}

export function fontsCss(manifest) {
  const rules = [];
  for (const f of manifest.fonts) {
    for (const file of f.files) {
      rules.push(
        `@font-face {\n  font-family: "${f.family}";\n  font-style: ${file.style};\n  font-weight: ${file.weight};\n  font-display: swap;\n  src: url("${f.dir}/${file.to}") format("woff2");\n}\n`
      );
    }
  }
  return `/* Generated from themes/manifest.json by themes/fetch.mjs. Relative URLs only: every font is served from this origin. */\n${rules.join('')}`;
}

// The two theme settings a tenant uses to pick a font, and the Ghost CSS
// variables they set (the ones Ghost's own font picker sets, so a theme's
// stylesheet already reads them). Ghost allows twenty theme settings in all.
export const HEADING_SETTING = 'platform_heading_font';
export const BODY_SETTING = 'platform_body_font';
// A theme with no room for two more settings (Source has nineteen) offers the
// families through its own title and body font selects instead.
export const REUSED_HEADING_SETTING = 'title_font';
export const REUSED_BODY_SETTING = 'body_font';
const MAX_THEME_SETTINGS = 20;
const PARTIAL_NAME = 'platform-fonts';
const PARTIAL_INCLUDE = `{{> "${PARTIAL_NAME}"}}`;
const HEAD_HELPER = '{{ghost_head}}';

/** The `config.custom` entries added to a theme with room: one select per role. */
export function fontThemeSettings(manifest) {
  const options = [NO_FONT_CHOICE, ...manifest.fonts.map((f) => f.family)];
  return {
    [HEADING_SETTING]: {
      type: 'select',
      options,
      default: NO_FONT_CHOICE,
      description: 'Heading font, served from this site. Theme default keeps the theme font.',
    },
    [BODY_SETTING]: {
      type: 'select',
      options,
      default: NO_FONT_CHOICE,
      description: 'Body font, served from this site. Theme default keeps the theme font.',
    },
  };
}

const OWN_SETTINGS = { heading: HEADING_SETTING, body: BODY_SETTING };

/**
 * The partial a theme's default.hbs includes after the head helper. A family is
 * chosen only when a setting equals its name, so any other value (Theme default,
 * a theme's own option, nothing) emits nothing. A chosen font links the theme's
 * own fonts.css (this origin) and sets Ghost's font variable; the element rule
 * makes a theme that never reads the variable follow it too.
 */
export function platformFontsPartial(manifest, settings = OWN_SETTINGS) {
  const chain = (branches) =>
    branches
      .map(
        ({ setting, family, output }, i) =>
          `{{${i === 0 ? '#' : 'else '}match @custom.${setting} "=" "${family}"}}${output}`
      )
      .join('') + '{{/match}}';
  const link = '<link rel="stylesheet" href="{{asset "platform-fonts/fonts.css"}}">';
  const style = (f, cssVariable, rule) =>
    `<style>:root{${cssVariable}:"${f.family}",${f.fallback}}${rule}{font-family:var(${cssVariable})}</style>`;
  const branches = (setting, output) =>
    manifest.fonts.map((f) => ({ setting, family: f.family, output: output(f) }));
  return [
    '{{!-- Generated from themes/manifest.json by themes/fetch.mjs. Fonts come from this origin only. --}}',
    chain([...branches(settings.heading, () => link), ...branches(settings.body, () => link)]),
    chain(branches(settings.heading, (f) => style(f, '--gh-font-heading', 'h1,h2,h3,h4,h5,h6'))),
    chain(branches(settings.body, (f) => style(f, '--gh-font-body', 'body'))),
    '',
  ].join('\n');
}

// The theme's `config.custom` after the font choice is added, and the two
// settings the partial reads.
function planThemeSettings(themeDir, custom, manifest) {
  const added = fontThemeSettings(manifest);
  for (const key of Object.keys(added)) {
    if (key in custom) fail(`${themeDir}: theme setting ${key} already exists`);
  }
  if (Object.keys(custom).length + Object.keys(added).length <= MAX_THEME_SETTINGS) {
    return { custom: { ...custom, ...added }, settings: OWN_SETTINGS };
  }
  const families = manifest.fonts.map((f) => f.family);
  const extended = { ...custom };
  for (const key of [REUSED_HEADING_SETTING, REUSED_BODY_SETTING]) {
    const existing = custom[key];
    if (existing?.type !== 'select' || !Array.isArray(existing.options)) {
      fail(
        `${themeDir}: ${Object.keys(custom).length} theme settings leave no room for two more, and it has no ${key} select to extend`
      );
    }
    const clash = families.find((family) => existing.options.includes(family));
    if (clash) fail(`${themeDir}: ${key} already offers ${clash}`);
    extended[key] = { ...existing, options: [...existing.options, ...families] };
  }
  return {
    custom: extended,
    settings: { heading: REUSED_HEADING_SETTING, body: REUSED_BODY_SETTING },
  };
}

// Where the head helper is used in a template: not where a comment names it
// (Source's default.hbs does).
function headHelperOffsets(hbs) {
  const comments = [...hbs.matchAll(/\{\{!--[\s\S]*?--\}\}|\{\{![\s\S]*?\}\}/g)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
  const offsets = [];
  for (let at = hbs.indexOf(HEAD_HELPER); at !== -1; at = hbs.indexOf(HEAD_HELPER, at + 1)) {
    if (!comments.some(([from, to]) => at >= from && at < to)) offsets.push(at);
  }
  return offsets;
}

/**
 * Give one theme the font choice: the settings in package.json, the partial, and
 * one include after its head helper. Fails, changing nothing, when the theme
 * cannot take it (no or several head helpers, a clash, no room for settings).
 */
export function applyPlatformFonts(themeDir, manifest) {
  const hbsPath = path.join(themeDir, 'default.hbs');
  const pkgPath = path.join(themeDir, 'package.json');
  const partialPath = path.join(themeDir, 'partials', `${PARTIAL_NAME}.hbs`);
  const hbs = fs.readFileSync(hbsPath, 'utf8');
  const heads = headHelperOffsets(hbs);
  if (heads.length !== 1)
    fail(`${themeDir}: default.hbs has ${heads.length} ${HEAD_HELPER}, expected exactly 1`);
  if (hbs.includes(PARTIAL_INCLUDE)) fail(`${themeDir}: default.hbs already includes the partial`);
  if (fs.existsSync(partialPath)) fail(`${themeDir}: partials/${PARTIAL_NAME}.hbs already exists`);

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const plan = planThemeSettings(themeDir, pkg.config?.custom ?? {}, manifest);

  pkg.config = { ...pkg.config, custom: plan.custom };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, platformFontsPartial(manifest, plan.settings));
  const end = heads[0] + HEAD_HELPER.length;
  const indent = /[ \t]*$/.exec(hbs.slice(0, heads[0]))?.[0] ?? '';
  fs.writeFileSync(hbsPath, `${hbs.slice(0, end)}\n${indent}${PARTIAL_INCLUDE}${hbs.slice(end)}`);
}

export async function materialise(manifest, out, { pin = false, baseThemes } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-'));
  try {
    for (const t of manifest.themes) {
      if (t.source === 'base-image') {
        // Shipped by the Ghost base image, whose digest is pinned in the
        // Dockerfile; verify.mjs checks it in place. Only the maintainer step
        // reads it, to record its pins.
        if (pin) {
          if (!baseThemes)
            fail('--base-themes is required with --pin when the manifest has base-image themes');
          const dir = path.join(baseThemes, t.name);
          const licencePath = path.join(dir, t.licence.file);
          t.licence.copyright = firstCopyrightLine(fs.readFileSync(licencePath, 'utf8'));
          t.licence.sha256 = sha256File(licencePath);
          t.version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
          t.treeSha256 = treeSha256(dir);
          console.log(`theme ${t.name}: base image ${t.version} pinned`);
        }
        continue;
      }
      const dest = path.join(out, 'themes', t.name);
      await fetchThemeTree(t, dest, tmp);
      const licencePath = path.join(dest, t.licence.file);
      if (!fs.existsSync(licencePath))
        fail(`${t.name}: licence file ${t.licence.file} is not in the upstream tree`);
      const licenceText = fs.readFileSync(licencePath, 'utf8');
      if (pin) {
        t.licence.copyright = firstCopyrightLine(licenceText);
        t.version = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
      }
      checkPin(
        `${t.name} licence`,
        sha256File(licencePath),
        t.licence.sha256,
        pin,
        (v) => (t.licence.sha256 = v)
      );
      checkPin(`${t.name} tree`, treeSha256(dest), t.treeSha256, pin, (v) => (t.treeSha256 = v));
      for (const e of t.embeddedFonts ?? []) {
        for (const file of e.files) {
          const label = `${t.name} ${file.path}`;
          checkPin(label, sha256File(path.join(dest, file.path)), file.sha256, pin, (v) => {
            file.sha256 = v;
          });
        }
      }
      console.log(`theme ${t.name}: ${t.commit.slice(0, 12)} ok`);
    }

    for (const f of manifest.fonts) {
      const dir = path.join(out, 'fonts', f.dir);
      fs.mkdirSync(dir, { recursive: true });
      const licenceDest = path.join(dir, path.basename(f.licence.file));
      await fetchRaw(f, f.licence.file, licenceDest);
      if (pin) f.licence.copyright = firstCopyrightLine(fs.readFileSync(licenceDest, 'utf8'));
      checkPin(
        `${f.family} licence`,
        sha256File(licenceDest),
        f.licence.sha256,
        pin,
        (v) => (f.licence.sha256 = v)
      );

      let zipPath;
      if (f.source.kind === 'release-zip') {
        zipPath = path.join(tmp, `${f.dir}.zip`);
        await download(f.source.url, zipPath);
        checkPin(
          `${f.family} release archive`,
          sha256File(zipPath),
          f.source.sha256,
          pin,
          (v) => (f.source.sha256 = v)
        );
      }
      for (const file of f.files) {
        const dest = path.join(dir, file.to);
        if (zipPath) {
          const bytes = execFileSync('unzip', ['-p', zipPath, file.from], { maxBuffer: MAX_BYTES });
          fs.writeFileSync(dest, bytes);
        } else {
          await fetchRaw(f, file.from, dest);
        }
        checkPin(
          `${f.family} ${file.to}`,
          sha256File(dest),
          file.sha256,
          pin,
          (v) => (file.sha256 = v)
        );
      }
      console.log(`font ${f.family}: ${f.files.length} file(s) ok`);
    }
    // The licence text of every font family a theme embeds travels beside the
    // platform fonts, so it is served from the tenant's origin in each theme.
    for (const f of manifest.embeddedFontFamilies ?? []) {
      const source = path.join(HERE, 'licences', f.dir, path.basename(f.licence.file));
      if (pin) {
        f.licence.copyright = firstCopyrightLine(fs.readFileSync(source, 'utf8'));
        f.licence.sha256 = sha256File(source);
      }
      const dest = path.join(out, 'fonts', 'embedded', f.dir);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(source, path.join(dest, path.basename(f.licence.file)));
    }
    fs.writeFileSync(path.join(out, 'fonts', 'fonts.css'), fontsCss(manifest));
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fontsIdx = args.indexOf('--platform-fonts');
  if (fontsIdx !== -1) {
    const themeDir = args[fontsIdx + 1];
    if (!themeDir) {
      console.error('usage: node themes/fetch.mjs --platform-fonts THEME_DIR');
      process.exit(2);
    }
    try {
      applyPlatformFonts(path.resolve(themeDir), readManifest());
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const outIdx = args.indexOf('--out');
  if (outIdx === -1 || !args[outIdx + 1]) {
    console.error('usage: node themes/fetch.mjs --out DIR [--pin [--base-themes DIR]]');
    process.exit(2);
  }
  const out = path.resolve(args[outIdx + 1]);
  const pin = args.includes('--pin');
  const baseIdx = args.indexOf('--base-themes');
  const baseThemes = baseIdx === -1 ? undefined : path.resolve(args[baseIdx + 1]);
  const manifest = readManifest();
  materialise(manifest, out, { pin, baseThemes })
    .then((m) => {
      if (pin) {
        fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(m, null, 2)}\n`);
        console.log('manifest pins written; run the formatter before committing');
      }
    })
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    });
}
