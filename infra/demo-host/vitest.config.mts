import { defineConfig } from 'vitest/config';

/** `index.guard.test.ts` makes the guard refuse on purpose, and Pulumi reports
 * each refused resource as an unhandled rejection, which that test asserts on
 * itself. Only those are let through; any other unhandled error still fails. */
const GUARD_REFUSAL = 'hcloud:token addresses another project, not demos';

export default defineConfig({
  test: {
    onUnhandledError(error) {
      const fromGuardTest = String(
        (error as { VITEST_TEST_PATH?: string }).VITEST_TEST_PATH ?? ''
      ).endsWith('index.guard.test.ts');
      return !(fromGuardTest && String(error.message ?? '').includes(GUARD_REFUSAL));
    },
  },
});
