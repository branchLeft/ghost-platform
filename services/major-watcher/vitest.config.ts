import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // No file-level exclusion left: src/cli.ts's main() is exercised
      // directly by test/unit/cli.test.ts, and only its process-entrypoint
      // guard (main().then(process.exit)) is v8-ignored inline.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
