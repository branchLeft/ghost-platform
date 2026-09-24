import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    // --expose-gc backs the memory-bound streaming test
    // (smtpFrontDoor.test.ts's "does not retain a message past its size
    // cap") — without it `global.gc` is undefined and the measurement is at
    // the mercy of GC timing rather than the code's own retention.
    execArgv: ['--expose-gc'],
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
