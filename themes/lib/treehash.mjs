// A content hash of a directory tree: sha256 over the sorted lines "<sha256 of file>  <posix path>\n".
// Independent of modes, mtimes and how the tree arrived, so one pin holds on a laptop and in the build.
// A symbolic link is hashed as "link:<target>" and must stay inside the tree, or the hash
// would vouch for bytes it never read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function checkedLinkTarget(root, p) {
  const target = fs.readlinkSync(p);
  const resolved = path.resolve(path.dirname(p), target);
  const rel = path.relative(root, resolved);
  if (path.isAbsolute(target) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`symlink leaves the tree: ${path.relative(root, p)} -> ${target}`);
  }
  return target;
}

export function listEntries(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out.push({ rel, link: checkedLinkTarget(root, p) });
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ rel, file: p });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function treeSha256(root) {
  const lines = listEntries(root).map((e) =>
    e.link !== undefined ? `link:${e.link}  ${e.rel}\n` : `${sha256File(e.file)}  ${e.rel}\n`
  );
  return sha256Text(lines.join(''));
}
