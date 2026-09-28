/**
 * The one email address Ghost sends member mail *as*, computed once and
 * handed to both `settings.ts` and `environment.ts` so the two can never
 * disagree. See mail.md#sending-address.
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
