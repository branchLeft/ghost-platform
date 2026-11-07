// verify.mjs against a small synthetic bundle built in a temp directory: one
// fetched theme, one base-image theme, one reserved-name font. The green case
// proves the fixture is valid; each red case breaks exactly one thing, so a
// check that stopped checking fails its own test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fontsCss } from './fetch.mjs';
import { sha256File, treeSha256 } from './lib/treehash.mjs';
import { verifyBundle } from './verify.mjs';

const MIT =
  'Copyright (c) 2013-2026 Example Foundation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';
const OFL =
  'Copyright 2011 The Example Project Authors, with Reserved Font Name "Example".\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1. SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n';
const SHA = 'a'.repeat(40);

let root;
let bundle;
let base;
let manifest;

function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function build() {
  write('bundle/themes/alpha/LICENSE', MIT);
  write(
    'bundle/themes/alpha/default.hbs',
    '<link rel="stylesheet" href="{{asset "built/a.css"}}"><a href="https://ghost.org/">Ghost</a>'
  );
  write('bundle/themes/alpha/assets/built/a.css', '.a{color:red}');
  write('bundle/themes/alpha/package.json', '{"version":"1.2.3"}');
  write('base/beta/LICENSE', MIT);
  write('base/beta/default.hbs', '<p>hi</p>');
  write('base/beta/package.json', '{"version":"4.5.6"}');
  write('bundle/fonts/example/OFL.txt', OFL);
  write('bundle/fonts/example/Example-Regular.woff2', 'woff2-bytes');

  manifest = {
    schema: 1,
    ghost: '6.55.0',
    themes: [
      {
        name: 'alpha',
        source: 'github',
        upstream: 'https://github.com/Example/Alpha',
        commit: SHA,
        version: '1.2.3',
        licence: {
          spdx: 'MIT',
          file: 'LICENSE',
          copyright: 'Copyright (c) 2013-2026 Example Foundation',
          sha256: sha256File(path.join(root, 'bundle/themes/alpha/LICENSE')),
        },
        treeSha256: treeSha256(path.join(root, 'bundle/themes/alpha')),
      },
      {
        name: 'beta',
        source: 'base-image',
        version: '4.5.6',
        licence: {
          spdx: 'MIT',
          file: 'LICENSE',
          copyright: 'Copyright (c) 2013-2026 Example Foundation',
          sha256: sha256File(path.join(root, 'base/beta/LICENSE')),
        },
        treeSha256: treeSha256(path.join(root, 'base/beta')),
      },
    ],
    fonts: [
      {
        family: 'Example',
        dir: 'example',
        upstream: 'https://github.com/Example/Example',
        commit: SHA,
        licence: {
          spdx: 'OFL-1.1',
          file: 'OFL.txt',
          copyright:
            'Copyright 2011 The Example Project Authors, with Reserved Font Name "Example".',
          sha256: sha256File(path.join(root, 'bundle/fonts/example/OFL.txt')),
        },
        reservedFontName: 'Example',
        modification: 'none',
        source: { kind: 'git-file' },
        files: [
          {
            from: 'fonts/Example-Regular.woff2',
            to: 'Example-Regular.woff2',
            sha256: sha256File(path.join(root, 'bundle/fonts/example/Example-Regular.woff2')),
            style: 'normal',
            weight: '400',
          },
        ],
      },
    ],
    excluded: [
      {
        name: 'gamma',
        upstream: 'https://github.com/Example/Gamma',
        reason: 'outside-origin-at-runtime',
        detail: 'loads jQuery from a CDN at page load',
      },
    ],
  };
  write('bundle/fonts/fonts.css', fontsCss(manifest));
}

const run = () => verifyBundle(manifest, bundle, base);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  bundle = path.join(root, 'bundle');
  base = path.join(root, 'base');
  build();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('verifyBundle', () => {
  it('GREEN: the fixture bundle verifies', () => {
    assert.deepEqual(run(), []);
  });

  it('RED: a byte changed in a theme differs from its pin', () => {
    write('bundle/themes/alpha/assets/built/a.css', '.a{color:blue}');
    assert.match(run().join('\n'), /theme alpha: tree differs from its pin/);
  });

  it('RED: a theme that loads jQuery from a CDN fails even with its pin updated', () => {
    write(
      'bundle/themes/alpha/default.hbs',
      '<script src="https://code.jquery.com/jquery.js"></script><link rel="stylesheet" href="{{asset "built/a.css"}}">'
    );
    manifest.themes[0].treeSha256 = treeSha256(path.join(bundle, 'themes/alpha'));
    assert.match(
      run().join('\n'),
      /code\.jquery\.com\/jquery\.js \(loaded from an outside origin\)/
    );
  });

  it('RED: a theme that requests a font from a third party fails', () => {
    write(
      'bundle/themes/alpha/assets/built/a.css',
      '@font-face{src:url(https://fonts.gstatic.com/x.woff2)}'
    );
    manifest.themes[0].treeSha256 = treeSha256(path.join(bundle, 'themes/alpha'));
    assert.match(run().join('\n'), /fonts\.gstatic\.com/);
  });

  it('RED: a missing licence file fails', () => {
    fs.rmSync(path.join(bundle, 'themes/alpha/LICENSE'));
    assert.match(run().join('\n'), /theme alpha: licence file LICENSE is missing/);
  });

  it('RED: a licence file that does not read as the recorded licence fails', () => {
    manifest.themes[0].licence.spdx = 'OFL-1.1';
    assert.match(run().join('\n'), /does not read as OFL-1.1/);
  });

  it('RED: a recorded copyright that is not in the licence file fails', () => {
    manifest.themes[0].licence.copyright = 'Copyright (c) 1999 Somebody Else';
    assert.match(run().join('\n'), /recorded copyright line is not in the licence file/);
  });

  it('RED: a theme directory that is not in the manifest fails', () => {
    write('bundle/themes/stray/default.hbs', 'x');
    assert.match(run().join('\n'), /bundle themes .* differ from the manifest/);
  });

  it('RED: a template naming a built asset that is not committed fails', () => {
    fs.rmSync(path.join(bundle, 'themes/alpha/assets/built/a.css'));
    manifest.themes[0].treeSha256 = treeSha256(path.join(bundle, 'themes/alpha'));
    assert.match(run().join('\n'), /names asset built\/a\.css, which is not in the theme/);
  });

  it('RED: a base-image theme is checked in place, and a missing one fails', () => {
    fs.rmSync(path.join(base, 'beta'), { recursive: true });
    assert.match(run().join('\n'), /theme beta: not present/);
  });

  it('RED: an altered font file differs from its pin', () => {
    write('bundle/fonts/example/Example-Regular.woff2', 'subset-bytes');
    assert.match(run().join('\n'), /font Example: Example-Regular\.woff2 differs from its pin/);
  });

  it('RED: a licence that declares a reserved name the manifest does not record fails', () => {
    manifest.fonts[0].reservedFontName = null;
    assert.match(
      run().join('\n'),
      /declares reserved font name "Example" but the manifest records null/
    );
  });

  it('RED: fonts.css pointing at another origin fails', () => {
    write(
      'bundle/fonts/fonts.css',
      '@font-face{font-family:"Example";src:url("https://fonts.bunny.net/example.woff2")}'
    );
    assert.match(run().join('\n'), /fonts\.css: references https:\/\/fonts\.bunny\.net/);
  });

  it('RED: fonts.css naming a file that was not shipped fails', () => {
    write(
      'bundle/fonts/fonts.css',
      '@font-face{font-family:"Example";src:url("example/Gone.woff2")}'
    );
    assert.match(run().join('\n'), /example\/Gone\.woff2 does not exist/);
  });

  it('RED: a symlink that leaves the theme tree fails', () => {
    fs.symlinkSync('/etc/passwd', path.join(bundle, 'themes/alpha/leak'));
    assert.throws(() => run(), /symlink leaves the tree/);
  });
});
