// The three services that import the tenant descriptor package take it from
// the registry by an exact published version, not from a sibling directory.
// Each check is one way that stops being true without anything failing
// loudly: a `link:` spec comes back in a merge, a lockfile keeps resolving the
// old link after the spec moved, or a build step quietly goes on building the
// sibling copy that nothing links to any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PACKAGE = '@branchleft/ghost-platform-render-core';
const CONSUMERS = ['services/broker', 'services/demo-gate', 'services/odask'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const withoutComments = (text) => text.replace(/^[ \t]*#.*$/gm, '');
const specOf = (dir) => JSON.parse(read(dir, 'package.json')).dependencies[PACKAGE];
const lacks = (text, pattern, what) => assert.ok(!pattern.test(text), what);
const tuple = (version) => version.match(SEMVER).slice(1).map(Number);

// The importer entry for the package in a pnpm lockfile: its specifier and
// the version it resolved to, or null when the lockfile names no such entry.
function lockEntry(lockText) {
  const lines = lockText.split('\n');
  const at = lines.findIndex((line) => line.trim().replace(/'/g, '') === `${PACKAGE}:`);
  if (at === -1) return null;
  const field = (name) => {
    const hit = lines.slice(at + 1, at + 3).find((line) => line.trim().startsWith(`${name}:`));
    return hit
      ? hit
          .trim()
          .slice(name.length + 1)
          .trim()
      : null;
  };
  return { specifier: field('specifier'), version: field('version') };
}

for (const dir of CONSUMERS) {
  test(`${dir} pins an exact version, never a path`, () => {
    const spec = specOf(dir);
    assert.match(spec, SEMVER, `${dir}/package.json declares ${PACKAGE} as ${spec}`);
  });

  test(`${dir} pins no version newer than the source tree's own`, () => {
    const own = tuple(JSON.parse(read('render-core', 'package.json')).version);
    const pinned = tuple(specOf(dir));
    const ahead = pinned.findIndex((part, i) => part !== own[i]);
    assert.ok(ahead === -1 || pinned[ahead] < own[ahead], `${dir} pins a version nothing built`);
  });

  test(`${dir}/pnpm-lock.yaml resolves the package to the pinned version`, () => {
    const entry = lockEntry(read(dir, 'pnpm-lock.yaml'));
    const spec = specOf(dir);
    assert.match(spec, SEMVER, `${dir}/package.json declares ${spec}, not a published version`);
    assert.deepEqual(
      entry,
      { specifier: spec, version: spec },
      `${dir}/pnpm-lock.yaml is out of step with package.json: regenerate it with ` +
        'the generate-lockfile workflow (package_dir=' +
        `${dir}), do not edit it by hand`
    );
  });
}

test('the lockfile reader tells a link from a pinned entry (control case)', () => {
  const pinned = `importers:\n  .:\n    dependencies:\n      '${PACKAGE}':\n        specifier: 0.2.0\n        version: 0.2.0\n`;
  const linked = pinned.replaceAll('0.2.0', 'link:../../render-core');
  assert.deepEqual(lockEntry(pinned), { specifier: '0.2.0', version: '0.2.0' });
  assert.deepEqual(lockEntry(linked), {
    specifier: 'link:../../render-core',
    version: 'link:../../render-core',
  });
  assert.equal(lockEntry('importers:\n  .: {}\n'), null);
});

test('the broker bundle script builds nothing outside its own directory', () => {
  const script = JSON.parse(read('services/broker', 'package.json')).scripts.bundle;
  lacks(script, /render-core/, `bundle script is ${script}`);
  assert.match(script, /esbuild\.bundle\.mjs/);
});

const BUILD_NOTHING_ELSEWHERE = [
  'broker-ci.yml',
  'broker-release.yml',
  'broker-systemd-boot-ci.yml',
  'demo-gate-ci.yml',
  'odask-ci.yml',
];

for (const file of BUILD_NOTHING_ELSEWHERE) {
  test(`${file} does not build the sibling render-core`, () => {
    const text = withoutComments(read('.github', 'workflows', file));
    lacks(text, /working-directory: render-core/, `${file} still builds render-core`);
    lacks(text, /render-core\/\*\*/, `${file} still filters on render-core/**`);
  });
}

for (const dir of ['services/demo-gate', 'services/odask']) {
  test(`${dir} builds its image without the sibling render-core`, () => {
    for (const file of ['Dockerfile', 'Dockerfile.dockerignore']) {
      lacks(withoutComments(read(dir, file)), /render-core/, `${dir}/${file} names render-core`);
    }
  });
}

for (const file of ['demo-gate-image.yml', 'odask-image.yml']) {
  test(`${file} is not started by a change to the sibling render-core`, () => {
    lacks(withoutComments(read('.github', 'workflows', file)), /render-core\/\*\*/, file);
  });
}
