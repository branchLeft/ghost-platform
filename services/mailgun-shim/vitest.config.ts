import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // server.ts is a process entrypoint (env-var wiring + app.listen) —
      // exercising it means starting a real server for no behavioural
      // coverage a unit test can't get elsewhere.
      exclude: ['src/server.ts'],
    },
  },
});
