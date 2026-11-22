import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Every file, render-core's and the portal's included, is transformed under this
// package's own tsconfig: theirs extend a private package this package cannot install.
const tsconfig = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

// The live suite: needs Chromium (`playwright install chromium`) and, against
// the local rig, Docker. Kept out of `vitest.config.ts` so `test:unit` never
// needs either. One file, one worker: the cases share a rig and run in order.
export default defineConfig({
  // `tsconfig` is read by Vite's transform but missing from its published option type.
  oxc: { tsconfig } as never,
  test: {
    include: ['test/attack/**/*.attack.ts'],
    testTimeout: 180_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
