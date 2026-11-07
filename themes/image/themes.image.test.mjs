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
import { classifyFile, hostOf } from '../lib/origins.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'manifest.json'), 'utf8'));
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
