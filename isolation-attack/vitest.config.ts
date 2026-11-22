import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Every file, render-core's and the portal's included, is transformed under this
// package's own tsconfig: theirs extend a private package this package cannot install.
const tsconfig = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

// The unit tests: verdict rules, the report, the target parameters and the edge
// rendering. No Docker and no browser.
export default defineConfig({
  // `tsconfig` is read by Vite's transform but missing from its published option type.
  oxc: { tsconfig } as never,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
