import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // ScanningStorageAdapter.js is Ghost's boot entrypoint: it requires
      // ghost-storage-base directly, which is not installed here (Ghost's
      // own image already carries it). It is excluded from coverage for
      // that reason, not because it is untested -- the image test drives it
      // inside a real Ghost container instead.
      include: ['src/**/*.js'],
      exclude: ['src/ScanningStorageAdapter.js'],
      thresholds: {
        // Non-negotiable for this component: it is the control that stops
        // illegal material being served, and an untested branch in it is a
        // silent gap in that control.
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
