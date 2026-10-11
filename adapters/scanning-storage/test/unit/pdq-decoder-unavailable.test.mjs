import { createRequire } from 'node:module';
import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
const PNG = fsSync.readFileSync(path.join(HERE, '../fixtures/clean.png'));

// A fresh copy of the modules with `sharp` unresolvable, which is what a
// Ghost image without the decoder would look like.
function loadWithoutDecoder() {
  for (const name of ['pdq.js', 'wiring.js']) {
    delete require.cache[path.join(SRC, name)];
  }
  NodeModule._load = function patched(request, ...rest) {
    if (request === 'sharp') {
      throw new Error("Cannot find module 'sharp'");
    }
    return originalLoad.call(this, request, ...rest);
  };
  return { pdq: require('../../src/pdq.js'), wiring: require('../../src/wiring.js') };
}

afterEach(() => {
  NodeModule._load = originalLoad;
  for (const name of ['pdq.js', 'wiring.js']) {
    delete require.cache[path.join(SRC, name)];
  }
});

describe('a Ghost image without the decoder', () => {
  it('loads the module and yields no hash, so every upload is held', async () => {
    const { pdq } = loadWithoutDecoder();
    expect(await pdq.pdqHashOfImage(PNG)).toEqual({
      hash: null,
      quality: null,
      reason: pdq.REASON.DECODER_UNAVAILABLE,
    });
    expect(pdq.decoderLoadError().message).toMatch(/sharp/);
  });

  it('says so, with a stable token to alert on, at construction', () => {
    const { wiring } = loadWithoutDecoder();
    const lines = wiring.startupProblems();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PDQ_DECODER_UNAVAILABLE');
  });
});
