// Test-only stand-in for the `AdminApiClient` seam (`src/adminApi.ts`).
// It carries no `real: true`, so `/status` lists it under `notReal`
// (`src/seamReadiness.ts`) and a host still running it cannot pass for one
// ready to go live. A real install points at a shipped module instead.
export default {
  async configure() {
    throw new Error('noop-admin-api: not implemented (proof stand-in only)');
  },
};
