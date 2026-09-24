#!/usr/bin/env node
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

async function main() {
  const { manifest, mismatches } = await verifyPins();

  if (mismatches.length > 0) {
    console.error(
      `FAILED: ${mismatches.length} of ${manifest.bundles.length} pinned bundle(s) do not match widgets/pins.json:\n`
    );
    for (const m of mismatches) {
      console.error(m);
    }
    process.exit(1);
  }

  console.log(
    `OK: all ${manifest.bundles.length} vendored bundles match their pinned sha384 digest.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
