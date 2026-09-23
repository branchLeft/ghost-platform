// Proves the drift check in scripts/verify-pins.mjs actually rejects a
// vendored file that no longer matches its pin, rather than merely
// reporting on the case where they already agree (which every run so far
// would pass even with a check that always returns green).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyPins } from './scripts/verify-pins.mjs';

const execFileAsync = promisify(execFile);
const WIDGETS_ROOT = new URL('.', import.meta.url).pathname;

test('every vendored bundle currently matches its pin (the real check)', async () => {
  const { manifest, mismatches } = await verifyPins(WIDGETS_ROOT.replace(/\/$/, ''));
  assert.equal(mismatches.length, 0, mismatches.join('\n'));
  assert.equal(manifest.bundles.length, 7, 'expected all six script bundles plus one stylesheet');

  const configKeys = manifest.bundles.map((b) => `${b.configKey}.${b.field}`).sort();
  assert.deepEqual(configKeys, [
    'adminToolbar.url',
    'announcementBar.url',
    'comments.url',
    'portal.url',
    'signupForm.url',
    'sodoSearch.styles',
    'sodoSearch.url',
  ]);
});

test('SABOTAGE: a tampered vendored file fails the digest check', async () => {
  // Copy pins.json and dist/ into a scratch directory so the sabotage
  // mutates a throwaway copy, never the committed artefacts the CI run
  // itself depends on.
  const scratch = await mkdtemp(join(tmpdir(), 'widgets-pin-sabotage-'));
  await mkdir(join(scratch, 'dist'), { recursive: true });

  const manifest = JSON.parse(await readFile(join(WIDGETS_ROOT, 'pins.json'), 'utf8'));
  await writeFile(join(scratch, 'pins.json'), JSON.stringify(manifest, null, 2));

  const target = manifest.bundles.find((b) => b.configKey === 'portal');
  for (const bundle of manifest.bundles) {
    const original = await readFile(join(WIDGETS_ROOT, bundle.vendoredFile));
    const bytes =
      bundle === target ? Buffer.concat([original, Buffer.from('\n// tampered')]) : original;
    await writeFile(join(scratch, bundle.vendoredFile), bytes);
  }

  const { mismatches } = await verifyPins(scratch);
  assert.ok(mismatches.length >= 1, 'expected the tampered bundle to be flagged');
  assert.ok(
    mismatches.every((m) => m.startsWith('portal.url:')),
    `expected only portal.url flagged, got:\n${mismatches.join('\n')}`
  );
  assert.ok(mismatches.some((m) => /digest mismatch/.test(m)));
});

test('a vendored file absent from dist/ is flagged as missing, not silently skipped', async () => {
  // A partial re-fetch or a hand-deleted file is a different failure mode
  // than a tampered byte -- verifyPins() must not treat "can't read it" as
  // "nothing to check".
  const scratch = await mkdtemp(join(tmpdir(), 'widgets-pin-missing-'));
  await mkdir(join(scratch, 'dist'), { recursive: true });

  const manifest = JSON.parse(await readFile(join(WIDGETS_ROOT, 'pins.json'), 'utf8'));
  await writeFile(join(scratch, 'pins.json'), JSON.stringify(manifest, null, 2));

  // Vendor every bundle except one, so its digest can never be read.
  const omitted = manifest.bundles.find((b) => b.configKey === 'comments');
  for (const bundle of manifest.bundles) {
    if (bundle === omitted) continue;
    const original = await readFile(join(WIDGETS_ROOT, bundle.vendoredFile));
    await writeFile(join(scratch, bundle.vendoredFile), original);
  }

  const { mismatches } = await verifyPins(scratch);
  assert.ok(
    mismatches.some((m) => m.startsWith('comments.url:') && /missing \(ENOENT\)/.test(m)),
    `expected comments.url flagged missing, got:\n${mismatches.join('\n')}`
  );
});

// The three tests below drive scripts/verify-pins.mjs as a real subprocess
// (its `main()` and CLI reporting), rather than only the exported
// `verifyPins()` function the tests above call in-process. A scratch copy of
// the whole `widgets/` tree, script included, so WIDGETS_ROOT (derived from
// the running script's own path) resolves inside the scratch dir and nothing
// here can mutate the committed pins or vendored bytes CI depends on.
async function makeScratchWidgetsCopy() {
  // realpath matters here: on macOS os.tmpdir() lives under /var, which is
  // itself a symlink to /private/var, and the CLI's own run-as-main guard
  // compares import.meta.url (which Node resolves through the symlink)
  // against process.argv[1] (which keeps whatever path it was invoked
  // with). Passing the unresolved path to execFile below would make the
  // guard see two different paths and silently skip main() -- not a bug in
  // the script, but a mismatch this harness must not introduce.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'widgets-pin-cli-')));
  await mkdir(join(scratch, 'dist'), { recursive: true });
  await mkdir(join(scratch, 'scripts'), { recursive: true });

  const manifest = JSON.parse(await readFile(join(WIDGETS_ROOT, 'pins.json'), 'utf8'));
  await writeFile(join(scratch, 'pins.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(scratch, 'scripts', 'verify-pins.mjs'),
    await readFile(join(WIDGETS_ROOT, 'scripts', 'verify-pins.mjs'))
  );
  for (const bundle of manifest.bundles) {
    await writeFile(
      join(scratch, bundle.vendoredFile),
      await readFile(join(WIDGETS_ROOT, bundle.vendoredFile))
    );
  }
  return { scratch, manifest };
}

test('CLI: exits 0 and reports OK when every bundle matches its pin', async () => {
  const { scratch } = await makeScratchWidgetsCopy();
  try {
    const { stdout } = await execFileAsync('node', [join(scratch, 'scripts', 'verify-pins.mjs')]);
    assert.match(stdout, /^OK: all 7 vendored bundles match their pinned sha384 digest\.$/m);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('SABOTAGE (CLI): exits non-zero and names every mismatch when a bundle is tampered', async () => {
  const { scratch, manifest } = await makeScratchWidgetsCopy();
  try {
    const target = manifest.bundles.find((b) => b.configKey === 'signupForm');
    const original = await readFile(join(scratch, target.vendoredFile));
    await writeFile(
      join(scratch, target.vendoredFile),
      Buffer.concat([original, Buffer.from('x')])
    );

    await assert.rejects(
      execFileAsync('node', [join(scratch, 'scripts', 'verify-pins.mjs')]),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /FAILED: \d+ of 7 pinned bundle\(s\) do not match/);
        assert.match(err.stderr, /signupForm\.url:/);
        return true;
      }
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
