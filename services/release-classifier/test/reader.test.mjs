import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule } from '../src/grammar.mjs';
import { classifySource } from '../src/classify.mjs';

// The reader is acorn plus the tree walk. These are the scenarios of the
// hand-written lexer's tests, asserted through the tree the parser builds or
// the verdict the classifier gives.
const unclassified = (src) => classifySource(src).unclassified;
const consent = (src) => {
  const out = classifySource(src);
  return Object.values(out).some((reasons) => reasons.length > 0);
};

test('comments are not tokens, and a comment marker inside a string is not a comment', () => {
  assert.equal(parseModule('a // b\n/* c */ d').body.length, 2);
  const prog = parseModule("const g = '/content/images/*'; f(); /** doc */");
  assert.equal(prog.body.length, 2);
  assert.equal(prog.body[0].declarations[0].init.value, '/content/images/*');
  assert.equal(prog.body[1].expression.callee.name, 'f');
});

test('a line comment ends at every JavaScript line terminator', () => {
  for (const eol of ['\n', '\r', ' ', ' ']) {
    const body = parseModule(`// c${eol}removeSetting`).body;
    assert.equal(body.length, 1, JSON.stringify(eol));
    assert.equal(body[0].expression.name, 'removeSetting', JSON.stringify(eol));
  }
});

test('line breaks set the nl flag on the next token only', () => {
  // The lexer flagged a token that follows a line break. The parser's version
  // of that rule is automatic semicolon insertion: a break ends `a` before `++b`.
  const body = parseModule('a\n++b').body;
  assert.equal(body.length, 2);
  assert.equal(body[0].expression.name, 'a');
  assert.equal(body[1].expression.type, 'UpdateExpression');
  assert.equal(parseModule('a\nb\r\nc /* x\ny */;').body.length, 3);
});

test('strings are cooked: escapes spell the text they stand for', () => {
  const cooked = (src) => parseModule(src).body[0].expression.value;
  assert.equal(cooked("'DROP\\x20TABLE'"), 'DROP TABLE');
  assert.equal(cooked("'a\\u0020b\\u{20}c'"), 'a b c');
  assert.equal(cooked("'a\\nb\\tc'"), 'a\nb\tc');
  assert.equal(cooked("'q\\q'"), 'qq');
  assert.equal(cooked("'a\\'b'"), "a'b");
});

test('template literals nest, and their text is not code', () => {
  const t1 = parseModule('`a${b}c`').body[0].expression;
  assert.deepEqual(
    t1.quasis.map((q) => q.value.cooked),
    ['a', 'c']
  );
  assert.equal(t1.expressions[0].name, 'b');

  const t2 = parseModule('`${`${x}`}`').body[0].expression;
  assert.equal(t2.expressions.length, 1);
  assert.equal(t2.expressions[0].type, 'TemplateLiteral');
  assert.equal(t2.expressions[0].expressions[0].name, 'x');

  const t3 = parseModule('`} \\` /* `').body[0].expression;
  assert.equal(t3.quasis.length, 1);
  assert.equal(t3.quasis[0].value.cooked, '} ` /* ');

  const t4 = parseModule('`${ {a: 1}.a }`').body[0].expression;
  assert.equal(t4.expressions[0].type, 'MemberExpression');
  assert.equal(t4.expressions[0].object.type, 'ObjectExpression');
  assert.equal(t4.expressions[0].property.name, 'a');
});

test('regex literal or division is decided from what precedes the slash', () => {
  const div = parseModule('a / b / c').body[0].expression;
  assert.equal(div.type, 'BinaryExpression');
  assert.equal(div.operator, '/');
  assert.equal(parseModule('(a + b) / 2').body[0].expression.operator, '/');

  const re = parseModule('x = /a\\/b[/]c/gi').body[0].expression.right;
  assert.equal(re.regex.pattern, 'a\\/b[/]c');
  assert.equal(re.regex.flags, 'gi');

  const ret = parseModule('return /x/').body[0].argument;
  assert.equal(ret.regex.pattern, 'x');

  const decl = parseModule("const re = /'/; f('')").body;
  assert.equal(decl[0].declarations[0].init.regex.pattern, "'");
  assert.equal(decl[1].expression.arguments[0].value, '');

  const ifs = parseModule('if (a) /x/.test(b)').body[0];
  assert.equal(ifs.consequent.expression.callee.object.regex.pattern, 'x');
});

test('a slash it cannot decide is refused rather than guessed', () => {
  // Both read as division in JavaScript, so the parser decides, not a guess.
  assert.equal(parseModule('a++ / 2').body[0].expression.operator, '/');
  assert.equal(parseModule('a-- / 2 / 1').body[0].expression.operator, '/');
  // The braces-then-slash form is a block and a regex statement. The names
  // are not declared, so the grammar refuses it and the route is consent.
  assert.equal(parseModule('{}\n/x/g.test(a)').body.length, 2);
  for (const src of ['{}\n/x/g.test(a)', 'a++ / 2', 'a-- / 2 / 1']) {
    assert.equal(consent(src), true, src);
  }
});

test('punctuators are read longest first', () => {
  const op = (src) => parseModule(src).body[0].expression;
  assert.equal(op('a?.b ?? c').operator, '??');
  assert.equal(op('a ||= d').operator, '||=');
  assert.equal(op('a &&= e').operator, '&&=');
  assert.equal(op('a ??= f').operator, '??=');
  assert.equal(op('a?.5:1').type, 'ConditionalExpression');
  assert.equal(op('a?.5:1').consequent.value, 0.5);
});

test('numbers, including separators, exponents, hex and bigint', () => {
  const body = parseModule('1_000; 0x1F; 1e-3; .5; 10n').body;
  assert.deepEqual(
    body.slice(0, 4).map((s) => s.expression.value),
    [1000, 31, 0.001, 0.5]
  );
  assert.equal(body[4].expression.bigint, '10');
  assert.throws(() => parseModule('1abc'), SyntaxError);
  assert.throws(() => parseModule('0x'), SyntaxError);
  assert.deepEqual(unclassified('1abc'), ['syntax']);
  assert.deepEqual(unclassified('0x'), ['syntax']);
});

test('a byte order mark at the start is skipped; anywhere else it is refused', () => {
  // A byte order mark is ECMAScript whitespace wherever it stands. The parser
  // reads it as whitespace, so the lexer's refusal of a stray one is gone.
  assert.equal(parseModule('﻿a').body[0].expression.name, 'a');
  assert.deepEqual(unclassified('a﻿b'), ['syntax']);
  assert.equal(parseModule('a = ﻿1').body.length, 1);
});

test('a non-ASCII identifier or escape in an identifier is refused', () => {
  assert.deepEqual(unclassified('const café = 1;'), ['non-ascii-identifier']);
  assert.deepEqual(unclassified('const ñ = 1;'), ['non-ascii-identifier']);
  assert.deepEqual(unclassified('removeSettingé'), ['non-ascii-identifier']);
  assert.deepEqual(unclassified('\\u0072emoveSetting'), ['non-ascii-identifier']);
  assert.deepEqual(unclassified('a.\\u0062'), ['non-ascii-identifier']);
  // A no-break space is ECMAScript whitespace, so the parser reads the file.
  // The route is still consent, from the grammar (`a` is not declared).
  assert.equal(parseModule('a =  1').body.length, 1);
  assert.equal(consent('a =  1'), true);
  assert.equal(parseModule("// café\n'ñ' /* é */").body[0].expression.value, 'ñ');
  assert.deepEqual(unclassified("// café\n'ñ' /* é */"), []);
});

test('an unterminated token or a character outside the token set is refused', () => {
  for (const src of [
    "'abc",
    '"abc\ndef"',
    '/* abc',
    '`abc',
    '`${a',
    '/abc',
    '@dec',
    'a = 1 \\ 2',
  ]) {
    assert.deepEqual(unclassified(src), ['syntax'], JSON.stringify(src));
  }
  // `#!shebang` alone is a hashbang line and no code: the empty reason.
  assert.deepEqual(unclassified('#!shebang'), ['empty']);
});

test('a source over the size cap is refused', () => {
  assert.deepEqual(unclassified('a'.repeat(1_000_001)), ['too-large']);
});
