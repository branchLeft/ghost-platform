// Proves derive-script-hashes.mjs actually finds inline scripts, ignores
// `src`-bearing ones, dedupes and sorts deterministically, and would catch a
// theme's script content drifting -- a pinned golden hash that quietly went
// stale (row D of LLD-5's own spike: drop the hashes and a real inline
// block gets blocked right alongside the attack). Only node:test and
// node:crypto -- no package.json here, matching widgets/verify-pins.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  scriptHashOf,
  inlineScriptTextsIn,
  deriveScriptHashes,
  deriveThemeCsp,
} from './derive-script-hashes.mjs';

// LLD-5's own measured example: the theme's colour-contrast helper and a
// JSON-LD block (05-gate-and-edge.html §04, C3) -- two inline scripts, one
// plain and one application/ld+json, both governed by script-src.
const HELPER_SCRIPT = 'console.log("branchLeft theme colour-contrast helper");';
const JSONLD_SCRIPT = '{"@context":"https://schema.org","@type":"BlogPosting"}';

// Pinned once, the same way widgets/pins.json pins a CDN bundle's digest --
// this is the "golden" value a real derivation must keep reproducing.
const HELPER_HASH_GOLDEN = 'sha256-F4jDlgM5igbBdEenJJvprcV57M8YApbLewEw0D93Jf4=';

function pageHtml(scripts) {
  const tags = scripts.map((s) => `<script>${s}</script>`).join('\n');
  return `<!doctype html><html><head>${tags}</head><body>content</body></html>`;
}

test('scriptHashOf reproduces a pinned golden hash for a known script (CONTROL)', () => {
  assert.equal(scriptHashOf(HELPER_SCRIPT), HELPER_HASH_GOLDEN);
});

test('DETERMINISM — a hash mismatch against the golden value goes red when the script content drifts', () => {
  // RED: the theme's helper picked up one extra byte (a drifted edit that
  // was never re-derived) -- this is exactly the silent-drift failure mode
  // LLD-5's own decisions table names ("a hand list drifts the first time a
  // theme is touched"). A derivation this test's golden check would still
  // accept is not proving anything.
  const drifted = HELPER_SCRIPT + ' ';
  assert.notEqual(
    scriptHashOf(drifted),
    HELPER_HASH_GOLDEN,
    'RED expected: a drifted script must not still match the golden hash'
  );

  // GREEN: the real, undrifted script still reproduces the pinned value.
  assert.equal(scriptHashOf(HELPER_SCRIPT), HELPER_HASH_GOLDEN);
});

test('inlineScriptTextsIn finds every <script> with no src, in document order', () => {
  const html = pageHtml([HELPER_SCRIPT, JSONLD_SCRIPT]);
  assert.deepEqual(inlineScriptTextsIn(html), [HELPER_SCRIPT, JSONLD_SCRIPT]);
});

test('inlineScriptTextsIn skips a script tag that carries a src attribute', () => {
  const html = `<script src="/public/cards.min.js"></script>` + `<script>${HELPER_SCRIPT}</script>`;
  assert.deepEqual(inlineScriptTextsIn(html), [HELPER_SCRIPT]);
});

test('inlineScriptTextsIn control case: a page with no scripts at all yields none', () => {
  assert.deepEqual(inlineScriptTextsIn('<html><body>no scripts here</body></html>'), []);
});

test('deriveScriptHashes dedupes the same inline script repeated across pages and sorts the result', () => {
  const home = pageHtml([HELPER_SCRIPT, JSONLD_SCRIPT]);
  const post = pageHtml([JSONLD_SCRIPT, HELPER_SCRIPT]); // same two, reverse order
  const first = deriveScriptHashes([home, post]);
  const second = deriveScriptHashes([post, home]); // pages fetched in the opposite order
  assert.equal(first.length, 2, 'two distinct scripts, deduplicated across two pages');
  assert.deepEqual(first, second, 'fetch order must not change the derived set');
  assert.deepEqual(first, [...first].sort(), 'the result is sorted');
});

test('deriveThemeCsp returns kind "computed" with the union of every page\'s hashes', async () => {
  const pages = {
    '/': pageHtml([HELPER_SCRIPT]),
    '/post/': pageHtml([JSONLD_SCRIPT]),
    '/tag/': pageHtml([]),
    '/author/': pageHtml([]),
  };
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    return { ok: true, text: async () => pages[path] };
  };
  const result = await deriveThemeCsp('http://ghost.test', Object.keys(pages), fakeFetch);
  assert.equal(result.kind, 'computed');
  assert.equal(result.hashes.length, 2);
  assert.ok(result.hashes.includes(HELPER_HASH_GOLDEN));
});

test('deriveThemeCsp fails soft to kind "unavailable" when a page 500s, rather than returning a partial set', async () => {
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/broken/') return { ok: false, status: 500, text: async () => '' };
    return { ok: true, text: async () => pageHtml([HELPER_SCRIPT]) };
  };
  const result = await deriveThemeCsp('http://ghost.test', ['/', '/broken/'], fakeFetch);
  assert.equal(result.kind, 'unavailable');
  assert.match(result.reason, /\/broken\/.*500/);
});

test('deriveThemeCsp fails soft to kind "unavailable" when a fetch throws (theme could not be rendered at all)', async () => {
  const fakeFetch = async () => {
    throw new Error('connection refused');
  };
  const result = await deriveThemeCsp('http://ghost.test', ['/'], fakeFetch);
  assert.equal(result.kind, 'unavailable');
  assert.match(result.reason, /connection refused/);
});
