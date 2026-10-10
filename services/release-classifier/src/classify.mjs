// Static reversibility classifier for a Ghost upgrade range. Reads migration
// source text only; nothing is executed. Rules and their rationale: ../README.md.

// Open owner rulings. Each class below is routed by one constant. Consent is
// the safe default until the owner rules.
export const CONTRACTING_ROUTE = 'consent';
export const CONSTRAINT_ROUTE = 'consent';

// Hard consent: Ghost's flag, or a helper that sets it, or a table or row
// destruction that cannot be undone from the migration itself.
export const IRREVERSIBLE_RULES = Object.freeze([
  { name: 'flag', pattern: /\birreversible['"`]?\s*:\s*true\b/ },
  { name: 'helper', pattern: /\bcreateIrreversibleMigration\s*\(/ },
  { name: 'wrapper', pattern: /\bdropTables\s*\(/ },
]);

export const DESTRUCTIVE_RULES = Object.freeze([
  { name: 'delete-table', pattern: /\bdeleteTable\s*\(/ },
  { name: 'recreate-table', pattern: /\brecreateTable\s*\(/ },
  { name: 'raw-drop-table', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'raw-delete-from', pattern: /\bDELETE\s+FROM\b/i },
  { name: 'raw-truncate', pattern: /\btruncate\b/i },
  { name: 'delete-call', pattern: /\.delete\s*\(/ },
  { name: 'del-with-argument', pattern: /\.del\s*\(\s*[^)\s]/ },
]);

// Reversible by Ghost's flag, but lossy: a column drop or a data delete.
export const CONTRACTING_RULES = Object.freeze([
  { name: 'drop-column', pattern: /\bdrop(Column|Columns)\b|\bcreateDropColumnMigration\b/ },
  { name: 'data-delete', pattern: /\.del\(\s*\)/ },
]);

// Schema-only constraint drops. Their own class, so the owner rules on them
// separately from data loss.
export const CONSTRAINT_RULES = Object.freeze([
  { name: 'drop-constraint', pattern: /\bdrop(Index|Unique|Foreign)\b/ },
]);

const NOOP_DOWN = /\bdown\s*\([^)]*\)\s*\{\s*(?:logging\.\w+\([^;]*\);\s*)*\}/;
const GENERIC_DESTRUCTIVE_WORD =
  /\b(?:drop|delete|del|remove|truncate|discard|wipe|purge|recreate)\w*\s*\(/i;

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

// Inclusive at both ends. The pinned minor folder is included on purpose: a
// patch can add to it, and over-including only makes the answer more cautious.
function inRange(line, from, to) {
  return (
    compareLines([from.major, from.minor], line) <= 0 &&
    compareLines(line, [to.major, to.minor]) <= 0
  );
}

// Removes full-line and block comments, so a commented-out call does not match.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function matchRules(rules, source) {
  return rules.filter((r) => r.pattern.test(source)).map((r) => r.name);
}

// A file whose rollback does nothing, while the file also contains a
// destructive-looking call, destroys data with no way back.
function noopRollbackRule(source) {
  const code = stripComments(source);
  return NOOP_DOWN.test(code) && GENERIC_DESTRUCTIVE_WORD.test(code) ? ['noop-rollback'] : [];
}

function collect(out, cls, path, names) {
  for (const rule of names) out[cls].push({ path, rule });
}

/**
 * @param {{ from: string, to: string, migrations: Array<{ folder: string, path: string, source: string }> }} input
 */
export function classifyRange({ from, to, migrations }) {
  const f = parseRelease(from);
  const t = parseRelease(to);
  if (compareLines([t.major, t.minor], [f.major, f.minor]) < 0) {
    throw new Error(`target ${to} precedes ${from}`);
  }
  const majorBump = t.major > f.major;
  const out = { irreversible: [], destructive: [], contracting: [], constraint: [] };
  let filesInRange = 0;

  for (const m of migrations) {
    const line = parseFolder(m.folder);
    if (!inRange(line, f, t)) continue;
    filesInRange += 1;
    const code = stripComments(m.source);
    collect(out, 'irreversible', m.path, matchRules(IRREVERSIBLE_RULES, m.source));
    collect(out, 'destructive', m.path, [
      ...matchRules(DESTRUCTIVE_RULES, code),
      ...noopRollbackRule(m.source),
    ]);
    collect(out, 'contracting', m.path, matchRules(CONTRACTING_RULES, code));
    collect(out, 'constraint', m.path, matchRules(CONSTRAINT_RULES, code));
  }

  const consent =
    majorBump ||
    out.irreversible.length > 0 ||
    out.destructive.length > 0 ||
    (out.contracting.length > 0 && CONTRACTING_ROUTE === 'consent') ||
    (out.constraint.length > 0 && CONSTRAINT_ROUTE === 'consent');

  return { route: consent ? 'consent' : 'fast-path', majorBump, filesInRange, ...out };
}
