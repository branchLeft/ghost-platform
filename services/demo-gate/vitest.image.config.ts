import { defineConfig } from 'vitest/config';

// The arrival against a real Ghost from the built image. Needs Docker and
// IMAGE; one file, one container, run on its own (`pnpm run test:image`).
export default defineConfig({
  test: {
    include: ['test/image/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
