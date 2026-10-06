import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'vitest';
import { referenceSign } from './support/reference-signer.js';
import { VECTOR_IDENTITY, VECTOR_SPECS } from './support/vector-specs.js';

const REFERENCE_VECTORS_PATH = new URL('./fixtures/reference-vectors.json', import.meta.url);

/**
 * Regenerates the checked-in reference vectors with the installed reference
 * signer. Runs only on request (`npm run vectors:generate`); the normal suite
 * instead re-signs every vector and fails if the file has drifted from what
 * the signer produces.
 */
it.runIf(process.env.REGENERATE_REFERENCE_VECTORS === '1')(
  'regenerates reference vectors',
  async () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@smithy/signature-v4/package.json');
    const signerVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string })
      .version;
    const vectors = [];
    for (const v of VECTOR_SPECS) {
      const signed = await referenceSign(
        v.spec,
        { ...VECTOR_IDENTITY, signingDate: new Date(VECTOR_IDENTITY.signingDate) },
        v.rawQuery
      );
      vectors.push({ name: v.name, request: signed.request });
    }
    const out = {
      signer: `@smithy/signature-v4@${signerVersion}`,
      identity: VECTOR_IDENTITY,
      vectors,
    };
    writeFileSync(REFERENCE_VECTORS_PATH, `${JSON.stringify(out, null, 2)}\n`);
  }
);
