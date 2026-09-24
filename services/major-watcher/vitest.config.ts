import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Process entrypoint only: env wiring, argv parsing and process.exit.
      // Its behaviour is exercised through the exported `run()` it calls,
      // which coverage does include.
      exclude: ['src/cli.ts'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
