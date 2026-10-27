import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs'],
    // Derives ghost-core-overlay/derived/session-from-token.js: Ghost's file
    // from the pinned base image with our patch applied.
    globalSetup: ['test/unit/global-setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // The overlay ships in the Ghost image, but it mints an Administrator
      // session on the auth path like everything else in src/**, so it holds
      // to the same floor. It is measured as derived (Ghost's file plus our
      // patch), the form the image ships; the baseline copy beside it is
      // reference data, not code this repo runs.
      // The Engine client is what the grant tool uses to reach a tenant's
      // database as root on the app host, so it holds the same floor.
      include: [
        'src/**/*.js',
        'ghost-core-overlay/derived/session-from-token.js',
        'scripts/docker-engine.mjs',
      ],
      thresholds: {
        // Non-negotiable for this component: it mints an Administrator
        // session, and an untested branch in it is an untested way in.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
