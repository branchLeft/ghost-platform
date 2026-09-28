// Test-only stand-in for the `AdminApiClient` seam (`src/adminApi.ts`) so
// this proof's server can start at all. No real implementation exists
// anywhere in this repo yet -- RUNBOOK-broker-deploy.md's "Left out,
// deliberately" -- and this file is never what a real install points
// `BROKER_ADMIN_API_MODULE` at.
export default {
  async configure() {
    throw new Error('noop-admin-api: not implemented (proof stand-in only)');
  },
};
