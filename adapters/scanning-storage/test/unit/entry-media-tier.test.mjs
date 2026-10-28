import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { FakeWrappedAdapter } from '../helpers/fake-wrapped-adapter.mjs';
import * as bytes from '../helpers/media-bytes.mjs';

const require = createRequire(import.meta.url);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const { getProcessMetrics } = require('../../src/metrics.js');
const { PROFESSIONAL } = require('../../src/tier-policy.js');

// The entry file is loaded the way entry-verdict-source.test.mjs loads it:
// Ghost's own base class and the wrapped adapter are answered by the suite's
// doubles, and everything else is the real entry file.
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
const WRAPPED_PATH = path.join(SRC_DIR, 'FakeAdapter');
NodeModule._load = function patchedLoad(request, ...rest) {
  if (request === 'ghost-storage-base') {
    return { StorageBase: FakeStorageBase };
  }
  if (request === WRAPPED_PATH) {
    return FakeWrappedAdapter;
  }
  return originalLoad.call(this, request, ...rest);
};
afterAll(() => {
  NodeModule._load = originalLoad;
});

const EntryAdapter = require('../../src/ScanningStorageAdapter.js');

const GOLDEN_DIR = path.resolve(SRC_DIR, '../../../render-core/test/golden');
const FEATURES = ['images', 'media', 'files'];
const GOLDENS = [
  ['a demo', 'demo.compose.yml'],
  ['an entry tenant', 'entry-tenant.compose.yml'],
  ['a professional tenant', 'professional-tenant.compose.yml'],
];

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-entry-tier-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The flat storage__<feature>__<key> values one golden renders for a feature,
// as Ghost's config loader would hand them to the adapter.
async function renderedFeatureConfig(goldenName, feature) {
  const text = await fs.readFile(path.join(GOLDEN_DIR, goldenName), 'utf8');
  const pattern = new RegExp(`^\\s+storage__${feature}__([A-Za-z]+): '?([^'\\n]*)'?\\s*$`);
  const config = {};
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match && !(match[1] in config)) {
      config[match[1]] = match[2];
    }
  }
  return config;
}

function totalVerdicts() {
  return [...getProcessMetrics().verdicts.values()].reduce((sum, count) => sum + count, 0);
}

function buildFromRendered(rendered, extra = {}) {
  return new EntryAdapter({
    ...rendered,
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    holdRetryMs: 20,
    holdLogger: { error: () => {} },
    // The harness's own flag keeps the adapter otherwise live; it is never
    // part of a rendered file.
    verdictSource: 'in-process-fake',
    ...extra,
  });
}

const VIDEO_AUDIO = [
  ['MP4', () => bytes.mp4Bytes()],
  ['WebM', () => bytes.webmBytes()],
  ['Ogg', () => bytes.oggBytes()],
  ['MP3 with an ID3 tag', () => bytes.mp3WithId3Bytes()],
  ['WAV', () => bytes.wavBytes()],
  ['FLAC', () => bytes.flacBytes()],
];

describe.each(GOLDENS)('%s, as render-core renders it', (_label, golden) => {
  describe.each(FEATURES)('storage:%s', (feature) => {
    it('renders the scanning adapter and no tier key, so no rendered config can allow video or audio', async () => {
      const rendered = await renderedFeatureConfig(golden, feature);
      expect(rendered.adapter).toBe('ScanningStorageAdapter');
      expect(rendered).not.toHaveProperty('tier');
      expect(rendered).not.toHaveProperty('verdictSource');
      expect(rendered).not.toHaveProperty('allowVideoAudio');
    });

    it.each(VIDEO_AUDIO)(
      'refuses %s with a 415 and asks no verdict, as rendered',
      async (_family, build) => {
        const adapter = buildFromRendered(await renderedFeatureConfig(golden, feature));
        const verdictsBefore = totalVerdicts();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(adapter.saveRaw(build(), '2026/10/x.bin')).rejects.toMatchObject({
            statusCode: 415,
            errorType: 'UnsupportedMediaTypeError',
          });
        }
        expect(totalVerdicts()).toBe(verdictsBefore);
        expect(adapter.wrapped.savedRaw).toEqual([]);
      }
    );

    it.each(VIDEO_AUDIO)(
      'accepts %s once only the tier key is added to the rendered keys',
      async (_family, build) => {
        const rendered = await renderedFeatureConfig(golden, feature);
        const adapter = buildFromRendered({ ...rendered, tier: PROFESSIONAL });
        const verdictsBefore = totalVerdicts();
        await expect(adapter.saveRaw(build(), '2026/10/x.bin')).resolves.toEqual(
          expect.any(String)
        );
        expect(adapter.wrapped.savedRaw).toHaveLength(1);
        expect(totalVerdicts()).toBe(verdictsBefore);
      }
    );

    it('control: an image is checked and stored as rendered, with or without the tier key', async () => {
      const rendered = await renderedFeatureConfig(golden, feature);
      for (const extra of [{}, { tier: PROFESSIONAL }]) {
        const adapter = buildFromRendered({ ...rendered, ...extra });
        const verdictsBefore = totalVerdicts();
        await expect(adapter.saveRaw(bytes.pngBytes(), '2026/10/x.png')).resolves.toEqual(
          expect.any(String)
        );
        expect(adapter.wrapped.savedRaw).toHaveLength(1);
        expect(totalVerdicts()).toBe(verdictsBefore + 1);
      }
    });
  });
});

describe('the entry file reads the tier from config only', () => {
  it.each([
    undefined,
    null,
    '',
    'Professional',
    ' professional',
    'professional ',
    'entry',
    'demo',
    'hobbyist',
    true,
    1,
  ])('refuses video when tier is %j', async (tier) => {
    const adapter = buildFromRendered({}, { tier });
    await expect(adapter.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4')).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it('a feature-level allowVideoAudio value in config does not open the gate; only tier does', async () => {
    const adapter = buildFromRendered({}, { allowVideoAudio: true });
    await expect(adapter.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4')).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it('still answers 503 for a video when no verdict source is configured', async () => {
    const adapter = buildFromRendered({}, { verdictSource: undefined, tier: PROFESSIONAL });
    await expect(adapter.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4')).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
