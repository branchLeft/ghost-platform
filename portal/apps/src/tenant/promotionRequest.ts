import {
  createPromotionRequest,
  type PromotionTier,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import { PromotionError } from './promotionError.js';
import type { ProvisioningSettings } from './provisioningSettings.js';

/** How long the portal waits for the provisioning API before it gives up. */
export const PROVISIONING_TIMEOUT_MS = 5000;

/**
 * What the contract can answer to a promotion request that the portal shows
 * to the person instead of failing: the request is recorded (or already was),
 * the tenant has a request open for the other tier, or the demo cannot be
 * promoted now.
 */
export type PromotionOutcome = 'REQUESTED' | 'OTHER_REQUEST_OPEN' | 'NOT_PROMOTABLE';

/**
 * Asks the provisioning API, through the generated client, to record one
 * promotion request for `tenantId`. Asking again for the tier already open is
 * the contract's replay: the same 201 with the existing request, nothing new
 * created, so a double submit is `REQUESTED` both times.
 *
 * @throws {PromotionError} PROVISIONING_REFUSED, PROVISIONING_UNREACHABLE or UNEXPECTED_ANSWER.
 */
export async function requestPromotion(
  settings: ProvisioningSettings,
  tenantId: string,
  tier: PromotionTier
): Promise<PromotionOutcome> {
  const credential = settings.credentialFor(tenantId);
  // No credential was issued for this tenant: the API would refuse it, so it is not asked.
  if (credential === undefined) throw new PromotionError('PROVISIONING_REFUSED');
  let result: Awaited<ReturnType<typeof createPromotionRequest>>;
  try {
    result = await createPromotionRequest({
      baseUrl: settings.baseUrl,
      auth: () => credential,
      throwOnError: false,
      signal: AbortSignal.timeout(PROVISIONING_TIMEOUT_MS),
      path: { tenant: tenantId },
      body: { tier },
    });
  } catch (error) {
    throw new PromotionError(
      'PROVISIONING_UNREACHABLE',
      error instanceof Error ? { cause: error } : undefined
    );
  }
  // No response at all is the client's own failure: a network error or a request it could not build.
  const status = result.response?.status;
  if (status === undefined) throw new PromotionError('PROVISIONING_UNREACHABLE');
  if (status === 201) {
    const recorded = result.data;
    // The answer is for this tenant, this tier and an open request, or it is not an answer to this call.
    const ours =
      recorded !== undefined &&
      recorded.tenant_id === tenantId &&
      recorded.tier === tier &&
      recorded.state === 'pending';
    if (!ours) throw new PromotionError('UNEXPECTED_ANSWER');
    return 'REQUESTED';
  }
  if (status === 404) return 'NOT_PROMOTABLE';
  if (status === 409) {
    const code = (result.error as { code?: unknown } | undefined)?.code;
    if (code === 'request-already-open') return 'OTHER_REQUEST_OPEN';
    if (code === 'demo-not-promotable') return 'NOT_PROMOTABLE';
    throw new PromotionError('UNEXPECTED_ANSWER');
  }
  if (status === 400 || status === 401 || status === 403) {
    throw new PromotionError('PROVISIONING_REFUSED');
  }
  throw new PromotionError(status >= 500 ? 'PROVISIONING_UNREACHABLE' : 'UNEXPECTED_ANSWER');
}
