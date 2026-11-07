// Outside-origin scanner for a bundled theme: sorts every absolute or protocol-relative URL in the
// files Ghost serves into namespace, navigation, load or other (rules: themes/README.md).
// A static floor, not a browser run: a URL built at runtime from parts is invisible to it.

import fs from 'node:fs';
import path from 'node:path';

// Namespace identifiers, by exact URL prefix. These appear in RSS and SVG
// templates and in JSON-LD `@context`; no client fetches them.
export const NAMESPACE_PREFIXES = [
  'http://www.w3.org/',
  'https://www.w3.org/',
  'http://purl.org/',
  'http://wellformedweb.org/',
  'http://www.itunes.com/dtds/',
  'http://www.rawvoice.com/rawvoiceRssModule/',
  'http://www.google.com/schemas/',
  'http://schema.org',
  'https://schema.org',
];

export const DECLARATION_KINDS = ['navigation', 'comment', 'inert-string'];

const URL_RE =
  /(?:(?:https?:)?\/\/)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d+)?(?:[/?#][^\s"'`<>)\\]*)?/gi;

// Link relations that name a document rather than fetch a resource.
const NAVIGATION_LINK_RELS = new Set([
  'alternate',
  'canonical',
  'me',
  'author',
  'next',
  'prev',
  'license',
  'help',
]);
const LOADING_TAGS = new Set([
  'script',
  'img',
  'iframe',
  'source',
  'video',
  'audio',
  'embed',
  'track',
  'input',
  'object',
  'image',
  'use',
  'frame',
]);
const LOADING_ATTRS = new Set(['src', 'srcset', 'data', 'poster', 'href', 'xlink:href']);

export function hostOf(url) {
  const m = /^(?:https?:)?\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export function isNamespace(url) {
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return NAMESPACE_PREFIXES.some((p) => absolute.startsWith(p) || url.startsWith(p));
}

function stripHbsComments(text) {
  return text
    .replace(/\{\{!--[\s\S]*?--\}\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\{\{![\s\S]*?\}\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Every URL in `text`, as {url, index}.
function urlsIn(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const before = text[m.index - 1];
    // A protocol-relative URL must start a token. Otherwise `a//b.c` in code
    // (or the tail of a path) would be read as a host.
    if (m[0].startsWith('//') && before !== undefined && !/[\s"'`(=,[{:;]/.test(before)) continue;
    out.push({ url: m[0], index: m.index });
  }
  return out;
}

function attrsOf(rawAttrs) {
  const attrs = {};
  for (const m of rawAttrs.matchAll(/([a-z_:][a-z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? '';
  }
  return attrs;
}

// An element with a text body, as [full match, attributes, body]. The opening
// tag skips quoted attribute values (which may hold a `>`); the closing tag is
// `</name` then whitespace, `/` or `>`, in any case.
const rawTextBlock = (name) =>
  new RegExp(
    `<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)<\\/${name}(?=[\\s/>])[^>]*>`,
    'gi'
  );
const SCRIPT_BLOCK = rawTextBlock('script');
const STYLE_BLOCK = rawTextBlock('style');

// Classify every URL in a markup file (.hbs, .html, .svg).
function classifyMarkup(rawText, { svg = false } = {}) {
  const text = svg ? rawText : stripHbsComments(rawText);
  const results = [];
  const claimed = new Set();

  // 1. Script bodies: JavaScript context.
  // A browser ends the element at `</script` followed by whitespace, `/` or `>`,
  // so the closing tag may carry spaces or attributes; a stricter pattern would
  // swallow the next element into this body and read its URL as inert text.
  for (const m of text.matchAll(SCRIPT_BLOCK)) {
    const bodyStart = m.index + '<script'.length + m[1].length + 1;
    for (const u of urlsIn(m[2])) {
      const index = bodyStart + u.index;
      claimed.add(index);
      results.push({ url: u.url, index, class: isNamespace(u.url) ? 'namespace' : 'other' });
    }
  }

  // 2. Style blocks: CSS context.
  for (const m of text.matchAll(STYLE_BLOCK)) {
    const bodyStart = m.index + '<style'.length + m[1].length + 1;
    for (const r of classifyCss(m[2])) {
      const index = bodyStart + r.index;
      claimed.add(index);
      results.push({ ...r, index });
    }
  }

  // 3. Tags: attribute context.
  for (const m of text.matchAll(/<([a-z][a-z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrStart = m.index + 1 + m[1].length;
    const attrs = attrsOf(m[2]);
    for (const [name, value] of Object.entries(attrs)) {
      const valueStart = text.indexOf(value, attrStart);
      for (const u of urlsIn(value)) {
        const index = (valueStart === -1 ? m.index : valueStart) + u.index;
        if (claimed.has(index)) continue;
        claimed.add(index);
        let cls = 'other';
        if (isNamespace(u.url) || name === 'xmlns' || name.startsWith('xmlns:')) cls = 'namespace';
        else if (name === 'style') cls = 'load-if-css';
        else if (tag === 'link' && name === 'href') {
          const rels = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
          cls =
            rels.length > 0 && rels.every((r) => NAVIGATION_LINK_RELS.has(r))
              ? 'navigation'
              : 'load';
        } else if ((tag === 'a' || tag === 'area') && name === 'href') cls = 'navigation';
        else if (LOADING_TAGS.has(tag) && LOADING_ATTRS.has(name)) cls = 'load';
        else if (tag === 'form' && name === 'action') cls = 'load';
        else if (name === 'formaction' || name === 'srcset' || name === 'poster') cls = 'load';
        results.push({ url: u.url, index, class: cls });
      }
    }
  }

  // 4. Anything not claimed above: text between tags and handlebars arguments.
  for (const u of urlsIn(text)) {
    if (claimed.has(u.index)) continue;
    // `{{{t "..." ghostlink="<a href=\"https://...\">"}}}`: an anchor written
    // inside a handlebars string, with escaped quotes the tag pattern above
    // cannot see.
    const before = text.slice(Math.max(0, u.index - 80), u.index);
    let cls = isNamespace(u.url) ? 'namespace' : 'other';
    if (cls === 'other' && /<a\b[^<>]*\bhref=\\?["']$/i.test(before)) cls = 'navigation';
    results.push({ url: u.url, index: u.index, class: cls });
  }

  // `style=""` attributes carry CSS: re-read them as CSS.
  return results.map((r) => {
    if (r.class !== 'load-if-css') return r;
    const around = text.slice(Math.max(0, r.index - 40), r.index);
    return { ...r, class: /url\(\s*["']?$|@import\s+["']?$/i.test(around) ? 'load' : 'other' };
  });
}

// Classify every URL in CSS text.
function classifyCss(rawText) {
  const text = stripCssComments(rawText);
  const results = [];
  const claimed = new Set();
  for (const m of text.matchAll(/url\(\s*(["']?)((?:https?:)?\/\/[^"')\s]+)\1\s*\)/gi)) {
    const index = m.index + m[0].indexOf(m[2]);
    claimed.add(index);
    results.push({ url: m[2], index, class: 'load' });
  }
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(["']?)((?:https?:)?\/\/[^"')\s;]+)\1/gi)) {
    const index = m.index + m[0].indexOf(m[2]);
    if (claimed.has(index)) continue;
    claimed.add(index);
    results.push({ url: m[2], index, class: 'load' });
  }
  for (const u of urlsIn(text)) {
    if (claimed.has(u.index)) continue;
    results.push({ url: u.url, index: u.index, class: isNamespace(u.url) ? 'namespace' : 'other' });
  }
  return results;
}

// Classify every URL in a JavaScript or JSON file. No comment stripping: a
// block-comment opener inside a string would make a stripper swallow real code
// and hide a URL, which is the unsafe direction. Comments are declared instead.
function classifyScript(text) {
  return urlsIn(text).map((u) => ({
    url: u.url,
    index: u.index,
    class: isNamespace(u.url) ? 'namespace' : 'other',
  }));
}

export function classifyFile(relPath, text) {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.hbs') || lower.endsWith('.html')) return classifyMarkup(text);
  if (lower.endsWith('.svg')) return classifyMarkup(text, { svg: true });
  if (lower.endsWith('.css')) return classifyCss(text);
  return classifyScript(text);
}

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.pdf',
  '.zip',
  '.map',
]);

// The files Ghost serves or renders from a theme directory.
export function runtimeFiles(themeDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // A link among the served files could point the theme at bytes this
        // scan never reads. Links elsewhere (a docs alias) are not served.
        const rel = path.relative(themeDir, p).split(path.sep).join('/');
        if (rel.endsWith('.hbs') || rel === 'assets' || rel.startsWith('assets/'))
          throw new Error(`symlink among served theme files: ${rel}`);
        continue;
      }
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(themeDir, p).split(path.sep).join('/');
        if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
        if (rel.endsWith('.hbs') || rel.startsWith('assets/')) out.push(rel);
      }
    }
  };
  walk(themeDir);
  return out.sort();
}

/**
 * Scan a materialised theme directory against the manifest's declarations
 * ({files, hosts, kind, reason}[]); returns {violations, references, unusedDeclarations}.
 */
export function scanTheme(themeDir, declared = []) {
  const violations = [];
  const references = [];
  const used = new Set();
  const lookup = new Map();
  declared.forEach((d, i) => {
    for (const f of d.files) for (const h of d.hosts) lookup.set(`${f}\u0000${h.toLowerCase()}`, i);
  });

  for (const rel of runtimeFiles(themeDir)) {
    const text = fs.readFileSync(path.join(themeDir, rel), 'utf8');
    for (const r of classifyFile(rel, text)) {
      const host = hostOf(r.url.startsWith('//') ? `https:${r.url}` : r.url);
      const where = { file: rel, line: lineOf(text, r.index), url: r.url, host };
      if (r.class === 'namespace') continue;
      if (r.class === 'navigation') {
        references.push({ ...where, class: 'navigation' });
        continue;
      }
      if (r.class === 'load') {
        violations.push({ ...where, why: 'loaded from an outside origin' });
        continue;
      }
      const idx = lookup.get(`${rel}\u0000${host}`);
      if (idx === undefined) {
        violations.push({ ...where, why: 'outside origin not declared in the manifest' });
      } else {
        used.add(idx);
        references.push({ ...where, class: declared[idx].kind });
      }
    }
  }

  const unusedDeclarations = declared
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ d }) => ({
      files: d.files,
      hosts: d.hosts,
      why: 'declaration matches nothing in the theme',
    }));
  return { violations, references, unusedDeclarations };
}

// Every {{asset "x"}} a template names must exist: a theme whose built files
// are not committed renders unstyled, which is a blocker no scan of what is
// present can see.
export function missingAssets(themeDir) {
  const missing = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'assets') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.hbs')) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of stripHbsComments(text).matchAll(
          /\{\{\s*asset\s+"([^"?]+)(?:\?[^"]*)?"([^}]*)\}\}/g
        )) {
          const wanted = m[1];
          const hasMin = /hasMinFile\s*=\s*true/.test(m[2]);
          const candidates = [wanted];
          if (hasMin) candidates.push(wanted.replace(/(\.[a-z]+)$/i, '.min$1'));
          if (!candidates.some((c) => fs.existsSync(path.join(themeDir, 'assets', c)))) {
            missing.push({ template: path.relative(themeDir, p), asset: wanted });
          }
        }
      }
    }
  };
  walk(themeDir);
  return missing;
}
