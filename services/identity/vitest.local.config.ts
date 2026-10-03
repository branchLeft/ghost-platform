import { defineConfig } from 'vitest/config';

// The proof against real containers. Separate from the unit run: it needs
// Docker, and `local/prove.sh` supplies the instance and its credential.
export default defineConfig({
  test: {
    include: ['test-local/**/*.test.ts'],
    // Both files reconcile the same instance; run together they would race to create the same organisation.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
