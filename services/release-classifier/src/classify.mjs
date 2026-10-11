// Static reversibility classifier for a Ghost upgrade range. Reads migration
// source text only; nothing is executed. Rules and their rationale: ../README.md.
//
// Each file is parsed once by acorn; every rule reads its syntax tree, never the
// raw text.

import { compileFunction } from 'node:vm';
import { checkGrammar, FLAG_KEY, parseModule } from './grammar.mjs';

export { KNOWN_CALLS } from './allowlist.mjs';

// Open owner rulings. Each class is routed by one constant, and consent is the
// safe default until the owner rules.
export const CONTRACTING_ROUTE = 'consent';
export const CONSTRAINT_ROUTE = 'consent';

// A name decides its class wherever it occurs as an identifier node: called,
// passed by reference, aliased, destructured, optionally chained or used as a
// property name. A string that spells one is data, not a hit.

// Hard consent: Ghost's flag (see FLAG_KEY), a helper that sets it, or the dropTables wrapper.
export const IRREVERSIBLE_RULES = Object.freeze([
  { name: 'helper', names: ['createIrreversibleMigration'] },
  { name: 'wrapper', names: ['dropTables'] },
]);

// Hard consent: data or structure removed with no way back from the migration.
// Also by node elsewhere: `del` not called with no argument, and `truncate`.
export const DESTRUCTIVE_RULES = Object.freeze([
  { name: 'delete-table', names: ['deleteTable'] },
  { name: 'recreate-table', names: ['recreateTable'] },
  { name: 'drop-development-copy', names: ['dropDevelopmentCopy'] },
  { name: 'remove-setting', names: ['removeSetting'] },
  { name: 'delete-call', names: ['delete'] },
]);

// Lossy, routed by CONTRACTING_ROUTE: drops a column, deletes rows, or removes
// permission rows. A rollback re-adds a column empty, and a delete loses rows.
// `data-delete`, a `.del()` with no argument, is read from the call directly.
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

// A migration is a few KB. Anything far past that is not read.
const MAX_SOURCE = 1_000_000;

// A no-op rollback in a file that also calls something destructive-looking. The
// rollback then restores nothing, so the removal cannot be undone.
const DESTRUCTIVE_WORD = /^(?:drop|delete|del|remove|truncate|discard|wipe|purge|recreate)\w*$/i;

// Visits every node of the tree, parent before child.
function walk(node, visit) {
  visit(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, visit);
      }
    }
  }
}

const isFunction = (n) =>
  n?.type === 'FunctionDeclaration' ||
  n?.type === 'FunctionExpression' ||
  n?.type === 'ArrowFunctionExpression';
const destructiveName = (id) => id?.type === 'Identifier' && DESTRUCTIVE_WORD.test(id.name);
const isNamed = (n, name) => n?.type === 'Identifier' && n.name === name;
const isString = (n) => n?.type === 'Literal' && typeof n.value === 'string';
const isLogCall = (s) =>
  s.type === 'ExpressionStatement' &&
  s.expression.type === 'CallExpression' &&
  !s.expression.optional &&
  s.expression.callee.type === 'MemberExpression' &&
  !s.expression.callee.computed &&
  isNamed(s.expression.callee.object, 'logging') &&
  s.expression.callee.property.type === 'Identifier';

// The function a `down` is bound to, as a declaration, a key, a variable or an
// assignment, else null.
function downFunction(n) {
  switch (n.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return isNamed(n.id, 'down') ? n : null;
    case 'Property':
      return !n.computed && isNamed(n.key, 'down') ? n.value : null;
    case 'VariableDeclarator':
      return isNamed(n.id, 'down') ? n.init : null;
    case 'AssignmentExpression': {
      const l = n.left;
      const named =
        isNamed(l, 'down') ||
        (l.type === 'MemberExpression' && !l.computed && isNamed(l.property, 'down'));
      return n.operator === '=' && named ? n.right : null;
    }
    default:
      return null;
  }
}

// Class hits and the no-op rollback, read from the tree. Comments are never
// nodes, and a string is read only as raw SQL or as the path of a `require`.
function scan(program, source) {
  const found = {
    irreversible: new Set(),
    destructive: new Set(),
    contracting: new Set(),
    constraint: new Set(),
  };
  const record = (name) => {
    for (const { cls, rule } of NAME_TABLE.get(name) ?? []) found[cls].add(rule);
  };
  const bareDel = new Set();
  let foreign = false;
  let destructiveCall = false;
  let emptyDown = false;

  walk(program, (n) => {
    switch (n.type) {
      case 'Identifier':
        record(n.name);
        if (n.name.toLowerCase() === 'truncate') found.destructive.add('raw-truncate');
        if (n.name === 'del') {
          if (bareDel.has(n)) found.contracting.add('data-delete');
          else found.destructive.add('del-with-argument');
        }
        // A non-ASCII or escaped identifier is not read: the file routes consent.
        if (/[^\x00-\x7f]|\\/.test(source.slice(n.start, n.end))) foreign = true;
        break;
      case 'UnaryExpression':
        if (n.operator === 'delete') {
          record('delete');
          if (n.argument.type === 'ParenthesizedExpression') destructiveCall = true;
        }
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (destructiveName(n.id)) destructiveCall = true;
        break;
      case 'Literal':
        if (typeof n.value === 'string') {
          for (const r of SQL_RULES) if (r.pattern.test(n.value)) found.destructive.add(r.name);
        }
        break;
      case 'TemplateElement': {
        const text = n.value.cooked ?? n.value.raw;
        for (const r of SQL_RULES) if (r.pattern.test(text)) found.destructive.add(r.name);
        break;
      }
      case 'Property': {
        const k = n.key;
        if (n.method && !n.computed && destructiveName(k)) destructiveCall = true;
        const named = isNamed(k, FLAG_KEY) || (isString(k) && k.value === FLAG_KEY);
        if (named && n.value.type === 'Literal' && n.value.value === true) {
          found.irreversible.add('flag');
        }
        break;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const c = n.callee;
        const prop = c.type === 'MemberExpression' && !c.computed ? c.property : c;
        if (destructiveName(prop)) destructiveCall = true;
        if (
          c.type === 'MemberExpression' &&
          !c.computed &&
          !c.optional &&
          !n.optional &&
          isNamed(c.property, 'del') &&
          n.arguments.length === 0
        ) {
          bareDel.add(c.property);
        }
        // A helper name spelled as the argument of `require` is a module, not data.
        if (
          n.type === 'CallExpression' &&
          !n.optional &&
          isNamed(prop, 'require') &&
          n.arguments.length === 1 &&
          isString(n.arguments[0])
        ) {
          record(n.arguments[0].value);
        }
        break;
      }
      default:
        break;
    }
    const fn = downFunction(n);
    if (isFunction(fn) && !fn.generator && fn.body.type === 'BlockStatement') {
      if (fn.body.body.every((s) => s.type === 'EmptyStatement' || isLogCall(s))) emptyDown = true;
    }
  });
  return { found, foreign, noopRollback: destructiveCall && emptyDown };
}

// Wrapper parameters of a CommonJS module, so the source compiles as Node would
// load it. Compiling runs nothing.
const MODULE_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

function compiles(source) {
  try {
    compileFunction(source, MODULE_PARAMS);
    return true;
  } catch {
    return false;
  }
}

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
  const text = String(source);
  if (text.length > MAX_SOURCE) {
    out.unclassified.push('too-large');
    return out;
  }
  let program;
  try {
    program = parseModule(text);
  } catch (err) {
    if (err instanceof RangeError) out.unclassified.push('nesting');
    else if (err instanceof SyntaxError)
      out.unclassified.push(compiles(text) ? 'unparsable' : 'syntax');
    else throw err;
    return out;
  }
  // An empty or comment-only file proves nothing, so it is not fast-path.
  if (program.body.length === 0) {
    out.unclassified.push('empty');
    return out;
  }

  let result;
  try {
    result = scan(program, text);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    out.unclassified.push('nesting');
    return out;
  }
  if (result.foreign) {
    out.unclassified.push('non-ascii-identifier');
    return out;
  }
  for (const cls of ['irreversible', 'destructive', 'contracting', 'constraint']) {
    out[cls].push(...result.found[cls]);
  }
  if (result.noopRollback) out.destructive.push('noop-rollback');

  if (!compiles(text)) {
    out.unclassified.push('syntax');
    return out;
  }
  const refused = checkGrammar(program);
  if (refused !== null) out.unclassified.push(refused);
  return out;
}

function collect(out, cls, path, names) {
  for (const rule of names) out[cls].push({ path, rule });
}

// Input: from, to, migrations ({ folder, path, source }[]) and optionally folders,
// every version folder of the tree. With folders, a range with no folder in it
// is refused, as an empty answer would read as fast-path.
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
