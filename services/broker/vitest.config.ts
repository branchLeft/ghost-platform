import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `contract/` holds the tests of the seam to the generated server and
    // client. They sit beside `test/`, not in it, so that tree stays exactly
    // the behaviour suite the generated code replaced the hand-written
    // router under.
    include: ['test/**/*.test.ts', 'contract/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Process entrypoint only: environment wiring, plugin loading and
      // listen/signal handling. Exercised by every other test through
      // `createBrokerHandler` directly instead. `src/generated` is Speckify's
      // output, committed as generated: its own tests live in Speckify, and
      // scripts/assert-broker-contract-generated.py guards its content.
      exclude: ['src/server.ts', 'src/generated/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
