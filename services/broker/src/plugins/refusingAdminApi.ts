/**
 * The `AdminApiClient` seam (`../adminApi.ts`), filled with an interim
 * refusal: every build is refused until the real client ships.
 * See refusingAdminApi.md#refusingadminapi.
 */
import type { AdminApiClient } from '../adminApi.js';

export const ADMIN_API_REFUSAL =
  'how the demo service signs in to a demo site is not built yet; every build is refused';

const adminApi: AdminApiClient = {
  configure() {
    return Promise.reject(new Error(ADMIN_API_REFUSAL));
  },
};

export default adminApi;
