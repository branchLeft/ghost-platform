// The licence manifest. Offline: it reads themes/manifest.json and the
// Dockerfile only. The pins themselves (hashes, bytes, origins) are checked
// against the real files by verify.mjs at image build, and against a synthetic
// bundle in verify.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyPlatformFonts,
  BODY_SETTING,
  fontsCss,
  fontThemeSettings,
  HEADING_SETTING,
  platformFontsPartial,
  readManifest,
} from './fetch.mjs';
import {
  declaredReservedFontName,
  declaredReservedNames,
  EXCLUSION_REASONS,
  OPEN_LICENCES,
  screening,
  validateManifest,
} from './lib/manifest.mjs';
import { sha256File } from './lib/treehash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = readManifest();
const SNAPSHOT = JSON.parse(
  fs.readFileSync(path.join(HERE, 'org-theme-repos.snapshot.json'), 'utf8')
);
const clone = () => structuredClone(REAL);

describe('the committed manifest', () => {
  it('is well formed', () => {
    assert.deepEqual(validateManifest(REAL), []);
  });

  it('pins the same Ghost version as the Dockerfile', () => {
    const dockerfile = fs.readFileSync(path.join(HERE, '..', 'Dockerfile'), 'utf8');
    const from = /^FROM ghost:(\d+\.\d+\.\d+)-alpine@sha256:[0-9a-f]{64}$/m.exec(dockerfile);
    assert.ok(from, 'the Dockerfile has no digest-pinned ghost FROM line');
    assert.equal(REAL.ghost, from[1]);
  });

  it('bundles the Ghost-authored open-source themes and the ruled font set', () => {
    const names = REAL.themes.map((t) => t.name);
    for (const wanted of [
      'casper',
      'source',
      'london',
      'ruby',
      'edition',
      'digest',
      'bulletin',
      'journal',
      'headline',
      'solo',
      'episode',
      'starter',
    ]) {
      assert.ok(names.includes(wanted), `${wanted} is missing`);
    }
    const families = REAL.fonts.map((f) => f.family);
    for (const wanted of [
      'Inter',
      'Lora',
      'EB Garamond',
      'Mulish',
      'JetBrains Mono',
      'Source Serif 4',
      'IBM Plex Sans',
      'IBM Plex Serif',
      'IBM Plex Mono',
      'Space Grotesk',
    ]) {
      assert.ok(families.includes(wanted), `${wanted} is missing`);
    }
  });

  it('records every theme under an open licence with its licence file and copyright', () => {
    for (const t of [...REAL.themes, ...REAL.fonts]) {
      assert.ok(OPEN_LICENCES.includes(t.licence.spdx), `${t.name ?? t.family}: ${t.licence.spdx}`);
      assert.match(t.licence.copyright, /copyright/i);
      assert.match(t.licence.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it('lists every excluded theme with a reason from the closed set', () => {
    assert.ok(REAL.excluded.length > 0);
    for (const e of REAL.excluded) assert.ok(EXCLUSION_REASONS.includes(e.reason), e.name);
    for (const wanted of ['dawn', 'ease']) {
      assert.ok(
        REAL.excluded.some((e) => e.name === wanted && e.reason === 'outside-origin-at-runtime'),
        wanted
      );
    }
  });

  it('screens every theme repository in the committed snapshot of the organisation', () => {
    assert.deepEqual(screening(REAL, SNAPSHOT), { unscreened: [], unknown: [] });
  });

  it('excludes the jQuery-from-a-CDN themes Pico and Wave-Archive', () => {
    for (const wanted of ['pico', 'wave-archive']) {
      assert.ok(
        REAL.excluded.some((e) => e.name === wanted && e.reason === 'outside-origin-at-runtime'),
        wanted
      );
    }
  });

  it('records the licence text of every embedded font family, as pinned', () => {
    for (const f of REAL.embeddedFontFamilies) {
      const file = path.join(HERE, 'licences', f.dir, f.licence.file);
      assert.equal(sha256File(file), f.licence.sha256, `${f.family} licence differs from its pin`);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes(f.licence.copyright), `${f.family}: copyright line not in licence`);
      assert.deepEqual(
        declaredReservedNames(text).sort(),
        [...f.reservedFontNames].sort(),
        `${f.family}: reserved font names differ from the licence`
      );
    }
  });

  it('serves fonts only as relative same-origin files', () => {
    const css = fontsCss(REAL);
    assert.ok(!/:\/\/|url\("\//.test(css), 'fonts.css must hold relative URLs only');
    assert.equal(
      (css.match(/@font-face/g) ?? []).length,
      REAL.fonts.reduce((n, f) => n + f.files.length, 0)
    );
  });
});

describe('the font a tenant can choose', () => {
  it('offers Space Grotesk under OFL-1.1 with its licence text pinned and no reserved name', () => {
    const f = REAL.fonts.find((x) => x.family === 'Space Grotesk');
    assert.ok(f, 'Space Grotesk is missing');
    assert.equal(f.licence.spdx, 'OFL-1.1');
    assert.equal(f.reservedFontName, null);
    assert.match(f.licence.copyright, /Space Grotesk Project Authors/);
  });

  it('offers every bundled family, and "Theme default" first, for both roles', () => {
    const settings = fontThemeSettings(REAL);
    const families = REAL.fonts.map((f) => f.family);
    for (const key of [HEADING_SETTING, BODY_SETTING]) {
      assert.equal(settings[key].type, 'select');
      assert.equal(settings[key].default, 'Theme default');
      assert.deepEqual(settings[key].options, ['Theme default', ...families]);
    }
  });

  it('writes a link and a variable for every family, in both roles, and no outside origin', () => {
    const partial = platformFontsPartial(REAL);
    for (const f of REAL.fonts) {
      for (const [setting, variable] of [
        [HEADING_SETTING, '--gh-font-heading'],
        [BODY_SETTING, '--gh-font-body'],
      ]) {
        assert.ok(
          partial.includes(`match @custom.${setting} "=" "${f.family}"}}<link `),
          `${f.family}: no ${setting} link`
        );
        assert.ok(
          partial.includes(`<style>:root{${variable}:"${f.family}",${f.fallback}}`),
          `${f.family}: no ${variable} rule`
        );
      }
    }
    assert.ok(!/https?:\/\/|\/\//.test(partial), 'the partial must name no origin');
    assert.ok(partial.includes('{{asset "platform-fonts/fonts.css"}}'));
  });

  it('emits nothing for any value that is not a family name', () => {
    const partial = platformFontsPartial(REAL);
    assert.ok(!partial.includes('"!="'), 'a family is chosen by equality only');
    assert.ok(!partial.includes('{{else}}'), 'no branch may render for another value');
  });

  it('refuses a family name that could break out of the partial', () => {
    for (const family of ['Evil"}}', 'A;B', 'Theme default', '', 'Two  Spaces']) {
      const m = clone();
      m.fonts[0].family = family;
      assert.match(
        validateManifest(m).join('\n'),
        /family must be letters|duplicate|family required/
      );
    }
  });

  it('refuses a font with no generic fallback', () => {
    const m = clone();
    delete m.fonts[0].fallback;
    assert.match(validateManifest(m).join('\n'), /fallback must be one of/);
  });
});

describe('applyPlatformFonts', () => {
  let dir;
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const HBS =
    '<head>\n    <link rel="stylesheet" href="{{asset "built/screen.css"}}">\n    {{ghost_head}}\n</head>\n';
  const PKG = (custom) =>
    JSON.stringify({ name: 't', config: { custom, posts_per_page: 5 } }, null, 2);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'));
    write('default.hbs', HBS);
    write('package.json', PKG({ title_font: { type: 'select', options: ['a'], default: 'a' } }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('GREEN: adds the two settings, the partial and one include after the head helper', () => {
    applyPlatformFonts(dir, REAL);
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(Object.keys(pkg.config.custom), ['title_font', HEADING_SETTING, BODY_SETTING]);
    assert.equal(pkg.config.posts_per_page, 5);
    assert.equal(read('partials/platform-fonts.hbs'), platformFontsPartial(REAL));
    assert.match(
      read('default.hbs'),
      /\n    \{\{ghost_head\}\}\n    \{\{> "platform-fonts"\}\}\n<\/head>/
    );
  });

  it('GREEN: a theme with no custom settings gets them', () => {
    write('package.json', JSON.stringify({ name: 't' }));
    applyPlatformFonts(dir, REAL);
    assert.deepEqual(Object.keys(JSON.parse(read('package.json')).config.custom), [
      HEADING_SETTING,
      BODY_SETTING,
    ]);
  });

  const unchanged = (action) => {
    const before = [read('default.hbs'), read('package.json')];
    assert.throws(action);
    assert.deepEqual([read('default.hbs'), read('package.json')], before);
    assert.ok(!fs.existsSync(path.join(dir, 'partials/platform-fonts.hbs')));
  };

  it('RED: a theme with no head helper fails and is left unchanged', () => {
    write('default.hbs', '<head></head>');
    unchanged(() => applyPlatformFonts(dir, REAL));
  });

  it('GREEN: a head helper named in a comment is not a second head helper', () => {
    write('default.hbs', `{{!-- output with {{ghost_head}} below --}}\n${HBS}`);
    applyPlatformFonts(dir, REAL);
    assert.match(read('default.hbs'), /\n    \{\{ghost_head\}\}\n    \{\{> "platform-fonts"\}\}\n/);
    assert.equal((read('default.hbs').match(/platform-fonts/g) ?? []).length, 1);
  });

  it('RED: a theme with two head helpers fails and is left unchanged', () => {
    write('default.hbs', `${HBS}{{ghost_head}}`);
    unchanged(() => applyPlatformFonts(dir, REAL));
  });

  it('RED: a theme that already has the setting fails and is left unchanged', () => {
    write(
      'package.json',
      PKG({ [HEADING_SETTING]: { type: 'select', options: ['a'], default: 'a' } })
    );
    unchanged(() => applyPlatformFonts(dir, REAL));
  });

  const crowded = (extra = {}) => {
    const custom = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`s${i}`, { type: 'boolean', default: false }])
    );
    const own = {
      type: 'select',
      options: ['Modern sans-serif', 'Elegant serif'],
      default: 'Modern sans-serif',
    };
    return { ...custom, title_font: own, body_font: own, ...extra };
  };

  it('GREEN: a theme with no room offers the families through its own title and body fonts', () => {
    write('package.json', PKG(crowded()));
    applyPlatformFonts(dir, REAL);
    const custom = JSON.parse(read('package.json')).config.custom;
    assert.equal(Object.keys(custom).length, 19);
    const families = REAL.fonts.map((f) => f.family);
    for (const key of ['title_font', 'body_font']) {
      assert.deepEqual(custom[key].options, ['Modern sans-serif', 'Elegant serif', ...families]);
      assert.equal(custom[key].default, 'Modern sans-serif');
    }
    assert.equal(
      read('partials/platform-fonts.hbs'),
      platformFontsPartial(REAL, { heading: 'title_font', body: 'body_font' })
    );
    assert.ok(!read('partials/platform-fonts.hbs').includes(HEADING_SETTING));
  });

  it('RED: a theme with no room and no title and body font selects fails, unchanged', () => {
    const custom = Object.fromEntries(
      Array.from({ length: 19 }, (_, i) => [`s${i}`, { type: 'boolean', default: false }])
    );
    write('package.json', PKG(custom));
    unchanged(() => applyPlatformFonts(dir, REAL));
  });

  it('RED: a theme with no room whose title font already offers a family fails, unchanged', () => {
    write(
      'package.json',
      PKG(crowded({ title_font: { type: 'select', options: ['Inter', 'x'], default: 'x' } }))
    );
    unchanged(() => applyPlatformFonts(dir, REAL));
  });

  it('RED: a second run fails rather than adding the include twice', () => {
    applyPlatformFonts(dir, REAL);
    assert.throws(() => applyPlatformFonts(dir, REAL), /already includes the partial/);
  });
});

describe('the licence check: red cases', () => {
  it('a theme under a licence outside the open set fails', () => {
    const m = clone();
    m.themes[2].licence.spdx = 'GPL-3.0-only';
    assert.match(validateManifest(m).join('\n'), /not in the open set/);
  });

  it('a theme with no licence record fails', () => {
    const m = clone();
    delete m.themes[3].licence;
    assert.match(validateManifest(m).join('\n'), /licence record missing/);
  });

  it('a theme with no recorded copyright line fails', () => {
    const m = clone();
    m.themes[4].licence.copyright = '';
    assert.match(validateManifest(m).join('\n'), /copyright line/);
  });

  it('a theme pinned to a branch instead of a full commit fails', () => {
    const m = clone();
    m.themes.find((t) => t.source === 'github').commit = 'main';
    assert.match(validateManifest(m).join('\n'), /full 40-hex commit/);
  });

  it('a theme with no content hash fails', () => {
    const m = clone();
    delete m.themes[2].treeSha256;
    assert.match(validateManifest(m).join('\n'), /treeSha256/);
  });

  it('a declaration of kind "load" is not declarable', () => {
    const m = clone();
    m.themes.find((t) => t.externalReferences).externalReferences[0].kind = 'load';
    assert.match(validateManifest(m).join('\n'), /never declarable/);
  });

  it('a declaration with no reason fails', () => {
    const m = clone();
    m.themes.find((t) => t.externalReferences).externalReferences[0].reason = '';
    assert.match(validateManifest(m).join('\n'), /reason of at least 10/);
  });

  it('a font under a licence other than OFL-1.1 fails', () => {
    const m = clone();
    m.fonts[0].licence.spdx = 'MIT';
    assert.match(validateManifest(m).join('\n'), /OFL-1.1 only/);
  });

  it('a reserved-name font that is marked modified fails (no subsetting, no conversion)', () => {
    const m = clone();
    const lora = m.fonts.find((f) => f.family === 'Lora');
    lora.modification = 'subset';
    assert.match(
      validateManifest(m).join('\n'),
      /reserved font name "Lora" requires modification: "none"/
    );
  });

  it('a theme both bundled and excluded fails', () => {
    const m = clone();
    m.excluded[0].name = m.themes[2].name;
    assert.match(validateManifest(m).join('\n'), /also listed as bundled/);
  });

  it('an exclusion with an unknown reason fails', () => {
    const m = clone();
    m.excluded[0].reason = 'felt like it';
    assert.match(validateManifest(m).join('\n'), /reason must be one of/);
  });
});

describe('the screening check: red cases', () => {
  it('dropping Pico from the exclusions leaves it unscreened', () => {
    const m = clone();
    m.excluded = m.excluded.filter((e) => e.name !== 'pico');
    assert.deepEqual(screening(m, SNAPSHOT), { unscreened: ['pico'], unknown: [] });
  });

  it('a theme repository added to the organisation is unscreened until listed', () => {
    const snapshot = { repos: [...SNAPSHOT.repos, 'Brand-New'] };
    assert.deepEqual(screening(REAL, snapshot).unscreened, ['brand-new']);
  });

  it('an entry for a repository absent from the snapshot is reported', () => {
    const m = clone();
    m.excluded.push({
      ...m.excluded[0],
      name: 'ghost-of-a-theme',
      upstream: 'https://github.com/X/Ghost-Of-A-Theme',
    });
    assert.deepEqual(screening(m, SNAPSHOT).unknown, ['ghost-of-a-theme']);
  });
});

describe('the embedded font records: red cases', () => {
  const themeWithFonts = (m) => m.themes.find((t) => t.embeddedFonts?.length > 0);

  it('a theme font family with no licence record fails', () => {
    const m = clone();
    themeWithFonts(m).embeddedFonts[0].family = 'Unlicensed Sans';
    assert.match(
      validateManifest(m).join('\n'),
      /Unlicensed Sans: family is not in embeddedFontFamilies/
    );
  });

  it('a family under a licence other than OFL-1.1 fails', () => {
    const m = clone();
    m.embeddedFontFamilies[0].licence.spdx = 'MIT';
    assert.match(validateManifest(m).join('\n'), /embedded fonts are carried under OFL-1.1 only/);
  });

  it('a file with no hash fails', () => {
    const m = clone();
    delete themeWithFonts(m).embeddedFonts[0].files[0].sha256;
    assert.match(validateManifest(m).join('\n'), /sha256 must be 64 hex characters/);
  });

  it('a family marked modified fails', () => {
    const m = clone();
    m.embeddedFontFamilies[0].modification = 'subset';
    assert.match(validateManifest(m).join('\n'), /modification must be "none"/);
  });

  it('a family no theme embeds fails, so records cannot rot', () => {
    const m = clone();
    m.embeddedFontFamilies.push({ ...m.embeddedFontFamilies[0], family: 'Orphan', dir: 'orphan' });
    assert.match(validateManifest(m).join('\n'), /embedded font Orphan: no theme embeds it/);
  });
});

describe('declaredReservedNames', () => {
  it('reads quoted, several, bare and no names', () => {
    assert.deepEqual(
      declaredReservedNames(
        'Copyright 2011 The Lora Project Authors, with Reserved Font Name "Lora".\n\n-----\nSIL OPEN FONT LICENSE Version 1.1'
      ),
      ['Lora']
    );
    assert.deepEqual(
      declaredReservedNames(
        'Copyright (c) 2010, ParaType Ltd.,\nwith Reserved Font Names "PT Sans", "PT Serif" and "ParaType".\n\n-----\nSIL OPEN FONT LICENSE Version 1.1'
      ),
      ['PT Sans', 'PT Serif', 'ParaType']
    );
    assert.deepEqual(
      declaredReservedNames(
        'Copyright 2012 The Libre Baskerville Project Authors with Reserved Font Name Libre Baskerville.\n\n-----\nSIL OPEN FONT LICENSE Version 1.1'
      ),
      ['Libre Baskerville']
    );
    assert.deepEqual(
      declaredReservedNames(
        'Copyright 2020 The Inter Project Authors\n\n-----\nSIL OPEN FONT LICENSE Version 1.1\n"Reserved Font Name" refers to any names'
      ),
      []
    );
  });
});

describe('declaredReservedFontName', () => {
  it('reads straight and curly quotes, and none', () => {
    assert.equal(
      declaredReservedFontName(
        'Copyright 2011 The Lora Project Authors, with Reserved Font Name "Lora".'
      ),
      'Lora'
    );
    assert.equal(
      declaredReservedFontName(
        'Copyright 2014 Adobe, with Reserved Font Name ‘Source’. All Rights Reserved.'
      ),
      'Source'
    );
    assert.equal(
      declaredReservedFontName(
        'Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThe Reserved Font Name definition is below.'
      ),
      null
    );
  });
});
