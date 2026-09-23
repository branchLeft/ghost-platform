import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        // Above 90% for validate() and the invariant logic is non-negotiable
        // per CLAUDE.md's input-validation risk tier; branch coverage catches
        // an invariant's untested arm in a way line coverage alone can miss.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
