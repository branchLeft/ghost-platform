#!/usr/bin/env node
// Also checks that the pins are for the Ghost release the root Dockerfile
// builds on (see verifyGhostAlignment below).
//
// Checks that every vendored bundle byte under widgets/dist/ still hashes to
// the digest recorded for it in widgets/pins.json. This is the drift check:
// pins.json is the pinned value, dist/ is what actually gets served, and the
// two are only guaranteed to agree if something checks — a vendored file can
// be hand-edited, replaced, or partially re-fetched without this failing on
// its own. Exits non-zero and names every mismatch, rather than the first.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGETS_ROOT = join(__dirname, '..');

function sha384(buf) {
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

export async function verifyPins(widgetsRoot = WIDGETS_ROOT) {
  const manifest = JSON.parse(await readFile(join(widgetsRoot, 'pins.json'), 'utf8'));
  const mismatches = [];

  for (const bundle of manifest.bundles) {
    const path = join(widgetsRoot, bundle.vendoredFile);
    let buf;
    try {
      buf = await readFile(path);
    } catch (err) {
      mismatches.push(
        `${bundle.configKey}.${bundle.field}: ${bundle.vendoredFile} missing (${err.code})`
      );
      continue;
    }

    const actual = sha384(buf);
    if (actual !== bundle.sha384) {
      mismatches.push(
        `${bundle.configKey}.${bundle.field}: ${bundle.vendoredFile} digest mismatch\n` +
          `  pinned: ${bundle.sha384}\n` +
          `  actual: ${actual}`
      );
    }
    if (buf.length !== bundle.bytes) {
      mismatches.push(
        `${bundle.configKey}.${bundle.field}: ${bundle.vendoredFile} size mismatch (pinned ${bundle.bytes}, actual ${buf.length})`
      );
    }
  }

  return { manifest, mismatches };
}

// Ghost chooses each widget's version from the `version` its own
// defaults.json carries for that release, so the pins are only the bytes the
// image would have loaded while the image and the pins name the same Ghost
// release. The digest is compared too: a tag can be re-pointed, the digest
// cannot.
const GHOST_FROM = /^FROM (ghost:(\d+\.\d+\.\d+)-alpine@sha256:[0-9a-f]{64})$/m;

export async function readDockerfileGhostImage(repoRoot = join(WIDGETS_ROOT, '..')) {
  const dockerfile = await readFile(join(repoRoot, 'Dockerfile'), 'utf8');
  const from = GHOST_FROM.exec(dockerfile);
  if (!from) {
    throw new Error(
      'the Dockerfile has no digest-pinned `FROM ghost:X.Y.Z-alpine@sha256:...` line'
    );
  }
  return { ref: from[1], version: from[2] };
}

// Returns the ways widgets/pins.json and the Dockerfile's Ghost image have
// drifted apart; an empty list means they agree.
export async function verifyGhostAlignment(widgetsRoot = WIDGETS_ROOT) {
  const manifest = JSON.parse(await readFile(join(widgetsRoot, 'pins.json'), 'utf8'));
  const image = await readDockerfileGhostImage(join(widgetsRoot, '..'));
  const drift = [];

  if (manifest.ghostVersion !== image.version) {
    drift.push(
      `widgets/pins.json ghostVersion is ${manifest.ghostVersion}, the Dockerfile builds on Ghost ${image.version}`
    );
  }
  if (manifest.sourceGhostImage !== image.ref) {
    drift.push(
      `widgets/pins.json sourceGhostImage differs from the Dockerfile base image\n` +
        `  pinned:     ${manifest.sourceGhostImage}\n` +
        `  Dockerfile: ${image.ref}`
    );
  }
  for (const bundle of manifest.bundles) {
    const range = /@~(\d+\.\d+)$/.exec(bundle.resolvedFrom);
    if (!range || !bundle.resolvedVersion?.startsWith(`${range[1]}.`)) {
      drift.push(
        `${bundle.configKey}.${bundle.field}: resolved ${bundle.resolvedVersion} is outside ${bundle.resolvedFrom}`
      );
    }
  }
  if (drift.length > 0) {
    drift.push('Re-pin with widgets/scripts/fetch-pins.mjs and commit the result.');
  }
  return drift;
}

async function main() {
  const { manifest, mismatches } = await verifyPins();
  const drift = await verifyGhostAlignment();
  let failed = false;

  if (mismatches.length > 0) {
    failed = true;
    console.error(
      `FAILED: ${mismatches.length} of ${manifest.bundles.length} pinned bundle(s) do not match widgets/pins.json:\n`
    );
    for (const m of mismatches) {
      console.error(m);
    }
  }
  if (drift.length > 0) {
    failed = true;
    console.error(`FAILED: widgets/pins.json no longer matches the image's Ghost version:\n`);
    for (const d of drift) {
      console.error(d);
    }
  }
  if (failed) {
    process.exit(1);
  }

  console.log(
    `OK: all ${manifest.bundles.length} vendored bundles match their pinned sha384 digest, and the pins are for Ghost ${manifest.ghostVersion}, the version the Dockerfile builds on.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
