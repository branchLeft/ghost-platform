import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cook, lex, Unlexable } from '../src/lex.mjs';

const kinds = (src) => lex(src).map((t) => `${t.t}:${t.v}`);
const refuses = (src, reason = 'unlexable') => {
  assert.throws(
    () => lex(src),
    (err) => err instanceof Unlexable && err.reason === reason,
    JSON.stringify(src)
  );
};

test('comments are not tokens, and a comment marker inside a string is not a comment', () => {
  assert.deepEqual(kinds('a // b\n/* c */ d'), ['id:a', 'id:d']);
  assert.deepEqual(kinds("const g = '/content/images/*'; f(); /** doc */"), [
    'id:const',
    'id:g',
    'punct:=',
    'str:/content/images/*',
    'punct:;',
    'id:f',
    'punct:(',
    'punct:)',
    'punct:;',
  ]);
});

test('a line comment ends at every JavaScript line terminator', () => {
  for (const eol of ['\n', '\r', '\u2028', '\u2029']) {
    assert.deepEqual(kinds(`// c${eol}removeSetting`), ['id:removeSetting'], JSON.stringify(eol));
  }
});

test('line breaks set the nl flag on the next token only', () => {
  const toks = lex('a\nb c\r\nd /* x\ny */ e');
  assert.deepEqual(
    toks.map((t) => [t.v, t.nl]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
      ['d', true],
      ['e', true],
    ]
  );
});

test('strings are cooked: escapes spell the text they stand for', () => {
  assert.equal(cook('DROP\\x20TABLE'), 'DROP TABLE');
  assert.equal(cook('a\\u0020b\\u{20}c'), 'a b c');
  assert.equal(cook('a\\nb\\tc'), 'a\nb\tc');
  assert.equal(cook('q\\q'), 'qq');
  assert.deepEqual(kinds("'a\\'b'"), ["str:a'b"]);
});

test('template literals nest, and their text is not code', () => {
  assert.deepEqual(kinds('`a${b}c`'), ['tmplHead:a', 'id:b', 'tmplTail:c']);
  assert.deepEqual(kinds('`${`${x}`}`'), [
    'tmplHead:',
    'tmplHead:',
    'id:x',
    'tmplTail:',
    'tmplTail:',
  ]);
  assert.deepEqual(kinds('`} \\` /* `'), ['tmpl:} ` /* ']);
  assert.deepEqual(kinds('`${ {a: 1}.a }`'), [
    'tmplHead:',
    'punct:{',
    'id:a',
    'punct::',
    'num:1',
    'punct:}',
    'punct:.',
    'id:a',
    'tmplTail:',
  ]);
});

test('regex literal or division is decided from what precedes the slash', () => {
  assert.deepEqual(kinds('a / b / c'), ['id:a', 'punct:/', 'id:b', 'punct:/', 'id:c']);
  assert.deepEqual(kinds('(a + b) / 2'), [
    'punct:(',
    'id:a',
    'punct:+',
    'id:b',
    'punct:)',
    'punct:/',
    'num:2',
  ]);
  assert.deepEqual(kinds('x = /a\\/b[/]c/gi'), ['id:x', 'punct:=', 'regex:/a\\/b[/]c/gi']);
  assert.deepEqual(kinds('return /x/'), ['id:return', 'regex:/x/']);
  assert.deepEqual(kinds("const re = /'/; f('')"), [
    'id:const',
    'id:re',
    'punct:=',
    "regex:/'/",
    'punct:;',
    'id:f',
    'punct:(',
    'str:',
    'punct:)',
  ]);
  assert.deepEqual(kinds('if (a) /x/.test(b)').slice(3, 5), ['punct:)', 'regex:/x/']);
});

test('a slash it cannot decide is refused rather than guessed', () => {
  refuses('{}\n/x/g.test(a)');
  refuses('a++ / 2');
  refuses('a-- /x/');
});

test('punctuators are read longest first', () => {
  assert.deepEqual(kinds('a?.b ?? c ||= d &&= e ??= f ...g => h'), [
    'id:a',
    'punct:?.',
    'id:b',
    'punct:??',
    'id:c',
    'punct:||=',
    'id:d',
    'punct:&&=',
    'id:e',
    'punct:??=',
    'id:f',
    'punct:...',
    'id:g',
    'punct:=>',
    'id:h',
  ]);
  assert.deepEqual(kinds('a?.5:1'), ['id:a', 'punct:?', 'num:.5', 'punct::', 'num:1']);
});

test('numbers, including separators, exponents, hex and bigint', () => {
  assert.deepEqual(kinds('1_000 0x1F 1e-3 .5 10n'), [
    'num:1_000',
    'num:0x1F',
    'num:1e-3',
    'num:.5',
    'num:10n',
  ]);
  refuses('1abc');
  refuses('0x');
});

test('a byte order mark at the start is skipped; anywhere else it is refused', () => {
  assert.deepEqual(kinds('\ufeffa'), ['id:a']);
  refuses('a\ufeffb', 'non-ascii-identifier');
  refuses('a = \ufeff1', 'unlexable');
});

test('a non-ASCII identifier or escape in an identifier is refused', () => {
  refuses('const café = 1;', 'non-ascii-identifier');
  refuses('const ñ = 1;', 'non-ascii-identifier');
  refuses('removeSettingé', 'non-ascii-identifier');
  refuses('\\u0072emoveSetting', 'unlexable');
  refuses('a.\\u0062', 'unlexable');
  refuses('a = \u00a01', 'unlexable');
  assert.deepEqual(kinds("// café\n'ñ' /* é */"), ['str:ñ']);
});

test('an unterminated token or a character outside the token set is refused', () => {
  refuses("'abc");
  refuses('"abc\ndef"');
  refuses('/* abc');
  refuses('`abc');
  refuses('`${a');
  refuses('/abc');
  refuses('#!shebang');
  refuses('@dec');
  refuses('a = 1 \\ 2');
});

test('a source over the size cap is refused', () => {
  refuses('a'.repeat(1_000_001));
});
