// Ghost's real content-import handlers, in the built image, through the
// scanning decorator. The handlers (handlers/image.js and
// handlers/importer-content-file-handler.js) and the content-file importers
// are Ghost's own code from the image; the stores are the decorator, one per
// feature. An image, a media file and a file go through loadFile, preProcess
// and doImport, and every reference must resolve to a stored key. Usage:
//   IMAGE=ghost-platform:ci pnpm --dir adapters/scanning-storage run test:image
// What runs inside the container is helpers/importer-in-image.cjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerSync } from '../../../../test-support/image-harness.mjs';
import { mp4Bytes, pdfBytes } from '../helpers/media-bytes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');
const IN_IMAGE_SCRIPT = path.join(HERE, '..', 'helpers', 'importer-in-image.cjs');

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const QUARANTINE = '/tmp/importer-quarantine';

// One decorator per feature, over the local adapters, as the other image tests
// configure them. `tier` lets the media decorator take an mp4.
function decoratorEnv() {
  const env = {
    url: 'http://localhost:2368',
    paths__contentPath: '/tmp/importer-content',
    privacy__useUpdateCheck: 'false',
    database__client: 'sqlite3',
    database__connection__filename: '/tmp/importer.db',
    storage__media__tier: 'professional',
  };
  for (const [feature, wraps] of [
    ['images', 'LocalImagesStorage'],
    ['media', 'LocalMediaStorage'],
    ['files', 'LocalFilesStorage'],
  ]) {
    env[`storage__${feature}__adapter`] = 'ScanningStorageAdapter';
    env[`storage__${feature}__verdictSource`] = 'in-process-fake';
    env[`storage__${feature}__wraps`] = wraps;
    env[`storage__${feature}__quarantinePath`] = QUARANTINE;
  }
  return env;
}

function runInImage(fixtureDir) {
  const envArgs = Object.entries(decoratorEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const stdout = dockerSync(
    'run Ghost importer handlers in the image',
    'run',
    '--rm',
    '--user',
    'node',
    '--entrypoint',
    'node',
    ...envArgs,
    '-e',
    'FIXTURE_DIR=/fixtures',
    '-v',
    `${fixtureDir}:/fixtures:ro`,
    '-v',
    `${IN_IMAGE_SCRIPT}:/importer-in-image.cjs:ro`,
    IMAGE,
    '/importer-in-image.cjs'
  );
  const lastLine = stdout.trim().split('\n').pop();
  return JSON.parse(lastLine);
}

describe("Ghost's real content importer handlers, through the scanning decorator", () => {
  it('names and stores an image, a media file and a file, and every reference resolves to a stored key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-handlers-'));
    // Read by the image's own user, which is not this process's.
    fs.chmodSync(dir, 0o755);
    const writes = {
      'photo.png': fs.readFileSync(path.join(FIXTURES, 'clean.png')),
      'clip.mp4': mp4Bytes(),
      'report.pdf': pdfBytes(),
    };
    try {
      for (const [name, bytes] of Object.entries(writes)) {
        fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o644 });
      }

      const facts = runInImage(dir);
      assert.deepEqual(
        facts.map((f) => f.type),
        ['images', 'media', 'files']
      );

      const expected = {
        images: { prefix: 'content/images', name: /photo-[a-z2-7]{22}\.png/ },
        media: { prefix: 'content/media', name: /clip-[a-z2-7]{22}\.mp4/ },
        files: { prefix: 'content/files', name: /report-[a-z2-7]{22}\.pdf/ },
      };
      for (const fact of facts) {
        const { prefix, name } = expected[fact.type];
        const where = `${fact.type}: ${JSON.stringify(fact)}`;
        assert.equal(
          fact.storeClass,
          'ScanningStorageAdapter',
          `${where}: the store is the decorator`
        );
        assert.equal(
          fact.staticFileURLPrefix,
          prefix,
          `${where}: the decorator exposes the prefix`
        );
        assert.match(
          fact.newPath,
          new RegExp(`^/${prefix}/2019/01/${name.source}$`),
          `${where}: the handler names the file under the prefix`
        );
        assert.equal(fact.stored, fact.newPath, `${where}: the reference is the stored URL`);
        assert.ok(fact.storedFileExists, `${where}: the key is in the store`);
        assert.ok(fact.storedBytesMatch, `${where}: the stored bytes are the imported bytes`);
        assert.ok(
          fact.postMarkdown.includes(fact.newPath) && fact.postHtml.includes(fact.newPath),
          `${where}: the post's reference was rewritten to the stored key`
        );
        assert.ok(
          !fact.postMarkdown.includes(fact.originalPath),
          `${where}: no reference is left at the exported name`
        );
      }
      // Media and files go through the content-file handler class; the image
      // handler is a different module. The decorator is behind both.
      assert.equal(facts[1].handlerStoreClass, 'ScanningStorageAdapter');
      assert.equal(facts[2].handlerStoreClass, 'ScanningStorageAdapter');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
