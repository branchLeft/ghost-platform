// Records what the reference implementation says about each generated
// picture, into manifest.json. See README.txt for how to build the two tools.
//
//   node record-reference.mjs <pdq-ref-driver> <pdq-photo-hasher>
//
// - <pdq-ref-driver> is reference-pixels-driver.cpp built against the
//   reference's hashing core (reads "WIDTH HEIGHT CHANNELS" then raw bytes).
// - <pdq-photo-hasher> is the reference's own pdq-photo-hasher, built with
//   CImg and libjpeg/libpng. It decodes JPEG and PNG only.
//
// A JPEG or PNG is hashed by the photo hasher, whole pipeline. A GIF or WebP
// it cannot read is hashed by the core over the generator's own pixels, which
// is the same thing for these two because both are lossless and no larger
// than 512 pixels on a side.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterPictures, pictures, SEED } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_COMMIT = 'bd0108ff1745135a421856586d19d820dd62c6de';
const [coreDriver, photoHasher] = process.argv.slice(2);
if (!coreDriver || !photoHasher) {
  throw new Error('usage: node record-reference.mjs <pdq-ref-driver> <pdq-photo-hasher>');
}

function coreHash(spec) {
  const header = Buffer.from(`${spec.width} ${spec.height} ${spec.channels}\n`);
  const out = execFileSync(coreDriver, { input: Buffer.concat([header, spec.pixels]) })
    .toString()
    .trim();
  const [hex, quality] = out.split(' ');
  return { hex, quality: Number(quality) };
}

function photoHash(file) {
  const line = execFileSync(photoHasher, [file]).toString().trim().split('\n')[0];
  const m = /^([0-9a-f]{64}),(\d+),/.exec(line);
  if (!m) throw new Error(`photo hasher gave nothing for ${file}: ${line}`);
  return { hex: m[1], quality: Number(m[2]) };
}

const entries = [];
for (const spec of pictures()) {
  const file = path.join(HERE, spec.file);
  const bytes = fs.readFileSync(file);
  const ext = path.extname(spec.file).slice(1);
  const canPhoto = ext === 'jpg' || ext === 'png';
  const entry = {
    file: spec.file,
    format: ext,
    width: spec.width,
    height: spec.height,
    channels: spec.channels,
    lossless: spec.lossless,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    note: spec.note,
  };
  if (canPhoto) {
    const photo = photoHash(file);
    entry.referenceSource = 'photo-hasher';
    entry.referenceHex = photo.hex;
    entry.referenceQuality = photo.quality;
  } else {
    if (Math.max(spec.width, spec.height) > 512) {
      throw new Error(`${spec.file}: the core cannot stand in for the photo hasher over 512 px`);
    }
    const core = coreHash(spec);
    entry.referenceSource = 'core-on-generator-pixels';
    entry.referenceHex = core.hex;
    entry.referenceQuality = core.quality;
  }
  if (spec.lossless && Math.max(spec.width, spec.height) <= 512) {
    const core = coreHash(spec);
    entry.coreOnGeneratorPixelsHex = core.hex;
    entry.coreOnGeneratorPixelsQuality = core.quality;
  }
  entries.push(entry);
}

const adapter = adapterPictures().map((spec) => ({
  file: spec.file,
  sha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(HERE, '..', spec.file)))
    .digest('hex'),
  ...(() => {
    const core = coreHash(spec);
    return { referenceHex: core.hex, referenceQuality: core.quality };
  })(),
}));

fs.writeFileSync(
  path.join(HERE, 'manifest.json'),
  `${JSON.stringify(
    {
      generator: { file: 'generate.mjs', seed: SEED },
      reference: {
        repository: 'facebook/ThreatExchange',
        directory: 'pdq/',
        commit: REFERENCE_COMMIT,
      },
      pictures: entries,
      adapterPictures: adapter,
    },
    null,
    2
  )}\n`
);
console.log(`recorded ${entries.length} pictures and ${adapter.length} adapter pictures`);
