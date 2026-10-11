// A positive grammar over the syntax tree acorn builds. A file is fast-path only
// if it is made entirely of the forms this walk accepts; the first node it does
// not accept is the reason, and the file routes consent. The accepted forms are
// listed in ../README.md, section "Fast-path grammar".

import { parse } from 'acorn';
import {
  HANDLES,
  KNOWN_MODULES,
  METHODS,
  MIGRATION_ENTRY_NAMES,
  MIGRATION_WRAPPERS,
  MODULE_EXPORTS,
} from './allowlist.mjs';

const HANDLE_SET = new Set(HANDLES);
const METHOD_SET = new Set(METHODS);
const EXPORT_SET = new Set(MODULE_EXPORTS);
const WRAPPER_SET = new Set(MIGRATION_WRAPPERS);
const ENTRY_SET = new Set(MIGRATION_ENTRY_NAMES);

// A name that carries meaning to this grammar or to JavaScript may not be bound,
// so a local can never stand in for `require`, `module` or a keyword.
const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof let new null return super switch this ' +
    'throw true try typeof var void while with yield static implements interface package ' +
    'private protected public await async arguments eval undefined NaN Infinity require module exports'
  ).split(' ')
);

const BINARY = new Set(['+', '-', '*', '/', '%', '===', '!==', '==', '!=', '<', '>', '<=', '>=']);
const LOGICAL = new Set(['&&', '||']);
const UNARY = new Set(['-', '+', '!']);
const MAX_DEPTH = 64;

// Ghost's runner refuses a rollback when this key is truthy, so the grammar
// accepts it only with the literal `false` as its whole value.
export const FLAG_KEY = 'irreversible';

// The reason a statement or expression form gives when it is refused.
const REFUSED = {
  IfStatement: 'if',
  ForStatement: 'for',
  ForInStatement: 'for',
  ForOfStatement: 'for',
  WhileStatement: 'while',
  DoWhileStatement: 'do',
  TryStatement: 'try',
  ThrowStatement: 'throw',
  SwitchStatement: 'switch',
  ClassDeclaration: 'class',
  ClassExpression: 'class',
  BreakStatement: 'break',
  ContinueStatement: 'continue',
  DebuggerStatement: 'debugger',
  WithStatement: 'with',
  BlockStatement: '{',
  ThisExpression: 'this',
  NewExpression: 'new',
  MetaProperty: 'new',
  Super: 'super',
  YieldExpression: 'yield',
  ImportExpression: 'import',
};
const PATTERN = { ObjectPattern: '{', ArrayPattern: '[', RestElement: '...' };

class Reject extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const OTHER = Object.freeze({ kind: 'other' });
const LOCAL = Object.freeze({ kind: 'local' });

// acorn is the only reader of syntax. The wrapper of a CommonJS module lets
// `return` stand at the top, and parentheses stay nodes so `(a.b)()` is not `a.b()`.
// A top-level `await` is read so its hits are reported; `vm.compileFunction`
// refuses it, and the file routes consent as `syntax`.
export function parseModule(source) {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    preserveParens: true,
  });
}

// The text that names a property or key in a refusal.
function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  return typeof key.value === 'string' ? 'string' : 'number';
}

class Checker {
  constructor() {
    this.scopes = [new Map()];
    this.fnDepth = 0;
    this.depth = 0;
  }

  declare(name, binding) {
    if (RESERVED.has(name)) throw new Reject(name);
    for (const scope of this.scopes) if (scope.has(name)) throw new Reject(name);
    this.scopes[this.scopes.length - 1].set(name, binding);
  }

  // A name used as a value. Only a declared name resolves, so a keyword or a
  // global is refused here.
  reference(node) {
    for (let k = this.scopes.length - 1; k >= 0; k -= 1) {
      const b = this.scopes[k].get(node.name);
      if (b) {
        return b.kind === 'local'
          ? { kind: 'other', name: node.name }
          : { kind: b.kind, imported: b.imported, name: node.name };
      }
    }
    throw new Reject(node.name);
  }

  statement(node, top) {
    switch (node.type) {
      case 'EmptyStatement':
        return;
      case 'VariableDeclaration':
        this.declaration(node);
        return;
      case 'FunctionDeclaration':
        this.fn(node, { declaration: true });
        return;
      case 'ReturnStatement':
        if (this.fnDepth === 0) throw new Reject('return');
        if (node.argument) this.expression(node.argument);
        return;
      case 'ExpressionStatement': {
        const e = node.expression;
        const moduleExports =
          top &&
          e.type === 'AssignmentExpression' &&
          e.operator === '=' &&
          e.left.type === 'MemberExpression' &&
          !e.left.computed &&
          !e.left.optional &&
          e.left.object.type === 'Identifier' &&
          e.left.object.name === 'module' &&
          e.left.property.name === 'exports';
        this.expression(moduleExports ? e.right : e);
        return;
      }
      case 'LabeledStatement':
        throw new Reject(node.label.name);
      default:
        throw new Reject(REFUSED[node.type] ?? node.type);
    }
  }

  declaration(node) {
    if (node.kind !== 'const' && node.kind !== 'let') throw new Reject(node.kind);
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier') {
        if (RESERVED.has(d.id.name)) throw new Reject(d.id.name);
        if (!d.init) throw new Reject(';');
        const v = this.expression(d.init);
        const binding =
          v.kind === 'module' || v.kind === 'helper' || v.kind === 'handle'
            ? { kind: v.kind, imported: v.imported }
            : LOCAL;
        this.declare(d.id.name, binding);
      } else if (d.id.type === 'ObjectPattern') {
        this.pattern(d);
      } else {
        throw new Reject(PATTERN[d.id.type] ?? d.id.type);
      }
    }
  }

  // `{ a, b: c } = require(...)`: defaults, rest and nesting are refused, and
  // only the allowlisted exports of a known module may be taken.
  pattern(d) {
    const entries = d.id.properties.map((p) => {
      if (p.type === 'RestElement') throw new Reject('...');
      if (p.computed) throw new Reject('[');
      if (p.key.type !== 'Identifier') throw new Reject(keyName(p.key));
      const local = p.value;
      if (local.type === 'AssignmentPattern') throw new Reject('=');
      if (local.type !== 'Identifier') throw new Reject(PATTERN[local.type] ?? local.type);
      return { key: p.key.name, local: local.name };
    });
    if (!d.init) throw new Reject(';');
    const init = this.expression(d.init);
    if (init.kind !== 'module') throw new Reject(init.name ?? 'destructuring');
    for (const { key, local } of entries) {
      if (!EXPORT_SET.has(key)) throw new Reject(key);
      this.declare(local, { kind: 'helper', imported: key });
    }
  }

  // Runs `body` with the parameters bound in a fresh scope. Inside a migration
  // function the handle names are callable; in any other function a parameter
  // is a plain value and calling it is refused.
  withFunction(node, runtime, body) {
    const names = node.params.map((p) => {
      if (p.type === 'Identifier') return p.name;
      if (p.type === 'AssignmentPattern')
        throw new Reject(p.left.type === 'Identifier' ? '=' : '{');
      throw new Reject(PATTERN[p.type] ?? p.type);
    });
    this.scopes.push(new Map());
    this.fnDepth += 1;
    try {
      for (const n of names) {
        this.declare(n, { kind: runtime && HANDLE_SET.has(n) ? 'handle' : 'local' });
      }
      body();
    } finally {
      this.fnDepth -= 1;
      this.scopes.pop();
    }
  }

  block(node) {
    for (const s of node.body) this.statement(s, false);
  }

  fn(node, { declaration = false, runtime = false } = {}) {
    if (node.generator) throw new Reject('*');
    const name = node.id ? node.id.name : null;
    if (declaration && name !== null) this.declare(name, LOCAL);
    const migration = runtime || (name !== null && ENTRY_SET.has(name));
    this.withFunction(node, migration, () => {
      if (name !== null && !declaration) this.declare(name, LOCAL);
      this.block(node.body);
    });
    return OTHER;
  }

  arrow(node, opts) {
    this.withFunction(node, opts?.runtime === true, () => {
      if (node.body.type === 'BlockStatement') this.block(node.body);
      else this.expression(node.body);
    });
    return OTHER;
  }

  // `opts.runtime` marks a function that is directly a migration function.
  expression(node, opts) {
    // A migration nests a few levels. Depth well past that is refused, which
    // also bounds the stack.
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new Reject('nesting');
    const v = this.operand(node, opts);
    this.depth -= 1;
    return v;
  }

  // Binary and logical operators in any grouping, read left to right.
  operand(node, opts) {
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      this.operand(node.left, opts);
      if (!BINARY.has(node.operator) && !LOGICAL.has(node.operator)) {
        throw new Reject(node.operator);
      }
      this.operand(node.right);
      return OTHER;
    }
    return this.unary(node, opts);
  }

  unary(node, opts) {
    if (node.type === 'UnaryExpression') {
      if (!UNARY.has(node.operator)) throw new Reject(node.operator);
      this.unary(node.argument);
      return OTHER;
    }
    if (node.type === 'AwaitExpression') {
      this.unary(node.argument);
      return OTHER;
    }
    return this.postfix(node, opts);
  }

  postfix(node, opts) {
    switch (node.type) {
      case 'ChainExpression':
        return this.postfix(node.expression, opts);
      case 'MemberExpression':
        return this.member(node, false);
      case 'CallExpression':
        return this.call(node);
      case 'TaggedTemplateExpression':
        this.postfix(node.tag);
        throw new Reject(node.quasi.expressions.length > 0 ? 'template-substitution' : 'template');
      default:
        return this.primary(node, opts);
    }
  }

  member(node, isCallee) {
    const obj = this.postfix(node.object);
    if (node.optional) throw new Reject('?.');
    if (node.computed) throw new Reject('[');
    const name = node.property.name;
    if (node.property.type !== 'Identifier') throw new Reject(`#${name}`);
    if (obj.kind === 'module') {
      if (!EXPORT_SET.has(name)) throw new Reject(name);
      return { kind: 'helper', imported: name, name };
    }
    if (isCallee && METHOD_SET.has(name)) return { kind: 'method', name };
    throw new Reject(name);
  }

  call(node) {
    const c = node.callee;
    if (c.type === 'Identifier' && c.name === 'require' && !node.optional) {
      return this.requireCall(node);
    }
    const callee = c.type === 'MemberExpression' ? this.member(c, !node.optional) : this.postfix(c);
    if (node.optional) throw new Reject('?.');
    if (callee.kind !== 'helper' && callee.kind !== 'handle' && callee.kind !== 'method') {
      throw new Reject(callee.name ?? 'computed-callee');
    }
    const runtime = callee.kind === 'helper' && WRAPPER_SET.has(callee.imported);
    for (const a of node.arguments) {
      if (a.type === 'SpreadElement') this.expression(a.argument);
      else this.expression(a, { runtime });
    }
    return OTHER;
  }

  requireCall(node) {
    const [arg] = node.arguments;
    if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string' || arg.regex) {
      throw new Reject('require');
    }
    if (node.arguments.length > 1) throw new Reject(',');
    if (!Object.hasOwn(KNOWN_MODULES, arg.value)) throw new Reject(`require:${arg.value}`);
    return { kind: 'module' };
  }

  primary(node, opts) {
    switch (node.type) {
      case 'Literal':
        if (node.regex) throw new Reject('regex');
        return OTHER;
      case 'TemplateLiteral':
        if (node.expressions.length > 0) throw new Reject('template-substitution');
        return OTHER;
      case 'Identifier':
        if (node.name === 'require') throw new Reject('require');
        return this.reference(node);
      case 'ParenthesizedExpression':
        return this.expression(node.expression);
      case 'ArrayExpression':
        for (const el of node.elements) {
          if (el === null) throw new Reject(',');
          this.expression(el.type === 'SpreadElement' ? el.argument : el);
        }
        return OTHER;
      case 'ObjectExpression':
        node.properties.forEach((p) => this.property(p));
        return OTHER;
      case 'FunctionExpression':
        return this.fn(node, { runtime: opts?.runtime });
      case 'ArrowFunctionExpression':
        return this.arrow(node, opts);
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier' || node.left.type === 'MemberExpression') {
          this.postfix(node.left);
        }
        throw new Reject(node.operator);
      case 'UpdateExpression':
        if (!node.prefix) this.postfix(node.argument);
        throw new Reject(node.operator);
      case 'ConditionalExpression':
        this.operand(node.test);
        throw new Reject('?');
      case 'SequenceExpression':
        this.operand(node.expressions[0]);
        throw new Reject(',');
      default:
        throw new Reject(REFUSED[node.type] ?? node.type);
    }
  }

  property(p) {
    if (p.type === 'SpreadElement') {
      this.expression(p.argument);
      return;
    }
    if (p.value.generator) throw new Reject('*');
    if (p.computed) throw new Reject('[');
    const k = p.key;
    const name = k.type === 'Identifier' ? k.name : typeof k.value === 'string' ? k.value : null;
    if (name === FLAG_KEY) {
      const literalFalse =
        p.kind === 'init' &&
        !p.method &&
        !p.shorthand &&
        p.value.type === 'Literal' &&
        p.value.value === false;
      if (!literalFalse) throw new Reject(FLAG_KEY);
    }
    if (p.kind !== 'init' || (p.method && p.value.async)) throw new Reject(keyName(p.key));
    if (p.method) throw new Reject('(');
    if (p.shorthand) {
      this.reference(p.key);
      return;
    }
    this.expression(p.value, { runtime: name !== null && ENTRY_SET.has(name) });
  }
}

// Returns null when the file is made only of accepted forms, otherwise the name
// of the first node that is not.
export function checkGrammar(program) {
  try {
    const checker = new Checker();
    for (const s of program.body) checker.statement(s, true);
    return null;
  } catch (err) {
    if (err instanceof Reject) return err.reason;
    // Nesting deep enough to exhaust the stack is refused, not an error of ours.
    if (err instanceof RangeError) return 'nesting';
    throw err;
  }
}
