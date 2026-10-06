// The storage request contract: the real Ghost image, behind the scanning
// decorator, against a recording S3 double. Every storage request Ghost makes
// is recorded and the exact set of request shapes is asserted, so a Ghost
// version that adds or changes a shape fails here before it reaches a tenant.
// The signing gateway allows only these shapes (see the README, "Storage
// request contract").
//
//   IMAGE=ghost-platform:ci npm --prefix adapters/scanning-storage run test:image
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GhostContainer,
  RecordingDouble,
  SITE_URL,
  createNetwork,
  removeNetwork,
  sleep,
  uniqueName,
} from '../helpers/docker-ghost.mjs';

const require = createRequire(import.meta.url);
const { tinyPng } = require('../helpers/recording-s3-double.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

// Bumping Ghost fails this on purpose: the shape tests below say whether the
// new version still fits the gateway's allowlist, and this constant is then
// raised together with the docs that name the version.
const PINNED_GHOST_VERSION = '6.55.0';

// Ghost 6.55's whole storage vocabulary, in the order the gateway lists it.
const EXPECTED_SHAPES = [
  'AbortMultipartUpload',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'GetObject',
  'HeadObject',
  'PutObject',
  'UploadPart',
];

// Where each shape comes from. Asserted per scenario below, so the test names
// the caller that produced every shape.
const SCENARIOS = {
  'image upload (save, under the multipart threshold)': ['HeadObject', 'PutObject'],
  'file upload (save, at or over the multipart threshold)': [
    'CompleteMultipartUpload',
    'CreateMultipartUpload',
    'HeadObject',
    'UploadPart',
  ],
  'file upload whose part fails (save, multipart abort)': [
    'AbortMultipartUpload',
    'CreateMultipartUpload',
    'HeadObject',
    'UploadPart',
  ],
  'on-demand resized image (saveRaw from the resize middleware)': [
    'GetObject',
    'HeadObject',
    'PutObject',
  ],
  'hold release (saveRaw from the scanning decorator)': ['PutObject'],
  'admin media inliner (saveRaw)': ['HeadObject', 'PutObject'],
  'oEmbed thumbnail and icon (saveRaw)': ['PutObject'],
  'same-name media thumbnail (delete becomes an overwrite)': ['HeadObject', 'PutObject'],
};

const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const BUCKET = 'recording-double';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function shapesOf(list) {
  return [...new Set(list.map((r) => r.shape))].sort();
}

function featureEnv(feature, wrapped, double, extra = {}) {
  const base = `storage__${feature}`;
  return {
    [`${base}__adapter`]: 'ScanningStorageAdapter',
    [`${base}__wraps`]: 'S3Storage',
    [`${base}__quarantinePath`]: '/var/lib/ghost/content/quarantine',
    [`${base}__wrappedConfig__bucket`]: BUCKET,
    [`${base}__wrappedConfig__staticFileURLPrefix`]: wrapped,
    [`${base}__wrappedConfig__cdnUrl`]: `${double.s3Endpoint}/${BUCKET}`,
    [`${base}__wrappedConfig__endpoint`]: double.s3Endpoint,
    [`${base}__wrappedConfig__region`]: 'us-east-1',
    [`${base}__wrappedConfig__forcePathStyle`]: 'true',
    [`${base}__wrappedConfig__accessKeyId`]: 'contract-test',
    [`${base}__wrappedConfig__secretAccessKey`]: 'contract-test',
    [`${base}__wrappedConfig__multipartUploadThresholdBytes`]: String(MULTIPART_THRESHOLD),
    [`${base}__wrappedConfig__multipartChunkSizeBytes`]: String(MULTIPART_THRESHOLD),
    ...extra,
  };
}

describe('the storage request contract, against the real Ghost image', () => {
  const network = uniqueName('contract-net');
  const resolveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-contract-resolve-'));
  const heldPng = tinyPng(77);
  const clean = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
  let double;
  let ghost;
  const perScenario = {};

  // Runs one scenario and records the shapes its requests produced.
  async function scenario(name, run, { done } = {}) {
    const mark = await double.mark();
    await run();
    const list = await double.since(mark, { done });
    perScenario[name] = list;
    return list;
  }

  before(async () => {
    // The resolve directory is bind-mounted into a container that runs as
    // another user; 0777 lets the container write and this process clean up.
    fs.chmodSync(resolveDir, 0o777);
    createNetwork(network);
    double = await RecordingDouble.start(IMAGE, network, BUCKET);
    ghost = await GhostContainer.start(
      IMAGE,
      {
        ...featureEnv('images', 'content/images', double, {
          storage__images__unavailable: JSON.stringify([sha256Hex(heldPng)]),
          storage__images__resolvePath: '/var/lib/ghost/content/verdict-resolve',
          storage__images__holdRetryMs: '1000',
        }),
        ...featureEnv('media', 'content/media', double),
        ...featureEnv('files', 'content/files', double),
      },
      {
        network,
        volumes: [{ host: resolveDir, container: '/var/lib/ghost/content/verdict-resolve' }],
      }
    );
    assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
    await ghost.setupOwner();
    await ghost.login();
  });

  after(() => {
    if (ghost) ghost.stop();
    if (double) double.stop();
    removeNetwork(network);
    fs.rmSync(resolveDir, { recursive: true, force: true });
  });

  it('runs Ghost 6.55', () => {
    assert.equal(
      ghost.ghostVersion(),
      PINNED_GHOST_VERSION,
      'Ghost changed version: read the shape tests below, then update PINNED_GHOST_VERSION and the docs that name it'
    );
  });

  let imageUrl;

  it('image upload: a HEAD for a free name, then one PutObject', async () => {
    const name = 'image upload (save, under the multipart threshold)';
    let res;
    const list = await scenario(name, async () => {
      res = await ghost.upload('images/upload/', [
        { field: 'file', bytes: clean, type: 'image/png', filename: 'good.png' },
      ]);
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    imageUrl = res.body.images[0].url;
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
  });

  it('file upload at the threshold: multipart create, parts, complete', async () => {
    const name = 'file upload (save, at or over the multipart threshold)';
    let res;
    const list = await scenario(
      name,
      async () => {
        res = await ghost.upload('files/upload/', [
          {
            field: 'file',
            bytes: Buffer.alloc(MULTIPART_THRESHOLD + 1024, 7),
            type: 'application/pdf',
            filename: 'multipart.pdf',
          },
        ]);
      },
      { done: (l) => l.some((r) => r.shape === 'CompleteMultipartUpload') }
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
    assert.equal(
      list.filter((r) => r.shape === 'UploadPart').length,
      2,
      'a threshold-plus-1KiB file is two parts at the 5 MiB chunk size'
    );
  });

  it('file upload whose part fails: multipart abort', async () => {
    const name = 'file upload whose part fails (save, multipart abort)';
    await double.setFailParts(true);
    try {
      const list = await scenario(
        name,
        async () => {
          await ghost.upload('files/upload/', [
            {
              field: 'file',
              bytes: Buffer.alloc(MULTIPART_THRESHOLD + 1024, 9),
              type: 'application/pdf',
              filename: 'aborted.pdf',
            },
          ]);
        },
        { done: (l) => l.some((r) => r.shape === 'AbortMultipartUpload'), timeoutMs: 30_000 }
      );
      assert.deepEqual(shapesOf(list), SCENARIOS[name]);
    } finally {
      await double.setFailParts(false);
    }
  });

  it('resized image: HEAD for the variant, GET of the original, PutObject of the variant', async () => {
    const name = 'on-demand resized image (saveRaw from the resize middleware)';
    assert.ok(imageUrl, 'the image upload scenario must run first');
    const sizePath = new URL(imageUrl).pathname
      .replace(`/${BUCKET}`, '')
      .replace('/content/images/', '/content/images/size/w600/');
    let probe;
    const list = await scenario(name, async () => {
      probe = await ghost.probe(sizePath);
    });
    // With object storage Ghost's static handler redirects to the bucket's
    // public address once the variant exists. A redirect to the ORIGINAL
    // instead means the resize middleware gave up.
    assert.equal(probe.status, 301);
    assert.ok(probe.location.includes('/size/w600/'), `redirected to ${probe.location}`);
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
  });

  it('hold release: nothing is written while held, then one PutObject on a verdict', async () => {
    const name = 'hold release (saveRaw from the scanning decorator)';
    const heldMark = await double.mark();
    const res = await ghost.upload('images/upload/', [
      { field: 'file', bytes: heldPng, type: 'image/png', filename: 'held.png' },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await sleep(2500);
    assert.ok(
      !shapesOf(await double.since(heldMark)).includes('PutObject'),
      'a held upload must not be written to the bucket'
    );

    const mark = await double.mark();
    fs.writeFileSync(
      path.join(resolveDir, `${sha256Hex(heldPng)}.json`),
      JSON.stringify({ classification: 'no-known-match' })
    );
    const list = await double.since(mark, { done: (l) => l.some((r) => r.shape === 'PutObject') });
    perScenario[name] = list;
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
  });

  it('admin media inliner: HEAD for a free name, then PutObject', async () => {
    const name = 'admin media inliner (saveRaw)';
    const post = await ghost.json('POST', 'posts/', {
      posts: [{ title: 'INLINE_POST', status: 'draft', feature_image: `${SITE_URL}/favicon.ico` }],
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    let res;
    const list = await scenario(
      name,
      async () => {
        res = await ghost.json('POST', 'db/media/inline/', { domains: [SITE_URL] });
      },
      { done: (l) => l.some((r) => r.shape === 'PutObject') }
    );
    assert.ok(
      res.status < 300,
      `inline: ${res.status} ${JSON.stringify(res.body)}\n${ghost.logs().slice(-2000)}`
    );
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
  });

  it('oEmbed bookmark: PutObject for the thumbnail and for the icon', async () => {
    const name = 'oEmbed thumbnail and icon (saveRaw)';
    // A published post on Ghost's own site: its page carries the thumbnail
    // (og:image) and the icon (the site favicon), both fetched back from the
    // same host.
    const post = await ghost.json('POST', 'posts/', {
      posts: [
        {
          title: 'OEMBED_POST',
          slug: 'oembed-post',
          status: 'published',
          feature_image: `${SITE_URL}/favicon.ico`,
        },
      ],
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    let res;
    const list = await scenario(
      name,
      async () => {
        res = await ghost.get(
          `oembed/?url=${encodeURIComponent(`${SITE_URL}/oembed-post/`)}&type=bookmark`
        );
      },
      { done: (l) => l.filter((r) => r.shape === 'PutObject').length >= 2 }
    );
    assert.equal(
      res.status,
      200,
      `oembed: ${JSON.stringify(res.body)}\n${ghost.logs().slice(-2000)}`
    );
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
    assert.equal(
      list.filter((r) => r.shape === 'PutObject').length,
      2,
      'one thumbnail and one icon'
    );
  });

  it('same-name media thumbnail: HEAD, then an overwriting PUT, never a DeleteObject', async () => {
    const name = 'same-name media thumbnail (delete becomes an overwrite)';
    const media = await ghost.upload('media/upload/', [
      { field: 'file', bytes: Buffer.alloc(2048, 3), type: 'video/mp4', filename: 'clip.mp4' },
      { field: 'thumbnail', bytes: clean, type: 'image/png', filename: 'clip_thumb.png' },
    ]);
    assert.equal(media.status, 201, JSON.stringify(media.body));
    const { url: mediaUrl, thumbnail_url: thumbnailUrl } = media.body.media[0];
    const thumbName = decodeURIComponent(thumbnailUrl.split('/').pop());

    let res;
    const list = await scenario(name, async () => {
      res = await ghost.upload(
        'media/thumbnail/upload/',
        [
          { field: 'file', bytes: clean, type: 'image/png', filename: thumbName },
          { field: 'url', value: mediaUrl },
          { field: 'ref', value: 'REF' },
        ],
        { method: 'PUT' }
      );
    });
    assert.ok(res.status < 300, `thumbnail: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(shapesOf(list), SCENARIOS[name]);
  });

  it('every request in the run is one of exactly the seven shapes, signed and buffered as the gateway expects', async () => {
    const all = await double.requests();

    // The union across every caller is the contract, with nothing unexpected.
    assert.deepEqual(shapesOf(all), EXPECTED_SHAPES);
    assert.equal(
      all.filter((r) => /^(UNKNOWN|ListObjects)/.test(r.shape)).length,
      0,
      'Ghost must send no list call and nothing the double cannot classify'
    );

    // Each shape was produced by a named caller in the scenarios above.
    const producers = {};
    for (const [name, list] of Object.entries(perScenario)) {
      for (const shape of shapesOf(list)) (producers[shape] ||= []).push(name);
    }
    for (const shape of EXPECTED_SHAPES) {
      assert.ok(producers[shape]?.length, `no scenario produced ${shape}`);
    }
    console.log('shape -> callers:', JSON.stringify(producers, null, 2));
    const seen = {};
    for (const r of all) {
      const { signing } = r;
      seen[r.shape] ||= {
        requests: 0,
        authScheme: signing.authScheme,
        payloadHash: signing.payloadHash,
        crc32Header: signing.crc32Header,
        queryKeys: r.queryKeys.join('&'),
      };
      seen[r.shape].requests += 1;
    }
    console.log('shape -> observed:', JSON.stringify(seen, null, 2));

    for (const r of all) {
      const where = `${r.shape} ${r.path}`;
      assert.equal(r.signing.authScheme, 'AWS4-HMAC-SHA256', `${where}: header-signed SigV4`);
      assert.equal(r.signing.presigned, false, `${where}: never presigned`);
      assert.equal(r.signing.payloadHash, 'signed-sha256', `${where}: a signed payload hash`);
      assert.equal(r.signing.transferEncoding, null, `${where}: no chunked transfer`);
      assert.equal(r.signing.trailerHeader, null, `${where}: no trailing checksum`);
      assert.ok(
        !String(r.signing.contentEncoding || '').includes('aws-chunked'),
        `${where}: no aws-chunked streaming body`
      );
      assert.equal(
        r.signing.hasContentLength || r.bodyBytes === 0,
        true,
        `${where}: buffered body`
      );
    }
    for (const r of all.filter((x) => x.shape === 'PutObject' || x.shape === 'UploadPart')) {
      assert.equal(r.signing.crc32Header, true, `${r.shape} ${r.path}: CRC32 header on uploads`);
    }
  });
});
