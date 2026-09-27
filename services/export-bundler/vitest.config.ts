import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // cli.ts is a process entrypoint (argv parsing + wiring) -- exercising
      // it means running a real process for no behavioural coverage a unit
      // test can't get elsewhere.
      exclude: ['src/cli.ts'],
    },
  },
});
