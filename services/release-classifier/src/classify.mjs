// Static reversibility classifier for a Ghost upgrade range. Reads migration
// source text only; nothing is executed. Rules and their rationale: ../README.md.
//
// Each file is lexed once; every rule reads its tokens, never the raw text.

import { compileFunction } from 'node:vm';
import { checkGrammar, FLAG_KEY } from './grammar.mjs';
import { lex, Unlexable } from './lex.mjs';

export { KNOWN_CALLS } from './allowlist.mjs';

// Open owner rulings. Each class is routed by one constant, and consent is the
// safe default until the owner rules.
export const CONTRACTING_ROUTE = 'consent';
export const CONSTRAINT_ROUTE = 'consent';

// A name decides its class wherever it occurs as an identifier token: called,
// passed by reference, aliased, destructured, optionally chained or used as a
// property name. A string that spells one is data, not a hit.

// Hard consent: Ghost's flag (see FLAG_KEY), a helper that sets it, or the dropTables wrapper.
export const IRREVERSIBLE_RULES = Object.freeze([
  { name: 'helper', names: ['createIrreversibleMigration'] },
  { name: 'wrapper', names: ['dropTables'] },
]);

// Hard consent: data or structure removed with no way back from the migration.
// Also by token elsewhere: `del` not called with no argument, and `truncate`.
export const DESTRUCTIVE_RULES = Object.freeze([
  { name: 'delete-table', names: ['deleteTable'] },
  { name: 'recreate-table', names: ['recreateTable'] },
  { name: 'drop-development-copy', names: ['dropDevelopmentCopy'] },
  { name: 'remove-setting', names: ['removeSetting'] },
  { name: 'delete-call', names: ['delete'] },
]);

// Lossy, routed by CONTRACTING_ROUTE: drops a column, deletes rows, or removes
// permission rows. A rollback re-adds a column empty, and a delete loses rows.
// `data-delete`, a `.del()` with no argument, is read from the tokens directly.
export const CONTRACTING_RULES = Object.freeze([
  { name: 'drop-column', names: ['dropColumn', 'dropColumns', 'createDropColumnMigration'] },
  {
    name: 'remove-permission',
    names: ['removePermission', 'removePermissionFromRole', 'createRemovePermissionMigration'],
  },
]);

// Schema-only constraint drops, routed by CONSTRAINT_ROUTE, kept apart from data loss.
export const CONSTRAINT_RULES = Object.freeze([
  { name: 'drop-constraint', names: ['dropIndex', 'dropUnique', 'dropForeign'] },
]);

// Raw SQL spelled in a string or template. Destructive wherever it appears.
export const SQL_RULES = Object.freeze([
  { name: 'raw-drop-table', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'raw-delete-from', pattern: /\bDELETE\s+FROM\b/i },
  { name: 'raw-truncate', pattern: /\btruncate\b/i },
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

const NAME_TABLE = new Map();
for (const [cls, rules] of [
  ['irreversible', IRREVERSIBLE_RULES],
  ['destructive', DESTRUCTIVE_RULES],
  ['contracting', CONTRACTING_RULES],
  ['constraint', CONSTRAINT_RULES],
]) {
  for (const rule of rules) {
    for (const name of rule.names) {
      NAME_TABLE.set(name, [...(NAME_TABLE.get(name) ?? []), { cls, rule: rule.name }]);
    }
  }
}

const isPunct = (tok, v) => tok !== undefined && tok.t === 'punct' && tok.v === v;
const TEMPLATE_PARTS = new Set(['tmpl', 'tmplHead', 'tmplMid', 'tmplTail']);

// Class hits, read from tokens. Comments are never tokens, and a string is read
// only as raw SQL or as the path of a `require`.
function scanHits(tokens) {
  const found = {
    irreversible: new Set(),
    destructive: new Set(),
    contracting: new Set(),
    constraint: new Set(),
  };
  const record = (name) => {
    for (const { cls, rule } of NAME_TABLE.get(name) ?? []) found[cls].add(rule);
  };
  tokens.forEach((tok, i) => {
    const prev = tokens[i - 1];
    if (tok.t === 'id') {
      record(tok.v);
      if (tok.v.toLowerCase() === 'truncate') found.destructive.add('raw-truncate');
      if (tok.v === 'del') {
        const bare =
          isPunct(prev, '.') && isPunct(tokens[i + 1], '(') && isPunct(tokens[i + 2], ')');
        if (bare) found.contracting.add('data-delete');
        else found.destructive.add('del-with-argument');
      }
    }
    if ((tok.t === 'id' || tok.t === 'str') && tok.v === FLAG_KEY) {
      const colon = isPunct(tokens[i + 1], ']') ? tokens[i + 2] : tokens[i + 1];
      const after = isPunct(tokens[i + 1], ']') ? tokens[i + 3] : tokens[i + 2];
      if (isPunct(colon, ':') && after?.t === 'id' && after.v === 'true') {
        found.irreversible.add('flag');
      }
    }
    if (tok.t === 'str' || TEMPLATE_PARTS.has(tok.t)) {
      for (const r of SQL_RULES) if (r.pattern.test(tok.v)) found.destructive.add(r.name);
    }
    // A helper name spelled as the argument of `require` is a module, not data.
    if (
      tok.t === 'str' &&
      isPunct(prev, '(') &&
      tokens[i - 2]?.t === 'id' &&
      tokens[i - 2].v === 'require' &&
      isPunct(tokens[i + 1], ')')
    ) {
      record(tok.v);
    }
  });
  return found;
}

// A no-op rollback in a file that also calls something destructive-looking. The
// rollback then restores nothing, so the removal cannot be undone.
const DESTRUCTIVE_WORD = /^(?:drop|delete|del|remove|truncate|discard|wipe|purge|recreate)\w*$/i;

function skipBalanced(tokens, i) {
  let depth = 0;
  for (let k = i; k < tokens.length; k += 1) {
    if (isPunct(tokens[k], '(')) depth += 1;
    else if (isPunct(tokens[k], ')')) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return tokens.length;
}

// After a `down` token: is what follows a function whose body is empty, or only
// logging calls?
function emptyRollbackAt(tokens, from) {
  let j = from + 1;
  if (isPunct(tokens[j], ':') || isPunct(tokens[j], '=')) j += 1;
  if (tokens[j]?.t === 'id' && tokens[j].v === 'async') j += 1;
  if (tokens[j]?.t === 'id' && tokens[j].v === 'function') j += 1;
  if (!isPunct(tokens[j], '(')) return false;
  j = skipBalanced(tokens, j);
  if (isPunct(tokens[j], '=>')) j += 1;
  if (!isPunct(tokens[j], '{')) return false;
  j += 1;
  for (;;) {
    if (isPunct(tokens[j], '}')) return true;
    const isLogCall =
      tokens[j]?.t === 'id' &&
      tokens[j].v === 'logging' &&
      isPunct(tokens[j + 1], '.') &&
      tokens[j + 2]?.t === 'id' &&
      isPunct(tokens[j + 3], '(');
    if (!isLogCall) return false;
    j = skipBalanced(tokens, j + 3);
    if (isPunct(tokens[j], ';')) j += 1;
  }
}

function noopRollback(tokens) {
  const looksDestructive = tokens.some(
    (t, i) => t.t === 'id' && DESTRUCTIVE_WORD.test(t.v) && isPunct(tokens[i + 1], '(')
  );
  if (!looksDestructive) return false;
  return tokens.some((t, i) => t.t === 'id' && t.v === 'down' && emptyRollbackAt(tokens, i));
}

// Wrapper parameters of a CommonJS module, so the source compiles as Node would
// load it. Compiling runs nothing.
const MODULE_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

// Classifies one migration source and never executes it. Returns the rule names
// hit per class, and the reasons the fast-path grammar refused it.
export function classifySource(source) {
  const out = {
    irreversible: [],
    destructive: [],
    contracting: [],
    constraint: [],
    unclassified: [],
  };
  let tokens;
  try {
    tokens = lex(source);
  } catch (err) {
    if (!(err instanceof Unlexable)) throw err;
    out.unclassified.push(err.reason);
    return out;
  }
  // An empty or comment-only file proves nothing, so it is not fast-path.
  if (tokens.length === 0) {
    out.unclassified.push('unlexable');
    return out;
  }

  const hits = scanHits(tokens);
  for (const cls of ['irreversible', 'destructive', 'contracting', 'constraint']) {
    out[cls].push(...hits[cls]);
  }
  if (noopRollback(tokens)) out.destructive.push('noop-rollback');

  try {
    compileFunction(String(source), MODULE_PARAMS);
  } catch {
    out.unclassified.push('syntax');
    return out;
  }
  const refused = checkGrammar(tokens);
  if (refused !== null) out.unclassified.push(refused);
  return out;
}

function collect(out, cls, path, names) {
  for (const rule of names) out[cls].push({ path, rule });
}

/**
 * @param {{ from: string, to: string, migrations: Array<{ folder: string, path: string, source: string }>,
 *   folders?: string[] }} input `folders` lists every version folder of the tree. When given, a range
 *   with no folder in it is refused, since an empty answer would read as fast-path.
 */
export function classifyRange({ from, to, migrations, folders }) {
  const f = parseRelease(from);
  const t = parseRelease(to);
  if (compareLines([t.major, t.minor], [f.major, f.minor]) < 0) {
    throw new Error(`target ${to} precedes ${from}`);
  }
  if (folders !== undefined) {
    if (!folders.some((name) => inRange(parseFolder(name), f, t))) {
      throw new Error(`no migration folder lies in the range ${from} to ${to}`);
    }
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
    const file = classifySource(m.source);
    collect(out, 'irreversible', m.path, file.irreversible);
    collect(out, 'destructive', m.path, file.destructive);
    collect(out, 'contracting', m.path, file.contracting);
    collect(out, 'constraint', m.path, file.constraint);
    collect(
      out,
      'unclassified',
      m.path,
      file.unclassified.map((n) => `unclassified:${n}`)
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
