import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Three lines that only pass the process's own streams to `runCli`.
      exclude: ['src/bin.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
