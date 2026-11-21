// The bundled themes and fonts, observed in the built image: a real Ghost lists and activates
// each theme, and its rendered home page names no outside origin and links only assets that answer.
// Server-rendered, not a browser run. Run: IMAGE=ghost-platform:ci node --test themes/image/themes.image.test.mjs
// Skipped when IMAGE is unset.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { docker, pollHttp200, reservePort, runStep } from '../../test-support/image-harness.mjs';
import {
  BODY_SETTING,
  fontThemeSettings,
  HEADING_SETTING,
  REUSED_BODY_SETTING,
  REUSED_HEADING_SETTING,
} from '../fetch.mjs';
import { classifyFile, hostOf } from '../lib/origins.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'manifest.json'), 'utf8'));
// The platform's default footer credit as render-core names it for every tenant: the one
// record the footer patches' partial must carry (themes/footer-credit/README.md).
const FOOTER_CREDIT = JSON.parse(
  fs.readFileSync(
    path.join(HERE, '..', '..', 'render-core', 'test', 'golden', 'demo.ghost-settings.json'),
    'utf8'
  )
).footerCredit;
const IMAGE = process.env.IMAGE;
const SITE = 'http://localhost:2368';
const OWN_HOST = 'localhost';
const LABEL = 'branchleft.component=themes-image-test';
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = crypto.randomBytes(24).toString('hex');

// Ghost's seeded sample posts and the default publication cover point at images on
// this host: the fixture's content, not the theme's, so they are not counted.
const FIXTURE_HOSTS = new Set(['static.ghost.org']);

// Outside origins a rendered page loads, as [{url, host, class}]: a script,
// stylesheet, image, frame or font fetched without a click. Links, comments and
// metadata that merely name an origin are the static scan's business
// (origins.mjs), which reads the theme's sources.
export function outsideReferences(html) {
  return classifyFile('page.html', html)
    .filter((r) => r.class === 'load')
    .map((r) => ({ ...r, host: hostOf(r.url.startsWith('//') ? `https:${r.url}` : r.url) }))
    .filter((r) => r.host !== OWN_HOST && !FIXTURE_HOSTS.has(r.host));
}

// The theme's own stylesheet and script URLs a page links (those under
// /assets/), for the 200 check. The widget bundles under /bl-assets/ are served
// by the platform's edge, not by Ghost, and are not the theme's.
export function linkedAssets(html) {
  const found = [];
  for (const m of html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)) {
    const href = /\bhref=["']([^"']+)["']/i.exec(m[0]);
    if (href) found.push(href[1]);
  }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) found.push(m[1]);
  return found.filter((u) => u.replace(SITE, '').startsWith('/assets/'));
}

// Ghost's own credit links ghost.org ("Powered by Ghost", or "Published with Ghost" in Starter).
const GHOST_CREDIT = /<a\b[^>]*\bhref=["']https:\/\/ghost\.org\/?["'][^>]*>[^<]*<\/a>/gi;
const PLATFORM_CREDIT =
  /<span class="platform-footer-credit"><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/span>/g;

// The footer credits on a rendered page, in page order: Ghost's own and the platform's.
export function footerCredits(html) {
  const ghost = [...html.matchAll(GHOST_CREDIT)].map((m) => m.index);
  const platform = [...html.matchAll(PLATFORM_CREDIT)].map((m) => ({
    index: m.index,
    url: m[1],
    text: m[2],
  }));
  return { ghost, platform };
}

// A page that carries Ghost's credit carries the platform's beside it, after it, as often.
export function assertCreditsBesideEachOther(label, html, { required }) {
  const { ghost, platform } = footerCredits(html);
  if (required) assert.ok(ghost.length > 0, `${label}: Ghost's own credit is not on the page`);
  assert.equal(platform.length, ghost.length, `${label}: a platform credit for each Ghost credit`);
  platform.forEach((credit, i) => {
    assert.equal(credit.text, FOOTER_CREDIT.text, `${label}: credit text`);
    assert.equal(credit.url, FOOTER_CREDIT.url, `${label}: credit link`);
    assert.ok(credit.index > ghost[i], `${label}: the platform's credit follows Ghost's`);
    const between = html.slice(ghost[i], credit.index);
    assert.ok(between.length < 400, `${label}: the credits are not side by side`);
  });
}

describe('the control: the footer credit check fails when either credit is missing', () => {
  const ghostOnly = `<footer><a href="https://ghost.org/" target="_blank" rel="noopener">Ghost</a></footer>`;
  const both = `<footer><a href="https://ghost.org/">Ghost</a>
    <span class="platform-footer-credit"><a href="${FOOTER_CREDIT.url}" rel="noopener">${FOOTER_CREDIT.text}</a></span></footer>`;
  it("fails a page with Ghost's credit alone", () => {
    assert.throws(() => assertCreditsBesideEachOther('ghost only', ghostOnly, { required: true }));
  });
  it('fails a page with the platform credit alone', () => {
    const platformOnly = both.replace(/<a href="https:\/\/ghost\.org\/">Ghost<\/a>/, '');
    assert.throws(() =>
      assertCreditsBesideEachOther('platform only', platformOnly, { required: true })
    );
  });
  it("fails a page that puts the platform credit before Ghost's", () => {
    const swapped = `<footer>${both.match(/<span.*<\/span>/s)[0]}<a href="https://ghost.org/">Ghost</a></footer>`;
    assert.throws(() => assertCreditsBesideEachOther('swapped', swapped, { required: true }));
  });
  it('passes a page with both, in order', () => {
    assertCreditsBesideEachOther('both', both, { required: true });
  });
});

describe('the control: the rendered-page check fails on an outside origin', () => {
  it('flags a font stylesheet and a script from another origin', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      <script src="//code.jquery.com/jquery-3.5.1.min.js"></script>
      <link rel="stylesheet" href="${SITE}/assets/built/screen.css">
      <a href="${SITE}/about/">about</a></head></html>`;
    const hosts = outsideReferences(html).map((r) => r.host);
    assert.deepEqual(hosts.sort(), ['code.jquery.com', 'fonts.googleapis.com']);
  });

  it('passes a page that only names its own origin', () => {
    const html = `<link rel="stylesheet" href="${SITE}/assets/built/screen.css"><script src="${SITE}/assets/a.js"></script>`;
    assert.deepEqual(outsideReferences(html), []);
  });
});

// Source ships nineteen theme settings of its own, so it offers the families through
// its title and body font settings and not through two more (fetch.mjs).
const REUSES_OWN_FONT_SETTINGS = new Set(['source']);

describe('the built image', { skip: IMAGE ? false : 'IMAGE is not set' }, () => {
  let name;
  let base;
  let cookie;

  const admin = async (method, endpoint, payload) => {
    const res = await fetch(`${base}/ghost/api/admin/${endpoint}`, {
      method,
      headers: { origin: SITE, cookie, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  before(async () => {
    await runStep(
      'start Ghost from the image',
      async () => {
        const port = await reservePort();
        name = `themes-image-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const env = {
          url: SITE,
          database__client: 'sqlite3',
          database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
          privacy__useUpdateCheck: 'false',
          mail__transport: 'stub',
          BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
          // The platform serves the widgets from its own origin (widgets/pins.json);
          // pointing the same keys at this origin keeps their URLs out of the pages.
          portal__url: `${SITE}/bl-assets/portal.min.js`,
          sodoSearch__url: `${SITE}/bl-assets/sodo-search.min.js`,
          announcementBar__url: `${SITE}/bl-assets/announcement-bar.min.js`,
          sodoSearch__styles: `${SITE}/bl-assets/sodo-search.min.css`,
          adminToolbar__url: `${SITE}/bl-assets/admin-toolbar.min.js`,
          comments__url: `${SITE}/bl-assets/comments-ui.min.js`,
          signupForm__url: `${SITE}/bl-assets/signup-form.min.js`,
        };
        for (const feature of ['images', 'media', 'files']) {
          const wraps = {
            images: 'LocalImagesStorage',
            media: 'LocalMediaStorage',
            files: 'LocalFilesStorage',
          }[feature];
          env[`storage__${feature}__adapter`] = 'ScanningStorageAdapter';
          env[`storage__${feature}__wraps`] = wraps;
          env[`storage__${feature}__quarantinePath`] = '/var/lib/ghost/content/quarantine';
        }
        const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        docker(
          'run',
          '-d',
          '--name',
          name,
          '--label',
          LABEL,
          '-p',
          `127.0.0.1:${port}:2368`,
          ...envArgs,
          IMAGE
        );
        base = `http://localhost:${port}`;
        const up = await pollHttp200(`${base}/`, { containerName: name, deadlineMs: 120_000 });
        assert.ok(up.ok, `Ghost did not boot: ${up.detail}\n${docker('logs', name)}`);

        const setup = await fetch(`${base}/ghost/api/admin/authentication/setup/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: SITE },
          body: JSON.stringify({
            setup: [
              { name: 'Owner', email: OWNER_EMAIL, password: OWNER_PASSWORD, blogTitle: 'Site' },
            ],
          }),
        });
        assert.equal(setup.status, 201, await setup.text());
        const login = await fetch(`${base}/ghost/api/admin/session/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: SITE },
          body: JSON.stringify({ username: OWNER_EMAIL, password: OWNER_PASSWORD }),
        });
        assert.equal(login.status, 201, await login.text());
        cookie = login.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ');
      },
      { deadlineMs: 240_000 }
    );
  });

  after(() => {
    if (name) {
      try {
        docker('rm', '-f', '-v', name);
      } catch {
        // already gone
      }
    }
  });

  it('lists exactly the manifest themes', async () => {
    const res = await admin('GET', 'themes/');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const listed = res.body.themes.map((t) => t.name).sort();
    assert.deepEqual(listed, MANIFEST.themes.map((t) => t.name).sort());
  });

  for (const theme of MANIFEST.themes) {
    it(
      `${theme.name}: activates, renders with no outside origin, links only assets that answer`,
      { timeout: 90_000 },
      async () => {
        const activate = await admin('PUT', `themes/${theme.name}/activate/`);
        assert.equal(activate.status, 200, JSON.stringify(activate.body));

        const home = await fetch(`${base}/`);
        assert.equal(home.status, 200);
        const html = await home.text();

        const outside = outsideReferences(html);
        assert.deepEqual(
          outside.map((r) => r.url),
          [],
          `${theme.name} home page names an outside origin`
        );
        assert.ok(
          !html.includes('platform-fonts'),
          `${theme.name}: on Theme default the page must not link the fonts stylesheet`
        );

        // Ghost's own credit stays and the platform's default credit sits beside it, on the
        // home page and on the theme's error page (Starter keeps its credit in both templates).
        assertCreditsBesideEachOther(`${theme.name} home page`, html, { required: true });
        const missing = await fetch(`${base}/no-such-page-for-the-footer-credit/`);
        assert.equal(missing.status, 404);
        assertCreditsBesideEachOther(`${theme.name} error page`, await missing.text(), {
          required: false,
        });

        const assets = linkedAssets(html);
        assert.ok(
          assets.length > 0,
          `${theme.name} links no stylesheet or script: the check would prove nothing`
        );
        for (const url of assets) {
          const target = url.startsWith('/') ? `${base}${url}` : url.replace(SITE, base);
          const res = await fetch(target);
          assert.equal(res.status, 200, `${theme.name}: ${url} answered ${res.status}`);
          await res.arrayBuffer();
        }

        // The font choice: the theme offers both settings, Theme default is where it
        // starts, and choosing Space Grotesk for headings sets Ghost's variable and
        // links the stylesheet from this origin, with still no outside origin.
        const listed = await admin('GET', 'custom_theme_settings/');
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        const settingOf = (key) => listed.body.custom_theme_settings.find((s) => s.key === key);
        const families = MANIFEST.fonts.map((f) => f.family);
        const [headingKey, bodyKey] = REUSES_OWN_FONT_SETTINGS.has(theme.name)
          ? [REUSED_HEADING_SETTING, REUSED_BODY_SETTING]
          : [HEADING_SETTING, BODY_SETTING];
        for (const key of [headingKey, bodyKey]) {
          const found = settingOf(key);
          assert.ok(found, `${theme.name}: setting ${key} is not offered`);
          assert.deepEqual(found.options.slice(-families.length), families);
          if (!REUSES_OWN_FONT_SETTINGS.has(theme.name)) {
            assert.deepEqual(found.options, fontThemeSettings(MANIFEST)[key].options);
            assert.equal(
              found.value,
              'Theme default',
              `${theme.name}: ${key} must start on default`
            );
          }
        }
        const defaults = [settingOf(headingKey).default, settingOf(bodyKey).default];
        const choose = async (heading, body) => {
          const put = await admin('PUT', 'custom_theme_settings/', {
            custom_theme_settings: [
              { key: headingKey, value: heading },
              { key: bodyKey, value: body },
            ],
          });
          assert.equal(put.status, 200, JSON.stringify(put.body));
          const page = await (await fetch(`${base}/`)).text();
          assert.deepEqual(
            outsideReferences(page).map((r) => r.url),
            [],
            `${theme.name}: a chosen font names an outside origin`
          );
          return page;
        };
        const chosen = await choose('Space Grotesk', 'Inter');
        assert.ok(
          chosen.includes('--gh-font-heading:"Space Grotesk",sans-serif'),
          `${theme.name}: the heading font variable is not set`
        );
        assert.ok(
          chosen.includes('--gh-font-body:"Inter",sans-serif'),
          `${theme.name}: the body font variable is not set`
        );
        const fontsLink = linkedAssets(chosen).find((u) => u.includes('/assets/platform-fonts/'));
        assert.ok(fontsLink, `${theme.name}: a chosen font must link platform-fonts/fonts.css`);
        const linked = await fetch(
          fontsLink.startsWith('/') ? `${base}${fontsLink}` : fontsLink.replace(SITE, base)
        );
        assert.equal(linked.status, 200, `${theme.name}: ${fontsLink} answered ${linked.status}`);
        const bodyOnly = await choose(defaults[0], 'Lora');
        assert.ok(bodyOnly.includes('--gh-font-body:"Lora",serif'));
        assert.ok(
          !bodyOnly.includes('--gh-font-heading'),
          `${theme.name}: heading must stay default`
        );
        const reset = await choose(...defaults);
        assert.ok(!reset.includes('platform-fonts'), `${theme.name}: default must link nothing`);

        // The fonts: the stylesheet and every font file, from this origin, under
        // the active theme's assets.
        const css = await fetch(`${base}/assets/platform-fonts/fonts.css`);
        assert.equal(css.status, 200, `${theme.name}: fonts.css answered ${css.status}`);
        for (const f of MANIFEST.fonts) {
          for (const file of f.files) {
            const res = await fetch(`${base}/assets/platform-fonts/${f.dir}/${file.to}`);
            assert.equal(
              res.status,
              200,
              `${theme.name}: ${f.dir}/${file.to} answered ${res.status}`
            );
            const bytes = Buffer.from(await res.arrayBuffer());
            assert.equal(
              crypto.createHash('sha256').update(bytes).digest('hex'),
              file.sha256,
              `${f.dir}/${file.to} bytes differ from the pin`
            );
          }
        }
        for (const f of MANIFEST.embeddedFontFamilies) {
          const licence = `${base}/assets/platform-fonts/embedded/${f.dir}/${f.licence.file}`;
          const res = await fetch(licence);
          assert.equal(res.status, 200, `${theme.name}: ${f.dir} licence answered ${res.status}`);
          const bytes = Buffer.from(await res.arrayBuffer());
          assert.equal(
            crypto.createHash('sha256').update(bytes).digest('hex'),
            f.licence.sha256,
            `${f.dir} licence bytes differ from the pin`
          );
        }
      }
    );
  }
});
