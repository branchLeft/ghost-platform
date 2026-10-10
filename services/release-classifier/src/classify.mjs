// Static reversibility classifier for a Ghost upgrade range. Reads migration
// source text only; nothing is executed. Rules and their rationale: ../README.md.

// Open owner ruling: whether contracting migrations (column drops, data
// deletes) keep the fast path. Until ruled, they take the
// consent path. Changing this value is a ruling, not a refactor; the test pins it.
export const CONTRACTING_ROUTE = 'consent';

// A migration is irreversible when Ghost's own config flag is set, directly or
// through a helper that sets it. Each rule is named so a test can prove it.
export const IRREVERSIBLE_RULES = Object.freeze([
  { name: 'flag', pattern: /\birreversible\s*:\s*true\b/ },
  { name: 'helper', pattern: /\bcreateIrreversibleMigration\s*\(/ },
  { name: 'wrapper', pattern: /\bdropTables\s*\(/ },
]);

// Reversible by Ghost's flag, but lossy: a column drop or data delete.
export const CONTRACTING_RULES = Object.freeze([
  { name: 'drop-column', pattern: /\bdropColumn\b|\bcreateDropColumnMigration\b/ },
  { name: 'data-delete', pattern: /\.del\(\s*\)/ },
]);

const RELEASE_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const FOLDER_PATTERN = /^(\d+)\.(\d+)$/;

export function parseRelease(tag) {
  const m = RELEASE_PATTERN.exec(String(tag).trim());
  if (!m) throw new Error(`not a plain release tag: ${tag}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// A migration folder such as "6.57" holds migrations for that minor line.
function parseFolder(name) {
  const m = FOLDER_PATTERN.exec(name);
  if (!m) throw new Error(`unrecognised migration folder: ${name}`);
  return [Number(m[1]), Number(m[2])];
}

function compareLines(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

// Inclusive at both ends. The pinned minor line is included on purpose: a patch
// release can add a migration to its own minor folder, and over-including only
// makes the answer more cautious.
function inRange(line, from, to) {
  const lower = [from.major, from.minor];
  const upper = [to.major, to.minor];
  return compareLines(lower, line) <= 0 && compareLines(line, upper) <= 0;
}

/**
 * @param {{ from: string, to: string, migrations: Array<{ folder: string, path: string, source: string }> }} input
 * @returns {{ route: 'fast-path' | 'consent', majorBump: boolean, irreversible: Array<{ path: string, rule: string }>, contracting: Array<{ path: string, rule: string }>, filesInRange: number }}
 */
export function classifyRange({ from, to, migrations }) {
  const f = parseRelease(from);
  const t = parseRelease(to);
  if (compareLines([t.major, t.minor], [f.major, f.minor]) < 0) {
    throw new Error(`target ${to} precedes ${from}`);
  }
  const majorBump = t.major > f.major;
  const irreversible = [];
  const contracting = [];
  let filesInRange = 0;

  for (const m of migrations) {
    if (!inRange(parseFolder(m.folder), f, t)) continue;
    filesInRange += 1;
    const flag = IRREVERSIBLE_RULES.find((r) => r.pattern.test(m.source));
    if (flag) irreversible.push({ path: m.path, rule: flag.name });
    for (const r of CONTRACTING_RULES) {
      if (r.pattern.test(m.source)) contracting.push({ path: m.path, rule: r.name });
    }
  }

  const consent =
    majorBump ||
    irreversible.length > 0 ||
    (contracting.length > 0 && CONTRACTING_ROUTE === 'consent');

  return {
    route: consent ? 'consent' : 'fast-path',
    majorBump,
    irreversible,
    contracting,
    filesInRange,
  };
}
