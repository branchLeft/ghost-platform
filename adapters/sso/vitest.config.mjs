import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
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
