import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Process entrypoint only: environment wiring, plugin loading and
      // listen/signal handling. Exercised by every other test through
      // `createBrokerHandler` directly instead.
      exclude: ['src/server.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
