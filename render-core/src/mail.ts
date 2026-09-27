/**
 * The one email address Ghost sends member mail *as* — computed once here
 * and handed to both `settings.ts` (`members_support_address`, the setting
 * Ghost's members API actually reads before it sends a magic link) and
 * `environment.ts` (`mail__from`, the config key that looks like the right
 * one and is not). The recorded trap this closes: a sender restriction
 * upstream rejects the two disagreeing as an opaque HTTP 400 on a magic
 * link, with the real error only in container output. Computing the
 * address exactly once, rather than in each renderer separately, makes the
 * two disagreeing a compile error away from possible rather than merely a
 * case a test happens to cover.
 */

import type { SendingIdentitySpec } from './descriptor.js';
import type { ZoneConfig } from './validate.js';

/**
 * The fixed local part every paying tenant sends member mail from. Not a
 * descriptor field: a tenant's own sending domain already isolates it
 * (`SendingIdentitySpec`'s own doc comment — only a demo needs a per-slot
 * local part, because every demo shares one domain). An implementation
 * choice, not a design one — "field names and the exact rendered Ghost
 * keys" are the story's own incidental mark.
 */
const TENANT_SENDING_LOCAL_PART = 'hello';

/** The domain half of the sending address: the fixed domain every demo
 * shares, or the tenant's own. */
export function sendingDomainOf(
  identity: SendingIdentitySpec,
  zones: Pick<ZoneConfig, 'demoMailDomain'>
): string {
  return identity.kind === 'demo' ? zones.demoMailDomain : identity.domain;
}

/** The full address both `settings.ts` and `environment.ts` render — see
 * the module doc comment for why this is the only place that computes it. */
export function renderSendingAddress(
  identity: SendingIdentitySpec,
  zones: Pick<ZoneConfig, 'demoMailDomain'>
): string {
  const localPart = identity.kind === 'demo' ? identity.localPart : TENANT_SENDING_LOCAL_PART;
  return `${localPart}@${sendingDomainOf(identity, zones)}`;
}
