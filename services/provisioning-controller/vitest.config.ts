import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'contract/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'mock/**/*.ts'],
      // `src/generated` is Speckify's output, committed as generated: its own
      // tests live in Speckify, and scripts/assert-contracts-generated.py guards
      // its content. `mock/main.ts` is the process entry point (environment and
      // listen/signal handling); the mock is exercised through `createMock`.
      exclude: ['src/generated/**', 'mock/main.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
