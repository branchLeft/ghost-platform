// A positive grammar over the token stream. A file is fast-path only if it is
// made entirely of the forms this parser accepts; the first token it does not
// accept is the reason, and the file routes consent. The accepted forms are
// listed in ../README.md, section "Fast-path grammar".

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

const BINARY = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
]);
const UNARY = new Set(['-', '+', '!']);
const MAX_DEPTH = 64;

// Ghost's runner refuses a rollback when this key is truthy, so the grammar
// accepts it only with the literal `false` as its whole value.
export const FLAG_KEY = 'irreversible';

class Reject extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const OTHER = Object.freeze({ kind: 'other' });
const EOF = Object.freeze({ t: 'eof', v: '', nl: true, pos: -1 });

function nameOf(tok) {
  switch (tok.t) {
    case 'id':
    case 'punct':
      return tok.v;
    case 'str':
      return 'string';
    case 'num':
      return 'number';
    case 'eof':
      return 'end-of-file';
    case 'regex':
      return 'regex';
    case 'tmpl':
      return 'template';
    default:
      return 'template-substitution';
  }
}

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.scopes = [new Map()];
    this.fnDepth = 0;
    this.depth = 0;
    // One entry per enclosing function: is it async? `await` is an operator only
    // directly inside an async function, and an ordinary name elsewhere.
    this.asyncStack = [];
  }

  peek(k = 0) {
    return this.toks[this.i + k] ?? EOF;
  }

  next() {
    const t = this.peek();
    this.i += 1;
    return t;
  }

  isPunct(v, k = 0) {
    const t = this.peek(k);
    return t.t === 'punct' && t.v === v;
  }

  isId(v, k = 0) {
    const t = this.peek(k);
    return t.t === 'id' && t.v === v;
  }

  fail(tok) {
    throw new Reject(nameOf(tok));
  }

  expect(v) {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) this.fail(t);
  }

  declare(name, binding) {
    if (RESERVED.has(name)) throw new Reject(name);
    for (const scope of this.scopes) if (scope.has(name)) throw new Reject(name);
    this.scopes[this.scopes.length - 1].set(name, binding);
  }

  lookup(name) {
    for (let k = this.scopes.length - 1; k >= 0; k -= 1) {
      const b = this.scopes[k].get(name);
      if (b) return b;
    }
    return undefined;
  }

  // A name used as a value. Only a declared name resolves, so a keyword or a
  // global is refused here.
  reference(tok) {
    const b = this.lookup(tok.v);
    if (!b) this.fail(tok);
    return b.kind === 'local'
      ? { kind: 'other', name: tok.v }
      : { kind: b.kind, imported: b.imported, name: tok.v };
  }

  program() {
    while (this.peek().t !== 'eof') this.statement(true);
  }

  // A statement ends at `;`, at `}`, at the end, or at a line break. A line break
  // before `[` or a template is refused: JavaScript would read it as a continuation.
  end() {
    const t = this.peek();
    if (t.t === 'punct' && t.v === ';') {
      this.next();
      return;
    }
    if (t.t === 'eof' || (t.t === 'punct' && t.v === '}')) return;
    if (t.nl && !(t.t === 'punct' && t.v === '[') && !t.t.startsWith('tmpl')) return;
    this.fail(t);
  }

  statement(top) {
    const t = this.peek();
    if (t.t === 'punct' && t.v === ';') {
      this.next();
      return;
    }
    if (t.t === 'punct' && t.v === '{') this.fail(t);
    if (t.t === 'id') {
      if (t.v === 'const' || t.v === 'let') {
        this.declaration();
        return;
      }
      if (t.v === 'function') {
        this.next();
        this.functionRest({ declaration: true });
        return;
      }
      if (t.v === 'async' && this.isId('function', 1) && !this.peek(1).nl) {
        this.next();
        this.next();
        this.functionRest({ declaration: true, isAsync: true });
        return;
      }
      if (t.v === 'return' && this.fnDepth > 0) {
        this.next();
        const n = this.peek();
        const bare = n.nl || n.t === 'eof' || (n.t === 'punct' && (n.v === ';' || n.v === '}'));
        if (!bare) this.expression();
        this.end();
        return;
      }
      if (
        t.v === 'module' &&
        top &&
        this.isPunct('.', 1) &&
        this.isId('exports', 2) &&
        this.isPunct('=', 3)
      ) {
        this.i += 4;
        this.expression();
        this.end();
        return;
      }
    }
    this.expression();
    this.end();
  }

  declaration() {
    this.next();
    for (;;) {
      const t = this.next();
      if (t.t === 'id') {
        if (RESERVED.has(t.v)) throw new Reject(t.v);
        this.expect('=');
        const v = this.expression();
        const binding =
          v.kind === 'module' || v.kind === 'helper' || v.kind === 'handle'
            ? { kind: v.kind, imported: v.imported }
            : { kind: 'local' };
        this.declare(t.v, binding);
      } else if (t.t === 'punct' && t.v === '{') {
        this.pattern();
      } else {
        this.fail(t);
      }
      if (!this.isPunct(',')) break;
      this.next();
    }
    this.end();
  }

  // `{ a, b: c }` taken from a known module. Defaults, rest and nesting are refused.
  pattern() {
    const entries = [];
    while (!this.isPunct('}')) {
      const key = this.next();
      if (key.t !== 'id') this.fail(key);
      let local = key;
      if (this.isPunct(':')) {
        this.next();
        local = this.next();
        if (local.t !== 'id') this.fail(local);
      }
      entries.push({ key, local });
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct('}')) this.fail(this.peek());
    }
    this.next();
    this.expect('=');
    const init = this.expression();
    if (init.kind !== 'module') throw new Reject(init.name ?? 'destructuring');
    for (const { key, local } of entries) {
      if (!EXPORT_SET.has(key.v)) throw new Reject(key.v);
      this.declare(local.v, { kind: 'helper', imported: key.v });
    }
  }

  // `opts.runtime` marks a function that is directly a migration function.
  expression(opts) {
    // A migration nests a few levels. Depth well past that is refused, which
    // also bounds the stack and the arrow look-ahead below.
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new Reject('nesting');
    let v = this.unary(opts);
    while (this.peek().t === 'punct' && BINARY.has(this.peek().v)) {
      this.next();
      this.unary();
      v = OTHER;
    }
    this.depth -= 1;
    return v;
  }

  unary(opts) {
    const t = this.peek();
    if (t.t === 'punct' && UNARY.has(t.v)) {
      this.next();
      this.unary();
      return OTHER;
    }
    if (t.t === 'id' && t.v === 'await' && this.asyncStack[this.asyncStack.length - 1] === true) {
      this.next();
      this.unary();
      return OTHER;
    }
    return this.postfix(opts);
  }

  postfix(opts) {
    let v = this.primary(opts);
    for (;;) {
      const t = this.peek();
      if (t.t === 'punct' && t.v === '.') {
        this.next();
        const n = this.next();
        if (n.t !== 'id') this.fail(n);
        if (v.kind === 'module') {
          if (!EXPORT_SET.has(n.v)) this.fail(n);
          v = { kind: 'helper', imported: n.v, name: n.v };
        } else if (METHOD_SET.has(n.v) && this.isPunct('(')) {
          v = { kind: 'method', name: n.v };
        } else {
          this.fail(n);
        }
      } else if (t.t === 'punct' && t.v === '(') {
        if (v.kind !== 'helper' && v.kind !== 'handle' && v.kind !== 'method') {
          throw new Reject(v.name ?? 'computed-callee');
        }
        this.next();
        this.args(v);
        v = OTHER;
      } else if (t.t === 'tmpl' || t.t === 'tmplHead') {
        this.fail(t);
      } else {
        return v;
      }
    }
  }

  args(callee) {
    const runtime = callee.kind === 'helper' && WRAPPER_SET.has(callee.imported);
    for (;;) {
      if (this.isPunct(')')) {
        this.next();
        return;
      }
      if (this.isPunct('...')) {
        this.next();
        this.expression();
      } else {
        this.expression({ runtime });
      }
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(')')) this.fail(this.peek());
    }
  }

  primary(opts) {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'str' || t.t === 'tmpl') {
      this.next();
      return OTHER;
    }
    if (t.t === 'id') return this.identifier(opts);
    if (t.t === 'punct') {
      if (t.v === '(') {
        if (this.parenIsArrow()) return this.arrow(false, opts);
        this.next();
        const v = this.expression();
        this.expect(')');
        return v;
      }
      if (t.v === '[') {
        this.next();
        this.array();
        return OTHER;
      }
      if (t.v === '{') {
        this.next();
        this.object();
        return OTHER;
      }
    }
    return this.fail(t);
  }

  identifier(opts) {
    const t = this.next();
    const v = t.v;
    if (v === 'null' || v === 'true' || v === 'false') return OTHER;
    if (v === 'require') return this.requireCall();
    if (v === 'function') return this.functionRest({ runtime: opts?.runtime });
    if (v === 'async') {
      const n = this.peek();
      if (!n.nl && n.t === 'id' && n.v === 'function') {
        this.next();
        return this.functionRest({ runtime: opts?.runtime, isAsync: true });
      }
      if (!n.nl && (this.parenIsArrow() || (n.t === 'id' && this.isPunct('=>', 1)))) {
        return this.arrow(true, opts);
      }
      return this.fail(t);
    }
    if (this.isPunct('=>') && !this.peek().nl) {
      this.i -= 1;
      return this.arrow(false, opts);
    }
    return this.reference(t);
  }

  requireCall() {
    this.expect('(');
    const arg = this.next();
    if (arg.t !== 'str') throw new Reject('require');
    this.expect(')');
    if (!Object.hasOwn(KNOWN_MODULES, arg.v)) throw new Reject(`require:${arg.v}`);
    return { kind: 'module' };
  }

  array() {
    while (!this.isPunct(']')) {
      if (this.isPunct('...')) this.next();
      this.expression();
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(']')) this.fail(this.peek());
    }
    this.next();
  }

  object() {
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        this.expression();
      } else {
        const key = this.next();
        if (key.t !== 'id' && key.t !== 'str' && key.t !== 'num') this.fail(key);
        if (key.t !== 'num' && key.v === FLAG_KEY) {
          const literalFalse =
            this.isPunct(':') &&
            this.isId('false', 1) &&
            (this.isPunct(',', 2) || this.isPunct('}', 2));
          if (!literalFalse) throw new Reject(FLAG_KEY);
        }
        if (this.isPunct(':')) {
          this.next();
          const entry = key.t !== 'num' && ENTRY_SET.has(key.v);
          this.expression({ runtime: entry });
        } else if (key.t === 'id' && (this.isPunct(',') || this.isPunct('}'))) {
          this.reference(key);
        } else {
          this.fail(this.peek());
        }
      }
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct('}')) this.fail(this.peek());
    }
    this.next();
  }

  // Is the `(` at the cursor the start of an arrow function's parameters?
  parenIsArrow() {
    if (!this.isPunct('(')) return false;
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k += 1) {
      const t = this.toks[k];
      if (t.t !== 'punct') continue;
      if (t.v === '(') depth += 1;
      else if (t.v === ')') {
        depth -= 1;
        if (depth === 0) {
          const after = this.toks[k + 1];
          return after !== undefined && after.t === 'punct' && after.v === '=>' && !after.nl;
        }
      }
    }
    return false;
  }

  params() {
    const names = [];
    this.expect('(');
    while (!this.isPunct(')')) {
      const t = this.next();
      if (t.t !== 'id') this.fail(t);
      names.push(t.v);
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(')')) this.fail(this.peek());
    }
    this.next();
    return names;
  }

  // Runs `body` with the parameters bound in a fresh scope. Inside a migration
  // function the handle names are callable; in any other function a parameter
  // is a plain value and calling it is refused.
  withFunction(names, runtime, isAsync, body) {
    this.scopes.push(new Map());
    this.fnDepth += 1;
    this.asyncStack.push(isAsync);
    for (const n of names) {
      this.declare(n, { kind: runtime && HANDLE_SET.has(n) ? 'handle' : 'local' });
    }
    try {
      body();
    } finally {
      this.asyncStack.pop();
      this.fnDepth -= 1;
      this.scopes.pop();
    }
  }

  block() {
    this.expect('{');
    while (!this.isPunct('}')) {
      if (this.peek().t === 'eof') this.fail(this.peek());
      this.statement(false);
    }
    this.next();
  }

  // The cursor is after `function`.
  functionRest({ declaration = false, runtime = false, isAsync = false } = {}) {
    if (this.isPunct('*')) this.fail(this.peek());
    let name = null;
    if (this.peek().t === 'id') name = this.next().v;
    if (declaration && name === null) this.fail(this.peek());
    if (name !== null && declaration) this.declare(name, { kind: 'local' });
    const migration = runtime || (name !== null && ENTRY_SET.has(name));
    const names = this.params();
    this.withFunction(names, migration, isAsync, () => {
      if (name !== null && !declaration) this.declare(name, { kind: 'local' });
      this.block();
    });
    return OTHER;
  }

  // `async` has been consumed when `isAsync`; the cursor is at the parameters.
  arrow(isAsync, opts) {
    let names;
    if (this.peek().t === 'id') {
      names = [this.next().v];
    } else {
      names = this.params();
    }
    const arrow = this.next();
    if (arrow.t !== 'punct' || arrow.v !== '=>') this.fail(arrow);
    this.withFunction(names, opts?.runtime === true, isAsync, () => {
      if (this.isPunct('{')) this.block();
      else this.expression();
    });
    return OTHER;
  }
}

// Returns null when the file is made only of accepted forms, otherwise the name
// of the first token that is not.
export function checkGrammar(tokens) {
  try {
    new Parser(tokens).program();
    return null;
  } catch (err) {
    if (err instanceof Reject) return err.reason;
    // Nesting deep enough to exhaust the stack is refused, not an error of ours.
    if (err instanceof RangeError) return 'nesting';
    throw err;
  }
}
