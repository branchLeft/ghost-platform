#!/usr/bin/env node
// Verify a materialised bundle against themes/manifest.json.
//
//   node themes/verify.mjs --bundle DIR [--base-themes DIR]
//
// --bundle is the output of fetch.mjs. --base-themes is the themes directory of
// the Ghost base image (Casper and Source ship there, not from GitHub). The
// image build runs this and fails the build on any problem, so a theme or font
// that references an outside origin, differs from its pin, or lacks its
// licence cannot reach an image.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './fetch.mjs';
import { validateManifest, declaredReservedFontName } from './lib/manifest.mjs';
import { classifyFile, missingAssets, scanTheme } from './lib/origins.mjs';
import { sha256File, treeSha256 } from './lib/treehash.mjs';

const LICENCE_TEXT = {
  MIT: /Permission is hereby granted, free of charge/,
  'OFL-1.1': /SIL OPEN FONT LICENSE Version 1\.1/i,
};

function checkLicenceFile(problems, label, file, licence) {
  if (!fs.existsSync(file)) {
    problems.push(`${label}: licence file ${licence.file} is missing`);
    return null;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (sha256File(file) !== licence.sha256)
    problems.push(`${label}: licence file differs from its pin`);
  if (!text.includes(licence.copyright))
    problems.push(`${label}: recorded copyright line is not in the licence file`);
  if (!LICENCE_TEXT[licence.spdx]?.test(text))
    problems.push(`${label}: licence file does not read as ${licence.spdx}`);
  return text;
}

export function verifyTheme(problems, t, dir) {
  const label = `theme ${t.name}`;
  if (!fs.existsSync(dir)) {
    problems.push(`${label}: not present at ${dir}`);
    return;
  }
  if (treeSha256(dir) !== t.treeSha256) problems.push(`${label}: tree differs from its pin`);
  checkLicenceFile(problems, label, path.join(dir, path.basename(t.licence.file)), t.licence);
  const scan = scanTheme(dir, t.externalReferences ?? []);
  for (const v of scan.violations)
    problems.push(`${label}: ${v.file}:${v.line} ${v.url} (${v.why})`);
  for (const u of scan.unusedDeclarations)
    problems.push(`${label}: stale declaration for ${u.hosts.join(', ')} in ${u.files.join(', ')}`);
  for (const m of missingAssets(dir))
    problems.push(`${label}: ${m.template} names asset ${m.asset}, which is not in the theme`);
}

export function verifyFont(problems, f, dir) {
  const label = `font ${f.family}`;
  const text = checkLicenceFile(
    problems,
    label,
    path.join(dir, path.basename(f.licence.file)),
    f.licence
  );
  if (text !== null) {
    const declared = declaredReservedFontName(text);
    const recorded = f.reservedFontName;
    if ((declared ?? '').toLowerCase() !== (recorded ?? '').toLowerCase()) {
      problems.push(
        `${label}: licence declares reserved font name ${JSON.stringify(declared)} but the manifest records ${JSON.stringify(recorded)}`
      );
    }
  }
  for (const file of f.files) {
    const p = path.join(dir, file.to);
    if (!fs.existsSync(p)) problems.push(`${label}: ${file.to} is missing`);
    else if (sha256File(p) !== file.sha256)
      problems.push(`${label}: ${file.to} differs from its pin`);
  }
}

export function verifyBundle(manifest, bundle, baseThemes) {
  const problems = validateManifest(manifest);
  if (problems.length) return problems;

  const themesDir = path.join(bundle, 'themes');
  const present = fs.existsSync(themesDir) ? fs.readdirSync(themesDir).sort() : [];
  const wanted = manifest.themes
    .filter((t) => t.source === 'github')
    .map((t) => t.name)
    .sort();
  if (JSON.stringify(present) !== JSON.stringify(wanted)) {
    problems.push(
      `bundle themes ${JSON.stringify(present)} differ from the manifest ${JSON.stringify(wanted)}`
    );
  }
  for (const t of manifest.themes) {
    if (t.source === 'github') verifyTheme(problems, t, path.join(themesDir, t.name));
    else if (!baseThemes)
      problems.push(`theme ${t.name}: --base-themes is required to check base-image themes`);
    else verifyTheme(problems, t, path.join(baseThemes, t.name));
  }

  const fontsDir = path.join(bundle, 'fonts');
  for (const f of manifest.fonts) verifyFont(problems, f, path.join(fontsDir, f.dir));

  const cssFile = path.join(fontsDir, 'fonts.css');
  if (!fs.existsSync(cssFile)) problems.push('fonts.css is missing');
  else {
    const css = fs.readFileSync(cssFile, 'utf8');
    for (const r of classifyFile('fonts.css', css)) {
      if (r.class !== 'namespace') problems.push(`fonts.css: references ${r.url}`);
    }
    for (const m of css.matchAll(/url\("([^"]+)"\)/g)) {
      if (!fs.existsSync(path.join(fontsDir, m[1])))
        problems.push(`fonts.css: ${m[1]} does not exist`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const bundle = arg('--bundle');
  if (!bundle) {
    console.error('usage: node themes/verify.mjs --bundle DIR [--base-themes DIR]');
    process.exit(2);
  }
  const base = arg('--base-themes');
  const problems = verifyBundle(
    readManifest(),
    path.resolve(bundle),
    base ? path.resolve(base) : undefined
  );
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log('bundle verified: every pin, licence and origin check passed');
}
