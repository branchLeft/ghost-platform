import { defineConfig } from 'vitest/config';

// The browser journey: needs Chromium (`playwright install chromium`) and
// PORTAL_TEST_DATABASE_URL. Kept out of `vitest.config.ts` so `test:unit` and
// `coverage` never need a browser.
export default defineConfig({
  test: {
    include: ['test/journey/**/*.journey.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
