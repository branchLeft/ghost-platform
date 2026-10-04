// Test-only stand-in for the `AdminApiClient` seam (`src/adminApi.ts`).
// `standIn: true` makes `/status` list it (`src/standIns.ts`), so a host
// still running it can never pass for one ready to go live. A real install
// points `BROKER_ADMIN_API_MODULE` at a shipped module instead.
export default {
  standIn: true,
  async configure() {
    throw new Error('noop-admin-api: not implemented (proof stand-in only)');
  },
};
