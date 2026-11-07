#!/usr/bin/env node
// Materialise the pinned themes and fonts from themes/manifest.json.
//
//   node themes/fetch.mjs --out DIR          fetch, check every pin, write DIR/themes and DIR/fonts
//   node themes/fetch.mjs --out DIR --pin    the maintainer step: compute and write the pins
//
// The default mode never writes the manifest and fails on the first byte that
// differs from its pin. Nothing is fetched except by a full commit SHA or a
// release asset whose sha256 is pinned. Node built-ins only; the image build
// runs this with the Node already in the Ghost base image (themes/README.md).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    fs.writeFileSync(path.join(out, 'fonts', 'fonts.css'), fontsCss(manifest));
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
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
