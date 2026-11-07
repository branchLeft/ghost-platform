// The outside-origin scanner. Every "red" case here is a theme the platform
// must refuse; every "green" case is one it must keep. A scanner that quietly
// stopped matching would pass every theme, so each class is asserted in both
// directions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { classifyFile, missingAssets, scanTheme } from './lib/origins.mjs';

const made = [];
function theme(files, links = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-scan-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const [rel, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(dir, rel));
  }
  return dir;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

const classes = (rel, text) => classifyFile(rel, text).map((r) => `${r.class}:${r.url}`);

describe('markup: positions a browser fetches without a click are loads', () => {
  const cases = {
    'script src': '<script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>',
    'protocol-relative script': '<script src="//cdn.example.com/a.js"></script>',
    'stylesheet link':
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">',
    'preload link': '<link rel="preload" href="https://cdn.example.com/f.woff2" as="font">',
    preconnect: '<link rel="preconnect" href="https://fonts.gstatic.com">',
    img: '<img src="https://images.example.com/a.png">',
    srcset: '<img srcset="https://images.example.com/a.png 1x" src="{{img_url feature_image}}">',
    iframe: '<iframe src="https://player.vimeo.com/video/1"></iframe>',
    'form action': '<form action="https://mailer.example.com/subscribe"></form>',
    'style block url': '<style>.a{background:url(https://cdn.example.com/a.png)}</style>',
    'style block import': '<style>@import url("https://fonts.googleapis.com/css");</style>',
    'inline style attribute':
      '<div style="background:url(\'https://cdn.example.com/a.png\')"></div>',
  };
  for (const [name, html] of Object.entries(cases)) {
    it(name, () => {
      assert.ok(
        classes('default.hbs', html).some((c) => c.startsWith('load:')),
        `${name}: ${classes('default.hbs', html)}`
      );
    });
  }
});

describe('markup: a closing tag a browser accepts ends the element', () => {
  const loads = (html) =>
    classes('default.hbs', html)
      .filter((c) => c.startsWith('load:'))
      .map((c) => c.slice('load:'.length));
  const third = 'https://third-party.example/x.js';
  const closers = {
    'whitespace before >': '</script >',
    attribute: '</script data-x="y">',
    'upper case and a newline': '</SCRIPT\n>',
    'a slash': '</script/>',
  };
  for (const [name, closer] of Object.entries(closers)) {
    it(`a script closed by ${name} does not swallow the next script`, () => {
      assert.deepEqual(loads(`<script>a()${closer}<script src="${third}"></script>`), [third]);
    });
  }

  it('a style closed with whitespace does not swallow the next stylesheet', () => {
    const html = `<style>.a{}</style ><link rel="stylesheet" href="https://third-party.example/a.css"><style>.b{}</style>`;
    assert.deepEqual(loads(html), ['https://third-party.example/a.css']);
  });

  it('a style closed with an attribute does not swallow the next element', () => {
    const html = `<style>.a{}</style x="y"><img src="https://third-party.example/a.png"><style>.b{}</style>`;
    assert.deepEqual(loads(html), ['https://third-party.example/a.png']);
  });

  it('a > inside a quoted attribute value does not end the opening tag', () => {
    const html = `<script data-x="a>b">var u = "https://third-party.example/s"</script>`;
    assert.deepEqual(classes('default.hbs', html), ['other:https://third-party.example/s']);
  });

  it('a name that merely starts with script is not a script block', () => {
    const html = `<scripts>https://third-party.example/s</scripts>`;
    assert.deepEqual(classes('default.hbs', html), ['other:https://third-party.example/s']);
  });

  it('GREEN: a plain script body still reads its URL as inert text', () => {
    const html = `<script>var u = "https://third-party.example/s"</script>`;
    assert.deepEqual(classes('default.hbs', html), ['other:https://third-party.example/s']);
  });
});

describe('markup: names that are not loads', () => {
  it('an anchor is navigation', () => {
    assert.deepEqual(classes('a.hbs', '<a href="https://ghost.org/">Ghost</a>'), [
      'navigation:https://ghost.org/',
    ]);
  });
  it('an alternate or canonical link is navigation', () => {
    assert.deepEqual(
      classes(
        'a.hbs',
        '<link rel="alternate" type="application/rss+xml" href="https://feeds.example.com/rss">'
      ),
      ['navigation:https://feeds.example.com/rss']
    );
  });
  it('an anchor written inside a handlebars string is navigation', () => {
    const hbs =
      '{{{t "Powered by {ghostlink}" ghostlink="<a href=\\"https://ghost.org/\\">Ghost</a>"}}}';
    assert.deepEqual(classes('a.hbs', hbs), ['navigation:https://ghost.org/']);
  });
  it('xml namespaces are not references', () => {
    const rss =
      '<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:dc="http://purl.org/dc/elements/1.1/">';
    assert.deepEqual(classes('rss.hbs', rss), [
      'namespace:http://www.w3.org/2005/Atom',
      'namespace:http://www.itunes.com/dtds/podcast-1.0.dtd',
      'namespace:http://purl.org/dc/elements/1.1/',
    ]);
  });
  it('handlebars and html comments are ignored', () => {
    const hbs =
      '{{!-- see https://medium.example.com/post --}}<!-- https://cdn.example.com/x.js -->';
    assert.deepEqual(classes('a.hbs', hbs), []);
  });
  it('relative and handlebars URLs are not references', () => {
    assert.deepEqual(
      classes(
        'a.hbs',
        '<script src="{{asset "built/a.js"}}"></script><a href="/about/">x</a><img src="{{img_url feature_image}}">'
      ),
      []
    );
  });
});

describe('css and script', () => {
  it('a css url() and @import to another origin are loads', () => {
    assert.deepEqual(
      classes(
        'assets/a.css',
        '@import "https://fonts.googleapis.com/css";.a{background:url(//cdn.example.com/a.png)}'
      ).sort(),
      ['load://cdn.example.com/a.png', 'load:https://fonts.googleapis.com/css']
    );
  });
  it('a css comment is ignored', () => {
    assert.deepEqual(classes('assets/a.css', '/* https://github.com/x/y */.a{color:red}'), []);
  });
  it('a url in javascript is "other": it must be declared', () => {
    assert.deepEqual(classes('assets/a.js', 'fetch("https://api.example.com/x")'), [
      'other:https://api.example.com/x',
    ]);
  });
  it('a division or a path is not read as a host', () => {
    assert.deepEqual(classes('assets/a.js', 'var r=a//b.c;var p="x/y//z.q"'), []);
  });
});

describe('scanTheme: the control case', () => {
  const jquery = {
    'default.hbs': '<html><script src="https://code.jquery.com/jquery.js"></script></html>',
  };

  it('RED: a theme that loads jQuery from a CDN fails, and no declaration can allow it', () => {
    const dir = theme(jquery);
    const declared = [
      {
        files: ['default.hbs'],
        hosts: ['code.jquery.com'],
        kind: 'navigation',
        reason: 'trying to allow a load',
      },
    ];
    const { violations } = scanTheme(dir, declared);
    assert.equal(violations.length, 1);
    assert.match(violations[0].why, /loaded from an outside origin/);
  });

  it('RED: a font stylesheet from a third party fails', () => {
    const dir = theme({
      'default.hbs':
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins">',
    });
    assert.equal(scanTheme(dir).violations.length, 1);
  });

  it('RED: a font fetched by a stylesheet in assets fails', () => {
    const dir = theme({
      'assets/css/a.css': '@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)}',
    });
    assert.equal(scanTheme(dir).violations.length, 1);
  });

  it('RED: an undeclared url in a script fails', () => {
    const dir = theme({ 'assets/a.js': 'var u="https://www.facebook.com/sharer?u="' });
    const { violations } = scanTheme(dir);
    assert.equal(violations.length, 1);
    assert.match(violations[0].why, /not declared/);
  });

  it('GREEN: the same script url passes once it is declared with a reason', () => {
    const dir = theme({ 'assets/a.js': 'var u="https://www.facebook.com/sharer?u="' });
    const declared = [
      {
        files: ['assets/a.js'],
        hosts: ['www.facebook.com'],
        kind: 'navigation',
        reason: 'share link opened by click',
      },
    ];
    const result = scanTheme(dir, declared);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.unusedDeclarations, []);
  });

  it('RED: a declaration for a different file does not cover it', () => {
    const dir = theme({
      'assets/a.js': 'var u="https://www.facebook.com/x"',
      'assets/b.js': 'var v=1',
    });
    const declared = [
      {
        files: ['assets/b.js'],
        hosts: ['www.facebook.com'],
        kind: 'navigation',
        reason: 'share link opened by click',
      },
    ];
    const result = scanTheme(dir, declared);
    assert.equal(result.violations.length, 1);
    assert.equal(result.unusedDeclarations.length, 1);
  });

  it('RED: a declaration that matches nothing is stale', () => {
    const dir = theme({ 'assets/a.js': 'var v=1' });
    const declared = [
      {
        files: ['assets/a.js'],
        hosts: ['www.facebook.com'],
        kind: 'navigation',
        reason: 'share link opened by click',
      },
    ];
    assert.equal(scanTheme(dir, declared).unusedDeclarations.length, 1);
  });

  it('GREEN: a clean theme passes', () => {
    const dir = theme({
      'default.hbs':
        '<link rel="stylesheet" href="{{asset "built/a.css"}}"><a href="https://ghost.org/">Ghost</a>',
      'assets/built/a.css': '.a{color:red}',
    });
    const result = scanTheme(dir);
    assert.deepEqual(result.violations, []);
    assert.equal(result.references.length, 1);
  });

  it('files outside the served set are not scanned', () => {
    const dir = theme({
      'package.json': '{"homepage":"https://demo.example.com"}',
      'README.md': 'https://x.example.com/y',
      'gulpfile.js': 'fetch("https://api.github.com/x")',
    });
    assert.deepEqual(scanTheme(dir).violations, []);
  });

  it('a symlink among the served files is refused; elsewhere it is not served', () => {
    assert.throws(
      () => scanTheme(theme({ 'default.hbs': 'x' }, { 'assets/leak.js': '/etc/passwd' })),
      /symlink among served theme files/
    );
    assert.deepEqual(
      scanTheme(theme({ 'default.hbs': 'x', 'AGENTS.md': 'x' }, { 'CLAUDE.md': 'AGENTS.md' }))
        .violations,
      []
    );
  });
});

describe('missingAssets', () => {
  it('RED: a template naming an asset that is not committed (a theme whose build output is missing)', () => {
    const dir = theme({
      'default.hbs': '<link rel="stylesheet" href="{{asset "built/screen.css"}}">',
    });
    assert.deepEqual(missingAssets(dir), [{ template: 'default.hbs', asset: 'built/screen.css' }]);
  });
  it('GREEN: present, with a version query, and the min file form', () => {
    const dir = theme({
      'default.hbs':
        '{{asset "built/a.css?v=1"}} {{asset "js/b.js" hasMinFile=true}} {{!-- {{asset "gone.css"}} --}}',
      'assets/built/a.css': '',
      'assets/js/b.min.js': '',
    });
    assert.deepEqual(missingAssets(dir), []);
  });
});
