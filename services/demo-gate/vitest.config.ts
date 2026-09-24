import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Process entrypoints: environment wiring and listen/stdin only. The
      // live proof in scripts/test-demo-gate.sh runs both.
      exclude: ['src/server.ts', 'src/hashCli.ts'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
