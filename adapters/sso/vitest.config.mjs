import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // The overlay ships in the Ghost image, but it mints an Administrator
      // session on the auth path like everything else in src/**, so it holds
      // to the same floor. The pristine upstream copy is excluded: it is
      // reference data for the re-derivation diff, not code this repo runs.
      include: ['src/**/*.js', 'ghost-core-overlay/session-from-token.js'],
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
