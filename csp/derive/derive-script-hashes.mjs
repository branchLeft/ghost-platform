#!/usr/bin/env node
// Derives the CSP script-hash set for one theme's rendered pages, hashed
// exactly as CSP evaluates a hash-source: raw bytes as served over HTTP, not
// browser-normalised text.
// See derive-script-hashes.md#overview for the render-core boundary, hash
// semantics and determinism.
import { createHash } from 'node:crypto';

// The closing delimiter follows the HTML spec's own "script data end tag
// name state": a raw-text element's content ends at the first `</script`
// (case-insensitive) that is followed by a tag-name-terminating character
// -- ASCII whitespace, `/` or `>` -- not merely by `</script\s*>` exactly.
// `</script foo="bar">` is a real, spec-valid closing tag (attributes on an
// end tag are ignored, but the tag still closes there); `</scriptfoo>` is
// not a closing tag at all and is literal script content. The lookahead is
// zero-width so it only *locates* the terminator; `[^>]*>` then consumes
// whatever attribute-shaped junk sits between it and the tag's own final
// `>`, the same way a real end tag does.
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\t\n\f\r />])[^>]*>/gi;
const HAS_SRC_ATTRIBUTE = /\bsrc\s*=/i;

/** The exact CSP hash-source token for one inline script's raw text. */
export function scriptHashOf(scriptText) {
  const digest = createHash('sha256').update(scriptText, 'utf8').digest('base64');
  return `sha256-${digest}`;
}

/**
 * Every inline (no `src`) <script> block's raw text in one page of HTML, in
 * the order it appears. A `<script src=...>` tag is a same-origin or
 * third-party file reference, not something this policy hashes -- LLD-5's
 * own `script-src 'self'` already covers a same-origin file, and a
 * third-party one is exactly what C2/C3 replaced by self-hosting (see
 * widgets/).
 */
export function inlineScriptTextsIn(html) {
  const texts = [];
  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    const [, attrs, body] = match;
    if (HAS_SRC_ATTRIBUTE.test(attrs)) continue;
    texts.push(body);
  }
  return texts;
}

/**
 * The deduplicated, sorted hash-source set for every inline script found
 * across `pages` (one raw HTML string per rendered page). Deterministic by
 * construction: the same set of page bytes, in any order, produces the same
 * sorted array -- see derive-script-hashes.test.mjs's own DETERMINISM case.
 */
export function deriveScriptHashes(pages) {
  const hashes = new Set();
  for (const html of pages) {
    for (const text of inlineScriptTextsIn(html)) {
      hashes.add(scriptHashOf(text));
    }
  }
  return [...hashes].sort();
}

/**
 * Fetches `paths` from `origin` and derives the hash set across all of
 * them. `kind: 'unavailable'` (LLD-5's fail-soft mark, mirrored by
 * render-core's `ThemeCsp`) covers any page that did not come back as a
 * real page: a non-200 status, or a fetch that threw. A partial hash set
 * from whichever pages happened to load is worse than none, since a strict
 * policy enforced against an incomplete set blocks the theme's own scripts
 * on whichever page was missed -- so one failure fails the whole derivation,
 * not just that page.
 */
export async function deriveThemeCsp(origin, paths, fetchImpl = fetch) {
  const pages = [];
  for (const path of paths) {
    let res;
    try {
      res = await fetchImpl(new URL(path, origin));
    } catch (err) {
      return { kind: 'unavailable', reason: `${path}: ${err.message}` };
    }
    if (!res.ok) {
      return { kind: 'unavailable', reason: `${path}: HTTP ${res.status}` };
    }
    pages.push(await res.text());
  }
  return { kind: 'computed', hashes: deriveScriptHashes(pages) };
}

async function main() {
  const origin = process.env.GHOST_ORIGIN;
  if (!origin) {
    console.error(
      'derive-script-hashes: set GHOST_ORIGIN (e.g. http://localhost:2368) to a running Ghost origin.'
    );
    process.exit(2);
  }
  // Comma-separated paths -- the home, post, tag and author pages LLD-5's
  // own "What" names, left to the caller because which slugs exist is a
  // fact about the content on that Ghost, not something this tool guesses.
  const paths = (process.env.CSP_DERIVE_PATHS ?? '/')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const result = await deriveThemeCsp(origin, paths);
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'unavailable') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
