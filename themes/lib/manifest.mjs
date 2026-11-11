// Shape and policy checks for themes/manifest.json. Pure functions over the
// parsed manifest, so they run offline in CI; the checks that need the fetched
// files live in verify.mjs.

import { DECLARATION_KINDS } from './origins.mjs';

// SPDX identifiers whose terms permit redistribution and use unmodified, with
// the licence text carried beside the files. Anything else is not bundled.
export const OPEN_LICENCES = ['MIT', 'OFL-1.1'];

export const EXCLUSION_REASONS = [
  'outside-origin-at-runtime',
  'needs-patching',
  'licence-unclear',
  'licence-not-open',
  'paid',
  'unmaintained',
  'technical-blocker',
  'not-a-theme',
  'site-specific',
];

// Extensions that make a file a font. verify.mjs fails any such file under a
// bundled theme that the manifest does not list.
export const FONT_EXTENSIONS = /\.(woff2?|ttf|otf|eot|ttc)$/i;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkLicence(problems, where, licence) {
  if (!licence || typeof licence !== 'object') {
    problems.push(`${where}: licence record missing`);
    return;
  }
  if (!OPEN_LICENCES.includes(licence.spdx)) {
    problems.push(
      `${where}: licence ${JSON.stringify(licence.spdx)} is not in the open set ${OPEN_LICENCES.join(', ')}`
    );
  }
  if (typeof licence.file !== 'string' || licence.file === '' || licence.file.includes('..')) {
    problems.push(`${where}: licence.file must name the licence file in the upstream tree`);
  }
  if (typeof licence.copyright !== 'string' || !/copyright/i.test(licence.copyright)) {
    problems.push(`${where}: licence.copyright must be the copyright line from the licence file`);
  }
  if (!HEX64.test(licence.sha256 ?? ''))
    problems.push(`${where}: licence.sha256 must be 64 hex characters`);
}

function checkDeclarations(problems, where, list) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    problems.push(`${where}: externalReferences must be a list`);
    return;
  }
  list.forEach((d, i) => {
    const at = `${where}.externalReferences[${i}]`;
    if (!Array.isArray(d.files) || d.files.length === 0)
      problems.push(`${at}: files must be a non-empty list`);
    if (!Array.isArray(d.hosts) || d.hosts.length === 0)
      problems.push(`${at}: hosts must be a non-empty list`);
    if (!DECLARATION_KINDS.includes(d.kind)) {
      problems.push(
        `${at}: kind ${JSON.stringify(d.kind)} must be one of ${DECLARATION_KINDS.join(', ')} (a 'load' is never declarable)`
      );
    }
    if (typeof d.reason !== 'string' || d.reason.trim().length < 10)
      problems.push(`${at}: a reason of at least 10 characters is required`);
  });
}

export function validateManifest(m) {
  const problems = [];
  if (m?.schema !== 1) problems.push('schema must be 1');
  if (!/^\d+\.\d+\.\d+$/.test(m?.ghost ?? ''))
    problems.push('ghost must be the pinned Ghost version');
  if (!Array.isArray(m?.themes)) problems.push('themes must be a list');
  if (!Array.isArray(m?.fonts)) problems.push('fonts must be a list');
  if (!Array.isArray(m?.embeddedFontFamilies)) problems.push('embeddedFontFamilies must be a list');
  if (!Array.isArray(m?.excluded)) problems.push('excluded must be a list');
  if (problems.length) return problems;

  const names = new Set();
  for (const t of m.themes) {
    const where = `theme ${t.name}`;
    if (!SLUG.test(t.name ?? '')) problems.push(`${where}: name must be a lowercase slug`);
    if (names.has(t.name)) problems.push(`${where}: duplicate name`);
    names.add(t.name);
    if (!['github', 'base-image'].includes(t.source))
      problems.push(`${where}: source must be github or base-image`);
    if (t.source === 'github') {
      if (!GITHUB.test(t.upstream ?? ''))
        problems.push(`${where}: upstream must be a github.com repository URL`);
      if (!HEX40.test(t.commit ?? ''))
        problems.push(`${where}: commit must be a full 40-hex commit`);
    }
    if (typeof t.version !== 'string' || t.version === '')
      problems.push(`${where}: version (package.json) is required`);
    if (!HEX64.test(t.treeSha256 ?? ''))
      problems.push(`${where}: treeSha256 must be 64 hex characters`);
    checkLicence(problems, where, t.licence);
    checkDeclarations(problems, where, t.externalReferences);
  }

  const families = new Set();
  for (const f of m.fonts) {
    const where = `font ${f.family}`;
    if (typeof f.family !== 'string' || f.family === '') problems.push('font: family required');
    if (families.has(f.family)) problems.push(`${where}: duplicate family`);
    families.add(f.family);
    if (!SLUG.test(f.dir ?? '')) problems.push(`${where}: dir must be a lowercase slug`);
    if (!GITHUB.test(f.upstream ?? ''))
      problems.push(`${where}: upstream must be a github.com repository URL`);
    if (!HEX40.test(f.commit ?? '')) problems.push(`${where}: commit must be a full 40-hex commit`);
    checkLicence(problems, where, f.licence);
    if (f.licence?.spdx && f.licence.spdx !== 'OFL-1.1')
      problems.push(`${where}: fonts are bundled under OFL-1.1 only`);
    if (f.reservedFontName !== null && typeof f.reservedFontName !== 'string') {
      problems.push(`${where}: reservedFontName must be a string or null`);
    }
    // A reserved name forbids shipping a modified version under that name. We
    // ship the upstream bytes unmodified, and say so, or the entry is refused.
    if (f.reservedFontName && f.modification !== 'none') {
      problems.push(
        `${where}: reserved font name ${JSON.stringify(f.reservedFontName)} requires modification: "none" (no subsetting, no conversion)`
      );
    }
    if (!['git-file', 'release-zip'].includes(f.source?.kind))
      problems.push(`${where}: source.kind must be git-file or release-zip`);
    if (f.source?.kind === 'release-zip') {
      if (
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^?#]+$/.test(
          f.source.url ?? ''
        )
      ) {
        problems.push(`${where}: release-zip url must be a github.com release download`);
      }
      if (!HEX64.test(f.source.sha256 ?? ''))
        problems.push(`${where}: release-zip sha256 must be 64 hex characters`);
    }
    if (!Array.isArray(f.files) || f.files.length === 0)
      problems.push(`${where}: files must be a non-empty list`);
    const tos = new Set();
    for (const file of f.files ?? []) {
      if (!SAFE_FILE.test(file.to ?? '') || !file.to.endsWith('.woff2'))
        problems.push(`${where}: to ${JSON.stringify(file.to)} must be a plain .woff2 file name`);
      if (tos.has(file.to)) problems.push(`${where}: duplicate to ${file.to}`);
      tos.add(file.to);
      if (typeof file.from !== 'string' || file.from === '' || file.from.includes('..'))
        problems.push(`${where}: from required`);
      if (!HEX64.test(file.sha256 ?? ''))
        problems.push(`${where}: ${file.to} sha256 must be 64 hex characters`);
      if (!['normal', 'italic'].includes(file.style))
        problems.push(`${where}: ${file.to} style must be normal or italic`);
      if (!/^\d{3}(?: \d{3})?$/.test(file.weight ?? ''))
        problems.push(`${where}: ${file.to} weight must be e.g. "400" or "100 900"`);
    }
  }

  const embeddedFamilies = new Map();
  for (const f of m.embeddedFontFamilies) {
    const where = `embedded font ${f.family}`;
    if (typeof f.family !== 'string' || f.family === '')
      problems.push('embedded font: family required');
    if (embeddedFamilies.has(f.family)) problems.push(`${where}: duplicate family`);
    embeddedFamilies.set(f.family, f);
    if (!SLUG.test(f.dir ?? '')) problems.push(`${where}: dir must be a lowercase slug`);
    if (!GITHUB.test(f.upstream ?? ''))
      problems.push(`${where}: upstream must be a github.com repository URL`);
    if (!HEX40.test(f.commit ?? '')) problems.push(`${where}: commit must be a full 40-hex commit`);
    checkLicence(problems, where, f.licence);
    if (f.licence?.spdx && f.licence.spdx !== 'OFL-1.1')
      problems.push(`${where}: embedded fonts are carried under OFL-1.1 only`);
    if (typeof f.licence?.sourcePath !== 'string' || f.licence.sourcePath === '')
      problems.push(`${where}: licence.sourcePath must name the licence file in the upstream`);
    if (
      !Array.isArray(f.reservedFontNames) ||
      f.reservedFontNames.some((n) => typeof n !== 'string' || n === '')
    ) {
      problems.push(`${where}: reservedFontNames must be a list of names (empty if none)`);
    }
    // The files are shipped as the theme carries them, byte for byte.
    if (f.modification !== 'none') problems.push(`${where}: modification must be "none"`);
  }

  const usedFamilies = new Set();
  for (const t of m.themes) {
    const seen = new Set();
    for (const e of t.embeddedFonts ?? []) {
      const where = `theme ${t.name}: embeddedFonts ${e.family}`;
      if (!embeddedFamilies.has(e.family))
        problems.push(`${where}: family is not in embeddedFontFamilies`);
      usedFamilies.add(e.family);
      if (!Array.isArray(e.files) || e.files.length === 0)
        problems.push(`${where}: files must be a non-empty list`);
      for (const file of e.files ?? []) {
        const p = file.path ?? '';
        if (
          !/^[A-Za-z0-9][^\\]*$/.test(p) ||
          p.split('/').includes('..') ||
          !FONT_EXTENSIONS.test(p)
        )
          problems.push(`${where}: path ${JSON.stringify(p)} must be a relative font file path`);
        if (seen.has(p)) problems.push(`${where}: ${p} is listed twice in theme ${t.name}`);
        seen.add(p);
        if (!HEX64.test(file.sha256 ?? ''))
          problems.push(`${where}: ${p} sha256 must be 64 hex characters`);
      }
    }
  }
  for (const family of embeddedFamilies.keys()) {
    if (!usedFamilies.has(family))
      problems.push(`embedded font ${family}: no theme embeds it; remove the record`);
  }

  const excluded = new Set();
  for (const e of m.excluded) {
    const where = `excluded ${e.name}`;
    if (!SLUG.test(e.name ?? '')) problems.push(`${where}: name must be a lowercase slug`);
    if (names.has(e.name)) problems.push(`${where}: also listed as bundled`);
    if (excluded.has(e.name)) problems.push(`${where}: listed twice`);
    excluded.add(e.name);
    if (!EXCLUSION_REASONS.includes(e.reason))
      problems.push(`${where}: reason must be one of ${EXCLUSION_REASONS.join(', ')}`);
    if (typeof e.detail !== 'string' || e.detail.length < 10)
      problems.push(`${where}: detail required`);
    if (!GITHUB.test(e.upstream ?? ''))
      problems.push(`${where}: upstream must be a github.com repository URL`);
  }
  return problems;
}

// The lowercase repository name every bundled or excluded theme answers to: the
// upstream repository, or the theme name for one shipped in the base image.
export function catalogue(m) {
  const key = (e) => (e.upstream ? e.upstream.split('/').pop() : e.name).toLowerCase();
  return [...m.themes.map(key), ...m.excluded.map(key)].sort();
}

// Compare the manifest with a snapshot of the organisation's theme repositories
// ({repos: [...]}). `unscreened` are in the snapshot but neither bundled nor
// excluded; `unknown` are in the manifest but not in the snapshot.
export function screening(m, snapshot) {
  const have = new Set(catalogue(m));
  const want = new Set(snapshot.repos.map((r) => r.toLowerCase()));
  return {
    unscreened: [...want].filter((r) => !have.has(r)).sort(),
    unknown: [...have].filter((r) => !want.has(r)).sort(),
  };
}

// Every Reserved Font Name an embedded font's licence declares, from the
// copyright notice above the licence text (empty when it declares none).
export function declaredReservedNames(licenceText) {
  const head = licenceText.split(/^.*SIL OPEN FONT LICENSE.*$/im)[0];
  const m = /\bwith\s+Reserved\s+Font\s+Names?\s+([\s\S]*)$/i.exec(head);
  if (!m) return [];
  const quoted = [...m[1].matchAll(/["“]([^"”]+)["”]/g)].map((q) => q[1].trim());
  if (quoted.length > 0) return quoted;
  const bare = /^[^.\n]+/.exec(m[1]);
  return bare ? [bare[0].trim()] : [];
}

// The copyright line a font licence declares a Reserved Font Name on, if any.
export function declaredReservedFontName(licenceText) {
  const m = /^Copyright[^\n]*with Reserved Font Names?\s+["“”'‘’]?([^"“”'‘’\n.]+)/im.exec(
    licenceText
  );
  return m ? m[1].trim() : null;
}
