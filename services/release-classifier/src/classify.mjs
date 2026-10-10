// Static reversibility classifier for a Ghost upgrade range. Reads migration
// source text only; nothing is executed. Rules and their rationale: ../README.md.

// Open owner rulings. Each class is routed by one constant, and consent is the
// safe default until the owner rules.
export const CONTRACTING_ROUTE = 'consent';
export const CONSTRAINT_ROUTE = 'consent';

// Hard consent: Ghost's flag, a helper that sets it, or the dropTables wrapper.
export const IRREVERSIBLE_RULES = Object.freeze([
  { name: 'flag', pattern: /\birreversible['"`]?\s*:\s*true\b/ },
  { name: 'helper', pattern: /\bcreateIrreversibleMigration\s*\(/ },
  { name: 'wrapper', pattern: /\bdropTables\s*\(/ },
]);

// Hard consent: data or structure removed with no way back from the migration.
export const DESTRUCTIVE_RULES = Object.freeze([
  { name: 'delete-table', pattern: /\bdeleteTable\s*\(/ },
  { name: 'recreate-table', pattern: /\brecreateTable\s*\(/ },
  { name: 'drop-development-copy', pattern: /\bdropDevelopmentCopy\s*\(/ },
  { name: 'remove-setting', pattern: /\bremoveSetting\s*\(/ },
  { name: 'raw-drop-table', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'raw-delete-from', pattern: /\bDELETE\s+FROM\b/i },
  { name: 'raw-truncate', pattern: /\btruncate\b/i },
  { name: 'delete-call', pattern: /\.delete\s*\(/ },
  { name: 'del-with-argument', pattern: /\.del\s*\(\s*[^)\s]/ },
]);

// Lossy, routed by CONTRACTING_ROUTE: drops a column, deletes rows, or removes
// permission rows. A rollback re-adds a column empty, and a delete loses rows.
export const CONTRACTING_RULES = Object.freeze([
  { name: 'drop-column', pattern: /\bdrop(Column|Columns)\b|\bcreateDropColumnMigration\b/ },
  { name: 'data-delete', pattern: /\.del\(\s*\)/ },
  {
    name: 'remove-permission',
    pattern: /\bremovePermission(FromRole)?\s*\(|\bcreateRemovePermissionMigration\s*\(/,
  },
]);

// Schema-only constraint drops, routed by CONSTRAINT_ROUTE, kept apart from data loss.
export const CONSTRAINT_RULES = Object.freeze([
  { name: 'drop-constraint', pattern: /\bdrop(Index|Unique|Foreign)\b/ },
]);

// Fail-closed allowlist. A call name not listed here, and not declared in the same
// file, routes consent as unclassified:<name>. Each entry gives its reason.
export const KNOWN_CALLS = Object.freeze({
  createTransactionalMigration: 'migration wrapper; its inner calls are checked',
  createNonTransactionalMigration: 'migration wrapper; its inner calls are checked',
  combineTransactionalMigrations: 'migration wrapper; its inner calls are checked',
  combineNonTransactionalMigrations: 'migration wrapper; its inner calls are checked',
  up: 'migration entry point, a definition in the file',
  down: 'migration rollback, a definition in the file',
  require: 'loads a module; the helpers it brings in are checked by name',
  knex: 'query-builder entry point; chained methods are checked by name',
  info: 'logging only',
  warn: 'logging only, as info',
  createAddColumnMigration: 'adds a column; the rollback drops it, and no existing row is lost',
  createAddIndexMigration: 'adds an index; the rollback drops it',
  createRenameColumnMigration: 'renames a column; data is kept',
  createSetNullableMigration: 'changes nullability; no row is removed',
  addTable: 'adds a table; the rollback drops it, and no existing row is lost',
  addSetting: 'adds a setting row; the rollback removes it',
  addPermissionToRole: 'adds a permission row; the rollback removes it',
  addPermissionWithRoles: 'adds a permission row; the rollback removes it',
  where: 'query filter; reads or narrows, writes nothing',
  whereNull: 'query filter; reads or narrows, writes nothing',
  map: 'array method; no database effect',
  isSQLite: 'dialect check; no database effect',
  randomBytes: 'generates an id; no database effect',
  toString: 'string conversion; no database effect',
  hex: 'encodes an id; no database effect',
  UUID: 'generates an id; no database effect',
});

// Not on the allowlist, on purpose: update (writes arbitrary values, and a rollback
// cannot restore the old ones) and raw (free-form SQL the rules cannot read).

const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'function',
  'async',
  'await',
  'new',
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

// Inclusive at both ends. The pinned minor folder is included on purpose: a
// patch can add to it, and an exclusive bound would then fail open.
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

// Blanks out string contents, so text inside a string is not read as a call.
function stripStrings(code) {
  return code.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
}

// Names a file calls, in the callee position (name( or .name().
function calledNames(code) {
  const view = stripStrings(code);
  const names = new Set();
  for (const m of view.matchAll(/(?<!function )(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g))
    names.add(m[1]);
  for (const m of view.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  // Names the file declares itself; their bodies are scanned like the rest of the file.
  const declared = new Set([
    ...[...view.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    ...[...view.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
  ]);
  return [...names].filter((n) => !KEYWORDS.has(n) && !declared.has(n)).sort();
}

function matchRules(rules, source) {
  return rules.filter((r) => r.pattern.test(source)).map((r) => r.name);
}

// A no-op rollback in a file that also calls something destructive-looking. The
// rollback then restores nothing, so the removal cannot be undone.
const NOOP_DOWN = /\bdown\s*\([^)]*\)\s*\{\s*(?:logging\.\w+\([^;]*\);\s*)*\}/;
const GENERIC_DESTRUCTIVE_WORD =
  /\b(?:drop|delete|del|remove|truncate|discard|wipe|purge|recreate)\w*\s*\(/i;
function noopRollbackRule(code) {
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
  const out = {
    irreversible: [],
    destructive: [],
    contracting: [],
    constraint: [],
    unclassified: [],
  };
  let filesInRange = 0;

  for (const m of migrations) {
    const line = parseFolder(m.folder);
    if (!inRange(line, f, t)) continue;
    filesInRange += 1;
    const code = stripComments(m.source);
    collect(out, 'irreversible', m.path, matchRules(IRREVERSIBLE_RULES, m.source));
    collect(out, 'destructive', m.path, [
      ...matchRules(DESTRUCTIVE_RULES, code),
      ...noopRollbackRule(code),
    ]);
    collect(out, 'contracting', m.path, matchRules(CONTRACTING_RULES, code));
    collect(out, 'constraint', m.path, matchRules(CONSTRAINT_RULES, code));
    const unknown = calledNames(code).filter((n) => !Object.hasOwn(KNOWN_CALLS, n));
    collect(
      out,
      'unclassified',
      m.path,
      unknown.map((n) => `unclassified:${n}`)
    );
  }

  const consent =
    majorBump ||
    out.irreversible.length > 0 ||
    out.destructive.length > 0 ||
    out.unclassified.length > 0 ||
    (out.contracting.length > 0 && CONTRACTING_ROUTE === 'consent') ||
    (out.constraint.length > 0 && CONSTRAINT_ROUTE === 'consent');

  return { route: consent ? 'consent' : 'fast-path', majorBump, filesInRange, ...out };
}
