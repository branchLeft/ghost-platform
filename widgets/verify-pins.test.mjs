// Proves the drift check in scripts/verify-pins.mjs actually rejects a
// vendored file that no longer matches its pin, rather than merely
// reporting on the case where they already agree (which every run so far
// would pass even with a check that always returns green).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPins } from './scripts/verify-pins.mjs';

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
