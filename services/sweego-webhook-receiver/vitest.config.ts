import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Builds dist/ once for the server-startup tests; see test/globalSetup.ts.
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // server.ts is a process entrypoint (env-var wiring + listen); every
      // behaviour it wires is covered through the modules it calls.
      exclude: ['src/server.ts'],
    },
  },
});
