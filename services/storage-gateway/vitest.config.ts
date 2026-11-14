import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // contracts.ts holds only types and one constant list; the
      // behaviour it describes is covered where it is implemented.
      // main.ts is the process entry (signal handlers and exit codes) and
      // cannot be imported without starting the service; everything it
      // calls is covered through startGateway.
      exclude: ['src/contracts.ts', 'src/main.ts'],
      thresholds: {
        // Above 90% is non-negotiable here: this is input parsing on a
        // permission boundary, and an untested branch in the key guard is
        // the failure mode that lets one tenant read another's media.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
