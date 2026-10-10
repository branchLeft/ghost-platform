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
  connection: 'the knex handle a migration receives; chained methods are checked by name',
  info: 'logging only',
  warn: 'logging only, as info',
  createAddColumnMigration:
    'adds the column if absent; the rollback drops the column whenever it exists, so if up was skipped the pre-existing column and its data are dropped',
  createAddIndexMigration: 'adds an index; the rollback drops it',
  createRenameColumnMigration: 'renames a column; data is kept',
  createSetNullableMigration: 'changes nullability; no row is removed',
  addTable:
    'creates the table if absent; the rollback drops it whether or not up created it, so if up was skipped the pre-existing table and its rows are dropped. The replaceDevelopmentCopy option is dev and test only and is invisible here',
  addSetting:
    'inserts the setting if absent; the rollback deletes it by key whether or not up inserted it, so if up was skipped the pre-existing setting is deleted',
  addPermissionToRole:
    'links a permission to a role if not linked; the rollback deletes the link whether or not up created it, so if up was skipped the pre-existing link is deleted',
  addPermissionWithRoles:
    'adds a permission and its role links; the rollback deletes every permission row with the same action and object, not only this one, and runs even if up was skipped',
  where: 'query filter; reads or narrows, writes nothing',
  whereNull: 'query filter; reads or narrows, writes nothing',
  map: 'array method; no database effect',
  isSQLite: 'dialect check; no database effect',
  randomBytes: 'generates an id; no database effect',
  toString: 'string conversion; no database effect',
  ObjectID: 'id constructor imported from a module; generates an id, no database effect',
  toHexString: 'formats a generated id; no database effect',
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

// Bindings that give a local name another name: `const x = a.b;`, `const { x } = a;`.
// Also records names bound to plain literals (never callable) and destructuring
// patterns this parser cannot read, which fail closed.
function bindings(view) {
  const aliases = new Map();
  const literals = new Set();
  const unreadable = [];
  for (const m of view.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/g
  )) {
    const parts = m[2].split('.').map((x) => x.trim());
    aliases.set(m[1], parts[parts.length - 1]);
  }
  for (const m of view.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[A-Za-z_$][\w$.]*(?:\s*\([^)]*\))?\s*;/g
  )) {
    for (const entry of m[1].split(',')) {
      const e = entry.trim();
      if (!e) continue;
      const pair = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(e);
      if (pair) aliases.set(pair[2] ?? pair[1], pair[1]);
      else unreadable.push(e);
    }
  }
  for (const m of view.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);/g)) {
    if (/^\s*(?:""|-?\d[\d_.]*|true|false|null)\s*$/.test(m[2])) literals.add(m[1]);
  }
  return { aliases, literals, unreadable };
}

// How many times a name is assigned (its declaration counts as one).
function writesOf(view, name) {
  const escaped = name.replace(/\$/g, '\\$');
  return [...view.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*=(?!=)`, 'g'))].length;
}

// Rewrites each call through a local alias to the helper it names. An alias that is
// reassigned, or that cannot be followed to a name, is left as it is, so its call
// stays unknown and routes consent.
function resolveAliases(code) {
  const view = stripStrings(code);
  const { aliases, literals, unreadable } = bindings(view);
  const target = new Map();
  for (const [name, t] of aliases) {
    target.set(name, writesOf(view, name) > 1 ? null : t);
  }
  let out = code;
  for (const name of target.keys()) {
    let t = target.get(name);
    for (let hop = 0; hop < 10 && t !== null && t !== name && target.has(t); hop += 1) {
      t = target.get(t);
    }
    // Unresolvable, self-referential, or a chain that did not end: leave the call unknown.
    if (t === null || t === name || target.has(t)) continue;
    const escaped = name.replace(/\$/g, '\\$');
    out = out.replace(new RegExp(`(?<![\\w$.])${escaped}(\\s*)\\(`, 'g'), `${t}$1(`);
  }
  return { code: out, literals, unreadable };
}

// Names a file calls in callee position, after aliases are resolved. A name is
// exempt only if the file declares it as a function (its body is scanned like the
// rest) or binds it to a plain literal. Computed calls and calls on call results
// are reported too.
function calledNames(resolved) {
  const view = stripStrings(resolved.code);
  const names = new Set(resolved.unreadable.map((e) => `<pattern:${e}>`));
  for (const m of view.matchAll(/(?<!function )(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g))
    names.add(m[1]);
  for (const m of view.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  if (/\]\s*\(/.test(view)) names.add('<computed>');
  if (/\)\s*\(/.test(view)) names.add('<call-result>');
  // A helper is local when the file declares it as a function, or binds it once to an
  // arrow or function expression. Its body is scanned with the rest of the file.
  const declared = new Set([
    ...[...view.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    ...[
      ...view.matchAll(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g
      ),
    ]
      .map((m) => m[1])
      .filter((n) => writesOf(view, n) <= 1),
  ]);
  return [...names]
    .filter((n) => !KEYWORDS.has(n) && !declared.has(n) && !resolved.literals.has(n))
    .sort();
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
    // Aliases are resolved first, so every rule sees the helper a call really names.
    const resolvedSource = resolveAliases(m.source);
    const resolved = resolveAliases(stripComments(m.source));
    const code = resolved.code;
    collect(out, 'irreversible', m.path, matchRules(IRREVERSIBLE_RULES, resolvedSource.code));
    collect(out, 'destructive', m.path, [
      ...matchRules(DESTRUCTIVE_RULES, code),
      ...noopRollbackRule(code),
    ]);
    collect(out, 'contracting', m.path, matchRules(CONTRACTING_RULES, code));
    collect(out, 'constraint', m.path, matchRules(CONSTRAINT_RULES, code));
    const unknown = calledNames(resolved).filter((n) => !Object.hasOwn(KNOWN_CALLS, n));
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
