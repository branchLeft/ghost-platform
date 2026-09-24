import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // server.ts is a process entrypoint (env-var wiring + app.listen) --
      // exercising it means starting a real server for no behavioural
      // coverage a unit test can't get elsewhere.
      exclude: ['src/server.ts'],
      thresholds: {
        // Above 90% is non-negotiable per CLAUDE.md's risk tier for this
        // component (admission control and input parsing): a certificate
        // for a hostname nobody owns is the failure mode an untested branch
        // in the served-set check or the domain parser would produce.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
